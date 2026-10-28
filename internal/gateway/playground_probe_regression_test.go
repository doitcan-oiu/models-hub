package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPlaygroundRejectsNativeChannelsBeforeForwarding(t *testing.T) {
	for _, protocol := range []string{"anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			s := testSQLiteStore(t)
			var calls atomic.Int32
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls.Add(1)
				completionEngineResponse(w)
			}))
			defer upstream.Close()
			channel := testEngineChannel("native", upstream.URL, "model", 0)
			channel.Config.Protocol = protocol
			if err := s.SaveChannel(context.Background(), channel); err != nil {
				t.Fatal(err)
			}
			h := NewHandler(s, nil, nil, HTTPConfig{AdminToken: "test-admin"})
			r := httptest.NewRequest(http.MethodPost, "/api/playground/chat", strings.NewReader(`{"mode":"channel","channelId":"native","request":{"model":"model","messages":[{"role":"user","content":"hello"}]}}`))
			r.Header.Set("Authorization", "Bearer test-admin")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "OpenAI") || calls.Load() != 0 {
				t.Fatalf("native channel was forwarded in the wrong protocol: status=%d body=%s calls=%d", w.Code, w.Body.String(), calls.Load())
			}
		})
	}
}

func TestChannelTestUsesEngineFailureWhenProbeLogCannotBeSaved(t *testing.T) {
	s := testSQLiteStore(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n")
	}))
	defer upstream.Close()
	ctx := context.Background()
	channel := testEngineChannel("truncated", upstream.URL, "model", 0)
	channel.Config.Protocol = "anthropic"
	if err := s.SaveChannelBundle(ctx, channel, []Credential{{ID: "upstream", Secret: "test-secret", Enabled: true}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DB().ExecContext(ctx, `CREATE TRIGGER reject_probe_log BEFORE INSERT ON request_logs BEGIN SELECT RAISE(FAIL, 'test log failure'); END`); err != nil {
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
	h := NewHandler(s, e, nil, HTTPConfig{AdminToken: "test-admin"})
	r := httptest.NewRequest(http.MethodPost, "/api/channels/truncated/test", strings.NewReader(`{"model":"model","stream":true}`))
	r.Header.Set("Authorization", "Bearer test-admin")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var result struct {
		Success bool   `json:"success"`
		Status  int    `json:"status"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err, w.Body.String())
	}
	if w.Code != http.StatusOK || result.Success || result.Status != http.StatusBadGateway || result.Error == "" || result.Error == "上游测试失败，请查看请求日志" {
		t.Fatalf("partial stream was reported as successful after log failure: status=%d body=%s", w.Code, w.Body.String())
	}
	var logs int
	if err := s.DB().QueryRowContext(ctx, "SELECT count(*) FROM request_logs").Scan(&logs); err != nil || logs != 0 {
		t.Fatalf("probe log unexpectedly persisted: count=%d err=%v", logs, err)
	}
}
