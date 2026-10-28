package gateway

import (
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestEngineDecodesCompressedResponsesBeforeInspection(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(map[bool]string{false: "json", true: "sse"}[stream], func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				body := `{"model":"native","choices":[{"message":{"content":"OK"}}]}`
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					body = "data: {\"model\":\"native\",\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n"
				}
				if strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
					w.Header().Set("Content-Encoding", "gzip")
					compressed := gzip.NewWriter(w)
					_, _ = io.WriteString(compressed, body)
					_ = compressed.Close()
					return
				}
				_, _ = io.WriteString(w, body)
			}))
			defer upstream.Close()
			c := testEngineChannel("a", upstream.URL, "native", 0)
			c.Config.Aliases = []ModelAlias{{From: "public", To: "native"}}
			// A configured compression header must not disable Go's automatic
			// decompression either.
			c.Config.Headers = map[string]string{"Accept-Encoding": "br, gzip"}
			s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}
			e := testEngine(t, s, EngineConfig{})
			req := testEngineRequest(context.Background(), "public", stream)
			req.Header.Set("Accept-Encoding", "br, gzip")
			rec := httptest.NewRecorder()
			e.ServeGateway(rec, req, nil, "", "api")
			if rec.Code != http.StatusOK || rec.Header().Get("Content-Encoding") != "" || !strings.Contains(rec.Body.String(), `"model":"public"`) || !strings.Contains(rec.Body.String(), "OK") {
				t.Fatalf("compressed response was not decoded and inspected: status=%d headers=%v body=%q", rec.Code, rec.Header(), rec.Body.String())
			}
		})
	}
}

func TestEngineJSONErrorEnvelopeIsFailureAndTripsCircuit(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"error":{"message":"provider failure"}}`)
	}))
	defer upstream.Close()
	settings := testEngineSettings()
	settings.RetryEnabled = false
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", upstream.URL, "test", 0)}, settings: settings}
	e := testEngine(t, s, EngineConfig{CircuitFailures: 1, CircuitCooldown: time.Minute})
	for i, status := range []int{http.StatusBadGateway, http.StatusServiceUnavailable} {
		rec := httptest.NewRecorder()
		e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
		if rec.Code != status {
			t.Fatalf("request %d returned %d, want %d: %s", i, rec.Code, status, rec.Body.String())
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("HTTP 200 error envelope did not open circuit: calls=%d", calls.Load())
	}
}

type quotaEngineStore struct {
	*engineMemoryStore
}

func (s *quotaEngineStore) ReserveChannel(_ context.Context, c Channel, tokens int64) (bool, error) {
	return max(0, tokens) <= int64(c.Config.RateLimit.TokensPerMinute), nil
}

func TestEngineTokenReservationUsesEffectivePayloadWithoutOverflow(t *testing.T) {
	for _, test := range []struct {
		name, path, body string
		overrides        map[string]any
	}{
		{"huge output", "/v1/chat/completions", `{"model":"test","max_tokens":1e100}`, nil},
		{"other output field", "/v1/responses", `{"model":"test","max_tokens":1,"max_output_tokens":100000}`, nil},
		{"channel override", "/v1/chat/completions", `{"model":"test","max_tokens":1}`, map[string]any{"max_tokens": float64(100000)}},
		{"gemini", "/v1beta/models/test:generateContent", `{"generationConfig":{"maxOutputTokens":100000}}`, nil},
		{"multiple completions", "/v1/chat/completions", `{"model":"test","max_tokens":100,"n":200}`, nil},
		{"best of completions", "/v1/chat/completions", `{"model":"test","max_tokens":100,"best_of":200}`, nil},
		{"gemini candidates", "/v1beta/models/test:generateContent", `{"generationConfig":{"maxOutputTokens":100,"candidateCount":200}}`, nil},
		{"huge candidate count", "/v1/chat/completions", `{"model":"test","max_tokens":1,"n":1e100}`, nil},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				completionEngineResponse(w)
			}))
			defer upstream.Close()
			c := testEngineChannel("a", upstream.URL, "test", 0)
			c.Config.RateLimit.TokensPerMinute = 10000
			c.Config.BodyOverrides = test.overrides
			settings := testEngineSettings()
			settings.RetryEnabled = false
			s := &quotaEngineStore{&engineMemoryStore{channels: []Channel{c}, settings: settings}}
			e := newEngine(s, EngineConfig{})
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				if err := e.Close(ctx); err != nil {
					t.Error(err)
				}
			})
			req := httptest.NewRequest(http.MethodPost, "http://gateway"+test.path, strings.NewReader(test.body))
			rec := httptest.NewRecorder()
			e.ServeGateway(rec, req, nil, "", "api")
			if rec.Code != http.StatusTooManyRequests || calls.Load() != 0 {
				t.Fatalf("token limit bypassed: status=%d upstream calls=%d body=%s", rec.Code, calls.Load(), rec.Body.String())
			}
		})
	}
}

func TestEngineGeminiStreamProbeRequestsSSE(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("alt") != "sse" {
			t.Error("Gemini stream probe omitted alt=sse")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"OK\"}]},\"finishReason\":\"STOP\"}]}\n\n")
	}))
	defer upstream.Close()
	c := testEngineChannel("gemini", upstream.URL, "test", 0)
	c.Config.Protocol = "gemini"
	s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{})
	if err := e.ProbeChannel(context.Background(), c, true); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.attempts) != 1 || s.attempts[0].TTFT == nil {
		t.Fatal("Gemini stream probe did not measure first token")
	}
}

func TestResolveUpstreamURLHonorsGeminiGenerateEndpoint(t *testing.T) {
	for _, stream := range []bool{false, true} {
		c := testEngineChannel("gemini", "https://upstream.example/tenant/v1beta", "native/model", 0)
		c.Config.Protocol = "gemini"
		c.Config.Endpoints.Generate = "/custom/{model}:generateContent"
		action := ":generateContent"
		if stream {
			action = ":streamGenerateContent"
		}
		resolved, err := ResolveUpstreamURL(c, "/v1beta/models/public"+action, "native/model", stream)
		if err != nil {
			t.Fatal(err)
		}
		target, err := url.Parse(resolved)
		if err != nil {
			t.Fatal(err)
		}
		if target.EscapedPath() != "/tenant/v1beta/custom/native%2Fmodel"+action || stream && target.Query().Get("alt") != "sse" {
			t.Fatalf("custom Gemini endpoint ignored: %s", resolved)
		}
	}
}
