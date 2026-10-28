package gateway

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

func TestStoreCacheReturnsRecoveredHealthAfterInflightInvalidation(t *testing.T) {
	s := testMemoryStore(t)
	started, release := make(chan struct{}), make(chan struct{})
	type result struct {
		value any
		err   error
	}
	results := make(chan result, 16)
	var calls atomic.Int32
	load := func() (any, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release
			return Channel{ID: "a", Status: "offline"}, nil
		}
		return Channel{ID: "a", Status: "healthy"}, nil
	}
	read := func() {
		value, err := s.cached(context.Background(), "channels", load)
		results <- result{value, err}
	}
	go read()
	<-started
	for range cap(results) - 1 {
		go read()
	}
	// A health reset commits while an earlier channel read is still in flight.
	s.InvalidateCache()
	close(release)
	for range cap(results) {
		got := <-results
		if got.err != nil {
			t.Fatal(got.err)
		}
		if channel, ok := got.value.(Channel); !ok || channel.Status != "healthy" {
			t.Fatalf("reader received the pre-reset health: %+v", got.value)
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("invalidated read and its replacement loaded %d times, want 2", got)
	}
}

func TestStoreCacheStopsInvalidationReloadWhenContextCancelled(t *testing.T) {
	s := testMemoryStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls int
	value, err := s.cached(ctx, "channels", func() (any, error) {
		calls++
		s.InvalidateCache()
		cancel()
		return "old", nil
	})
	if !errors.Is(err, context.Canceled) || value != nil || calls != 1 {
		t.Fatalf("cancelled reload returned value=%v err=%v calls=%d", value, err, calls)
	}
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	if len(s.flights) != 0 || len(s.cache) != 0 {
		t.Fatal("cancelled reload retained its flight or invalidated result")
	}
}
