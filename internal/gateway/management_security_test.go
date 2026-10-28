package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestManagementRejectsCaseInsensitiveNullFields(t *testing.T) {
	for _, profiles := range []any{
		[]any{map[string]any{"SCOPE": nil}},
		[]any{map[string]any{"Scope": "channels", "CHANNELIDS": []any{nil}}},
		[]any{map[string]any{"Mappings": []any{map[string]any{"FROM": nil, "TO": []string{"target"}}}}},
	} {
		if _, err := newAPIKey(map[string]any{"name": "Test", "profiles": profiles}, nil); err == nil {
			t.Fatalf("case-insensitive malformed profile accepted: %#v", profiles)
		}
	}
	draft := managementChannelDraft()
	draft["config"] = map[string]any{"HEADERS": map[string]any{"X-Custom": nil}}
	if _, err := newChannel(draft, nil, false); err == nil {
		t.Fatal("case-insensitive null header accepted")
	}
}

func TestLoginAttemptsLimitedByConnectionAddress(t *testing.T) {
	h := NewHandler(nil, nil, nil, HTTPConfig{AdminToken: "administrator-test-token"})
	call := func(address, forwarded string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/api/session", strings.NewReader(`{"token":"wrong"}`))
		r.RemoteAddr = address
		r.Header.Set("X-Forwarded-For", forwarded)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	for i := range loginAttemptLimit {
		if w := call(fmt.Sprintf("192.0.2.1:%d", 30000+i), ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d returned %d: %s", i, w.Code, w.Body.String())
		}
	}
	if w := call("192.0.2.1:40000", "198.51.100.2"); w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("source port/header bypassed login limit: %d %s", w.Code, w.Body.String())
	}
	if w := call("192.0.2.2:40000", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("another client was globally blocked: %d", w.Code)
	}
}

func TestLoginLimiterExpiresAndBoundsCounters(t *testing.T) {
	var limiter loginLimiter
	now := time.Now()
	for range loginAttemptLimit {
		if !limiter.allow("192.0.2.1:1", now) {
			t.Fatal("client blocked too early")
		}
	}
	if limiter.allow("192.0.2.1:2", now) {
		t.Fatal("unlimited attempts accepted")
	}
	if !limiter.allow("192.0.2.1:2", now.Add(loginAttemptWindow)) {
		t.Fatal("expired login limit did not recover")
	}
	limiter.forget("192.0.2.1:3")
	if len(limiter.clients) != 0 {
		t.Fatal("successful authentication did not clear the counter")
	}
	for i := range loginTrackedClients {
		if !limiter.allow(fmt.Sprintf("client-%d", i), now) {
			t.Fatal("client map filled before its limit")
		}
	}
	if limiter.allow("extra-client", now) || len(limiter.clients) != loginTrackedClients {
		t.Fatal("login counters exceeded their memory bound")
	}
	if !limiter.allow("extra-client", now.Add(2*loginAttemptWindow)) {
		t.Fatal("expired full client map did not recover")
	}
}

func TestBulkTagsRejectsMalformedAndOversizedMergedLists(t *testing.T) {
	s := testSQLiteStore(t)
	c := testStoredChannel("bulk-tags")
	for i := range 99 {
		c.Tags = append(c.Tags, fmt.Sprintf("tag-%d", i))
	}
	if err := s.SaveChannel(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	h := &Handler{store: s}
	for _, tags := range []any{nil, []any{nil}, []string{" "}, []string{strings.Repeat("x", 257)}, []string{"new-1", "new-2"}} {
		body, _ := json.Marshal(map[string]any{"ids": []string{c.ID}, "action": "tags", "tags": tags})
		request := httptest.NewRequest(http.MethodPost, "/api/channels/bulk", strings.NewReader(string(body)))
		err := h.bulkChannels(httptest.NewRecorder(), request)
		var coded interface{ StatusCode() int }
		if !errors.As(err, &coded) || coded.StatusCode() != http.StatusBadRequest {
			t.Fatalf("malformed/merged tag list accepted: %#v: %v", tags, err)
		}
	}
	saved, err := s.Channel(context.Background(), c.ID)
	if err != nil || len(saved.Tags) != 99 {
		t.Fatalf("rejected bulk operation modified tags: %v %v", saved.Tags, err)
	}
	e := NewEngine(s, EngineConfig{LogWorkers: 1})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	h.engine = e
	body, _ := json.Marshal(map[string]any{"ids": []string{c.ID}, "action": "tags", "tags": []string{" new ", "new"}})
	request := httptest.NewRequest(http.MethodPost, "/api/channels/bulk", strings.NewReader(string(body)))
	if err := h.bulkChannels(httptest.NewRecorder(), request); err != nil {
		t.Fatalf("normalized tag addition failed: %v", err)
	}
	saved, err = s.Channel(context.Background(), c.ID)
	if err != nil || len(saved.Tags) != 100 || saved.Tags[99] != "new" {
		t.Fatalf("bulk tags were not normalized: %v %v", saved.Tags, err)
	}
}

func TestRuntimeReportsActualDatabase(t *testing.T) {
	s := testSQLiteStore(t)
	e := NewEngine(s, EngineConfig{LogWorkers: 1})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	h := NewHandler(s, e, nil, HTTPConfig{AdminToken: "test-admin"})
	r := httptest.NewRequest(http.MethodGet, "/api/runtime", nil)
	r.Header.Set("Authorization", "Bearer test-admin")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var response map[string]any
	if json.Unmarshal(w.Body.Bytes(), &response) != nil || w.Code != http.StatusOK || response["database"] != "sqlite" {
		t.Fatalf("incorrect database type: %d %s", w.Code, w.Body.String())
	}
}
