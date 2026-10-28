package gateway

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestPortableTagAndChannelMutationLockOrdering(t *testing.T) {
	for _, database := range []struct {
		name string
		open func(*testing.T) *Store
	}{{"sqlite", testSQLiteStore}, {"pgsql", testPostgresStore}, {"mysql", testMySQLStore}} {
		t.Run(database.name, func(t *testing.T) {
			s := database.open(t)
			ctx := context.Background()
			channels := []Channel{testStoredChannel("tag-channel-a"), testStoredChannel("tag-channel-b"), testStoredChannel("tag-channel-c")}
			for index := range channels {
				channels[index].Tags = []string{"original-tag"}
				if err := s.SaveChannel(ctx, channels[index]); err != nil {
					t.Fatal(err)
				}
			}
			// Make rename wait before starting the channel save. Once this
			// transaction rolls back, both requests contend for the original
			// tag and a channel row; matching lock order must let both finish.
			held, err := s.DB().BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer held.Rollback()
			if _, err := held.ExecContext(ctx, "UPDATE tags SET name=$2 WHERE name=$1", "original-tag", "temporarily-held-tag"); err != nil {
				t.Fatal(err)
			}
			results := make(chan error, 2)
			go func() { results <- s.RenameTag(ctx, "original-tag", "renamed-tag") }()
			time.Sleep(40 * time.Millisecond)
			go func() {
				results <- s.saveManagedBundles(ctx, []managedBundle{{channel: channels[1], mustExist: true}})
			}()
			time.Sleep(40 * time.Millisecond)
			if err := held.Rollback(); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				if err := <-results; err != nil {
					t.Fatalf("tag rename/channel edit deadlocked or failed: %v", err)
				}
			}
			// Exercise both overlapping bulk channel selections and disjoint
			// selections that introduce the same new tags in opposite orders.
			for round := range 8 {
				first, second := fmt.Sprintf("round-%d-first", round), fmt.Sprintf("round-%d-second", round)
				leftIDs, rightIDs := []int{0}, []int{2}
				if round%2 == 1 {
					leftIDs, rightIDs = []int{0, 1}, []int{1, 2}
				}
				bundles := func(ids []int, tags []string) []managedBundle {
					out := make([]managedBundle, len(ids))
					for index, id := range ids {
						channel := channels[id]
						channel.Tags = tags
						out[index] = managedBundle{channel: channel, mustExist: true}
					}
					return out
				}
				start := make(chan struct{})
				var workers sync.WaitGroup
				for _, change := range [][]managedBundle{bundles(leftIDs, []string{first, second}), bundles(rightIDs, []string{second, first})} {
					workers.Add(1)
					go func(change []managedBundle) {
						defer workers.Done()
						<-start
						results <- s.saveManagedBundles(ctx, change)
					}(change)
				}
				close(start)
				workers.Wait()
				for range 2 {
					if err := <-results; err != nil {
						t.Fatalf("round %d: concurrent bulk channel/tag edit failed: %v", round, err)
					}
				}
			}
		})
	}
}
