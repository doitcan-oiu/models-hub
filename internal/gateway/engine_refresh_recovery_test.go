package gateway

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

type refreshRecoveryStore struct {
	*engineMemoryStore
	channelsRead func(context.Context) ([]Channel, error)
	settingsRead func(context.Context) (Settings, error)
}

func (s *refreshRecoveryStore) Channels(ctx context.Context) ([]Channel, error) {
	return s.channelsRead(ctx)
}

func (s *refreshRecoveryStore) Settings(ctx context.Context) (Settings, error) {
	return s.settingsRead(ctx)
}

func TestEngineRefreshSerializesReadsBeforePublishingRecoveredSnapshot(t *testing.T) {
	channelsStarted, releaseChannels := make(chan struct{}), make(chan struct{})
	settingsStarted, releaseSettings := make(chan struct{}), make(chan struct{})
	var channelsRelease, settingsRelease sync.Once
	unblockChannels := func() { channelsRelease.Do(func() { close(releaseChannels) }) }
	unblockSettings := func() { settingsRelease.Do(func() { close(releaseSettings) }) }
	t.Cleanup(unblockChannels)
	t.Cleanup(unblockSettings)
	var channelReads, settingsReads atomic.Int32
	s := &refreshRecoveryStore{engineMemoryStore: &engineMemoryStore{}}
	s.channelsRead = func(context.Context) ([]Channel, error) {
		status := "healthy"
		if channelReads.Add(1) == 1 {
			// This read began before the administrator recovered the channel.
			status = "offline"
			close(channelsStarted)
			<-releaseChannels
		}
		return []Channel{{ID: "a", Status: status}}, nil
	}
	s.settingsRead = func(context.Context) (Settings, error) {
		settings := DefaultSettings()
		if settingsReads.Add(1) == 1 {
			close(settingsStarted)
			<-releaseSettings
		} else {
			settings.Strategy = "weighted"
		}
		return settings, nil
	}
	e := &Engine{store: s}
	e.snapshot.Store(&engineSnapshot{channels: []Channel{{ID: "a", Status: "initial"}}})
	olderDone, newerDone := make(chan error, 1), make(chan error, 1)
	go func() { olderDone <- e.Refresh(context.Background()) }()
	<-channelsStarted
	// Inspect the lock while database I/O is blocked, avoiding a timing-based
	// assertion that the competing refresh has not advanced yet.
	assertRefreshLocked := func() {
		t.Helper()
		if e.refreshMu.TryLock() {
			e.refreshMu.Unlock()
			t.Fatal("refresh serialization ended before all reads and publication")
		}
	}
	assertRefreshLocked()
	newerStarted := make(chan struct{})
	go func() {
		close(newerStarted)
		newerDone <- e.Refresh(context.Background())
	}()
	<-newerStarted
	unblockChannels()
	<-settingsStarted
	assertRefreshLocked()
	if reads := channelReads.Load(); reads != 1 {
		t.Fatalf("a newer refresh overlapped the older settings read: %d channel reads", reads)
	}
	if got := e.snapshot.Load().channels[0].Status; got != "initial" {
		t.Fatalf("partially loaded snapshot became visible: %s", got)
	}
	unblockSettings()
	if err := <-olderDone; err != nil {
		t.Fatal(err)
	}
	if err := <-newerDone; err != nil {
		t.Fatal(err)
	}
	got := e.snapshot.Load()
	if got.channels[0].Status != "healthy" || got.settings.Strategy != "weighted" {
		t.Fatalf("older refresh overwrote the recovered configuration: %+v", got)
	}
	if channelReads.Load() != 2 || settingsReads.Load() != 2 {
		t.Fatalf("refreshes did not each complete one coherent load: channels=%d settings=%d", channelReads.Load(), settingsReads.Load())
	}
}

func TestEngineRefreshCancelledWhileWaitingDoesNotReadOrReplaceSnapshot(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var channelReads, settingsReads atomic.Int32
	s := &refreshRecoveryStore{engineMemoryStore: &engineMemoryStore{}}
	s.channelsRead = func(context.Context) ([]Channel, error) {
		if channelReads.Add(1) == 1 {
			close(started)
			<-release
		}
		return []Channel{{ID: "a", Status: "healthy"}}, nil
	}
	s.settingsRead = func(context.Context) (Settings, error) {
		settingsReads.Add(1)
		return DefaultSettings(), nil
	}
	e := &Engine{store: s}
	firstDone, cancelledDone := make(chan error, 1), make(chan error, 1)
	go func() { firstDone <- e.Refresh(context.Background()) }()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	waiterStarted := make(chan struct{})
	go func() {
		close(waiterStarted)
		cancelledDone <- e.Refresh(ctx)
	}()
	<-waiterStarted
	// Cancellation happens before the first refresh releases serialization.
	cancel()
	unblock()
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if err := <-cancelledDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("waiting refresh returned %v, want context.Canceled", err)
	}
	if channelReads.Load() != 1 || settingsReads.Load() != 1 {
		t.Fatalf("cancelled waiter performed configuration reads: channels=%d settings=%d", channelReads.Load(), settingsReads.Load())
	}
	if got := e.snapshot.Load(); got == nil || got.channels[0].Status != "healthy" {
		t.Fatalf("cancelled waiter altered the successful refresh: %+v", got)
	}
}
