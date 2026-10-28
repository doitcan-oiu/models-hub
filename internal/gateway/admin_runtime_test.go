package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAdminChannelsExposeLiveCircuitWithoutPersistingIt(t *testing.T) {
	s := testSQLiteStore(t)
	ctx := context.Background()
	channel := testEngineChannel("live-state", "https://example.test/v1", "model", 0)
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	e := NewEngine(s, EngineConfig{})
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.Close(closeCtx); err != nil {
			t.Error(err)
		}
	})
	runtime := e.runtime(channel)
	runtime.mu.Lock()
	runtime.active = 2
	runtime.openUntil = time.Now().Add(time.Hour)
	runtime.mu.Unlock()
	h := NewHandler(s, e, nil, HTTPConfig{AdminToken: "test-admin"})
	for _, path := range []string{"/api/bootstrap", "/api/channels", "/api/channels/live-state", "/api/dashboard"} {
		t.Run(path, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, path, nil)
			r.Header.Set("Authorization", "Bearer test-admin")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			var response struct {
				Channels []Channel `json:"channels"`
				Channel  Channel   `json:"channel"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != http.StatusOK {
				t.Fatalf("management response: status=%d body=%s err=%v", w.Code, w.Body.String(), err)
			}
			got := response.Channel
			if len(response.Channels) > 0 {
				got = response.Channels[0]
			}
			if got.ID != channel.ID || got.Status != "healthy" || got.Runtime == nil || got.Runtime.Active != 2 || got.Runtime.Limit != e.cfg.ChannelConcurrency || got.Runtime.CircuitUntil == nil {
				t.Fatalf("green stored health hides live circuit: %+v", got)
			}
		})
	}
	stored, err := s.Channels(ctx)
	if err != nil || len(stored) != 1 || stored[0].Runtime != nil {
		t.Fatalf("management decoration changed cached store snapshot: %+v err=%v", stored, err)
	}
	var raw string
	if err := s.DB().QueryRowContext(ctx, "SELECT data FROM channels WHERE id=$1", channel.ID).Scan(&raw); err != nil || strings.Contains(raw, `"runtime"`) {
		t.Fatalf("live state leaked into stored configuration: %s err=%v", raw, err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/channels/live-state/reset-health", nil)
	r.Header.Set("Authorization", "Bearer test-admin")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var reset struct {
		Channel Channel `json:"channel"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &reset); err != nil || w.Code != http.StatusOK || reset.Channel.Runtime == nil || reset.Channel.Runtime.CircuitUntil != nil || reset.Channel.Runtime.Active != 2 {
		t.Fatalf("manual health reset did not expose cleared circuit and preserved active requests: status=%d body=%s err=%v", w.Code, w.Body.String(), err)
	}
}

func TestChannelRuntimeCannotBeWrittenThroughConfiguration(t *testing.T) {
	input := map[string]any{"name": "test", "models": []string{"model"}, "endpoint": "https://example.test/v1", "runtime": map[string]any{"active": 999, "halfOpen": true}}
	channel, err := newChannel(input, nil, false)
	if err != nil || channel.Runtime != nil {
		t.Fatalf("accepted client runtime: %+v err=%v", channel, err)
	}
	channel.Runtime = &ChannelRuntimeState{Active: 2, Limit: 64, HalfOpen: true}
	updated, err := newChannel(map[string]any{"name": "updated"}, &channel, false)
	if err != nil || updated.Runtime != nil {
		t.Fatalf("retained response runtime while saving configuration: %+v err=%v", updated, err)
	}
}
