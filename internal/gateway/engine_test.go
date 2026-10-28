package gateway

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type engineMemoryStore struct {
	channels        []Channel
	settings        Settings
	credentials     []Credential
	mu              sync.Mutex
	logs            []RequestLog
	attempts        []Attempt
	blockedLog      <-chan struct{}
	consumeCalls    atomic.Int64
	credentialCalls atomic.Int64
}

func (s *engineMemoryStore) Channels(context.Context) ([]Channel, error) { return s.channels, nil }
func (s *engineMemoryStore) Settings(context.Context) (Settings, error)  { return s.settings, nil }
func (s *engineMemoryStore) Credentials(context.Context, string, bool) ([]Credential, error) {
	s.credentialCalls.Add(1)
	if s.credentials != nil {
		return s.credentials, nil
	}
	return []Credential{{ID: "cred", Secret: "upstream-secret", Enabled: true}}, nil
}
func (s *engineMemoryStore) ConsumeKey(context.Context, string, string, int64) (bool, error) {
	s.consumeCalls.Add(1)
	return true, nil
}
func (s *engineMemoryStore) ReserveChannel(context.Context, Channel, int64) (bool, error) {
	return true, nil
}
func (s *engineMemoryStore) Record(ctx context.Context, l RequestLog, a []Attempt) error {
	if s.blockedLog != nil {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-s.blockedLog:
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.logs = append(s.logs, l)
	s.attempts = append(s.attempts, a...)
	return nil
}
func (s *engineMemoryStore) UpdateHealth(context.Context, string, Health, string) error { return nil }
func testEngineChannel(id, endpoint, model string, priority int) Channel {
	return Channel{ID: id, Name: id, Endpoint: endpoint, Models: []string{model}, Model: model, Enabled: true, Status: "healthy", Priority: priority, Weight: 1, Config: DefaultChannelConfig()}
}
func testEngine(t *testing.T, s *engineMemoryStore, cfg EngineConfig) *Engine {
	t.Helper()
	e := newEngine(s, cfg)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.Close(ctx); err != nil {
			t.Errorf("close engine: %v", err)
		}
	})
	return e
}
func testEngineRequest(ctx context.Context, model string, stream bool) *http.Request {
	return httptest.NewRequest(http.MethodPost, "http://gateway/v1/chat/completions", strings.NewReader(fmt.Sprintf(`{"model":%q,"messages":[{"role":"user","content":"test"}],"stream":%t}`, model, stream))).WithContext(ctx)
}
func testEngineSettings() Settings {
	s := DefaultSettings()
	s.AutoSwitch = false
	s.MaxSameChannelRetries = 0
	s.RetryDelayMs = 0
	s.NonStreamTimeout = 2
	s.StreamFirstTokenTimeout = 1
	return s
}
func completionEngineResponse(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"model":"test","choices":[{"message":{"content":"OK"}}],"usage":{"prompt_tokens":2,"completion_tokens":3}}`)
}

func TestEngineHangingChannelDoesNotBlockOtherChannels(t *testing.T) {
	entered := make(chan struct{}, 4)
	hanging := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		entered <- struct{}{}
		<-r.Context().Done()
	}))
	defer hanging.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { completionEngineResponse(w) }))
	defer healthy.Close()
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", hanging.URL, "dead", 0), testEngineChannel("b", healthy.URL, "live", 0)}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{ChannelConcurrency: 4})
	key := &APIKey{ID: "key", Status: "active", ActiveProfile: "all", Profiles: []KeyProfile{{ID: "all", Scope: "all", ModelMode: "all"}}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var active sync.WaitGroup
	for range 4 {
		active.Add(1)
		go func() {
			defer active.Done()
			e.ServeGateway(httptest.NewRecorder(), testEngineRequest(ctx, "dead", false), key, "", "api")
		}()
	}
	for range 4 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("A requests never entered upstream")
		}
	}
	var flood sync.WaitGroup
	for range 100 {
		flood.Add(1)
		go func() {
			defer flood.Done()
			rec := httptest.NewRecorder()
			e.ServeGateway(rec, testEngineRequest(context.Background(), "dead", false), key, "", "api")
			if rec.Code != 503 {
				t.Errorf("saturated channel status=%d", rec.Code)
			}
		}()
	}
	start := time.Now()
	for range 20 {
		rec := httptest.NewRecorder()
		e.ServeGateway(rec, testEngineRequest(context.Background(), "live", false), key, "", "api")
		if rec.Code != 200 {
			t.Fatalf("healthy B unavailable: %d %s", rec.Code, rec.Body.String())
		}
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("B blocked by A: %v", elapsed)
	}
	flood.Wait()
	if s.consumeCalls.Load() != 24 || s.credentialCalls.Load() != 24 {
		t.Fatalf("nonadmitted A traffic performed database work: quota=%d credentials=%d", s.consumeCalls.Load(), s.credentialCalls.Load())
	}
	cancel()
	active.Wait()
	if got := e.runtime(s.channels[0]); func() int { got.mu.Lock(); defer got.mu.Unlock(); return got.active }() != 0 {
		t.Fatal("A capacity leaked after cancellation")
	}
}

func TestEngineFailoverAndCircuitShortCircuit(t *testing.T) {
	var failedCalls atomic.Int64
	failed := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		failedCalls.Add(1)
		w.WriteHeader(503)
		_, _ = io.WriteString(w, `{"error":{"message":"temporary"}}`)
	}))
	defer failed.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { completionEngineResponse(w) }))
	defer healthy.Close()
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", failed.URL, "test", 0), testEngineChannel("b", healthy.URL, "test", 1)}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{CircuitFailures: 2, CircuitCooldown: time.Second})
	for i := 0; i < 8; i++ {
		rec := httptest.NewRecorder()
		e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
		if rec.Code != 200 || rec.Header().Get("X-Pulsegate-Channel-Id") != "b" {
			t.Fatalf("failover failed %d %s", rec.Code, rec.Body.String())
		}
	}
	if got := failedCalls.Load(); got != 2 {
		t.Fatalf("open circuit still receiving requests: calls=%d", got)
	}
}

func TestEngineSlowLoggingCannotBlockRoutingOrReplay(t *testing.T) {
	var calls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); completionEngineResponse(w) }))
	defer upstream.Close()
	unblock := make(chan struct{})
	defer close(unblock)
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", upstream.URL, "test", 0)}, settings: testEngineSettings(), blockedLog: unblock}
	e := testEngine(t, s, EngineConfig{LogWorkers: 1, LogQueueSize: 1})
	start := time.Now()
	for range 50 {
		rec := httptest.NewRecorder()
		e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
		if rec.Code != 200 {
			t.Fatalf("status %d", rec.Code)
		}
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("logging blocked routing: %v", elapsed)
	}
	if calls.Load() != 50 {
		t.Fatalf("completed requests replayed: %d", calls.Load())
	}
	if e.DroppedLogs() == 0 {
		t.Fatal("expected bounded telemetry queue to shed logs")
	}
}

func TestEngineStreamRetriesBeforeVisibleBytes(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": keepalive\r\n\r\ndata: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"model\":\"native\",\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer good.Close()
	a := testEngineChannel("a", bad.URL, "test", 0)
	b := testEngineChannel("b", good.URL, "native", 1)
	b.Config.Aliases = []ModelAlias{{From: "test", To: "native"}}
	s := &engineMemoryStore{channels: []Channel{a, b}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{})
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "test", true), nil, "", "api")
	if rec.Code != 200 || rec.Header().Get("X-Pulsegate-Channel-Id") != "b" || rec.Header().Get("X-Pulsegate-Attempts") != "2" {
		t.Fatalf("unexpected route %d %s %s", rec.Code, rec.Header(), rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "keepalive") || !strings.Contains(rec.Body.String(), `"model":"test"`) {
		t.Fatalf("unsafe stream prefix/rewrite: %s", rec.Body.String())
	}
}

func TestEngineStreamNeverReplaysAfterVisibleOutputAndIdleDeadlineReleasesSlot(t *testing.T) {
	var backupCalls atomic.Int64
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer bad.Close()
	backup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { backupCalls.Add(1); completionEngineResponse(w) }))
	defer backup.Close()
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", bad.URL, "test", 0), testEngineChannel("b", backup.URL, "test", 1)}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{ChannelConcurrency: 1, StreamIdleTimeout: 30 * time.Millisecond})
	rec := httptest.NewRecorder()
	start := time.Now()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "test", true), nil, "", "api")
	if time.Since(start) > time.Second {
		t.Fatal("stream idle deadline did not terminate")
	}
	if backupCalls.Load() != 0 || !strings.Contains(rec.Body.String(), "first") {
		t.Fatalf("stream replayed after output: %s", rec.Body.String())
	}
	runtime := e.runtime(s.channels[0])
	runtime.mu.Lock()
	active := runtime.active
	runtime.mu.Unlock()
	if active != 0 {
		t.Fatal("stream slot leaked")
	}
}

func TestEngineFirstTokenDeadlineIgnoresMetadataKeepalives(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				_, _ = io.WriteString(w, ": ping\n\n")
				w.(http.Flusher).Flush()
			}
		}
	}))
	defer bad.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { completionEngineResponse(w) }))
	defer good.Close()
	settings := testEngineSettings()
	settings.StreamFirstTokenTimeout = 0
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", bad.URL, "test", 0), testEngineChannel("b", good.URL, "test", 1)}, settings: settings}
	e := testEngine(t, s, EngineConfig{FirstTokenTimeout: 40 * time.Millisecond})
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "test", true), nil, "", "api")
	if rec.Header().Get("X-Pulsegate-Channel-Id") != "b" || strings.Contains(rec.Body.String(), "ping") {
		t.Fatalf("TTFT failover failed: %s %s", rec.Header(), rec.Body.String())
	}
}

func TestEngineCancelStreamReleasesCapacity(t *testing.T) {
	var calls atomic.Int64
	entered := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if calls.Add(1) == 1 {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"token\"}}]}\n\n")
			w.(http.Flusher).Flush()
			close(entered)
			<-r.Context().Done()
			return
		}
		completionEngineResponse(w)
	}))
	defer upstream.Close()
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", upstream.URL, "test", 0)}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{ChannelConcurrency: 1})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		e.ServeGateway(httptest.NewRecorder(), testEngineRequest(ctx, "test", true), nil, "", "api")
	}()
	<-entered
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancel did not release handler")
	}
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
	if rec.Code != 200 {
		t.Fatalf("capacity leaked: %d %s", rec.Code, rec.Body.String())
	}
}

func TestResolveUpstreamURLDeploymentPrefixAndSafety(t *testing.T) {
	for _, prefix := range []string{"", "/", "/v1", "/tenant", "/tenant/v1"} {
		c := testEngineChannel("a", "https://upstream.example"+prefix, "test", 0)
		actual, err := ResolveUpstreamURL(c, "/v1/responses", "test", false)
		if err != nil {
			t.Fatal(err)
		}
		expected := "https://upstream.example/v1/responses"
		if strings.Contains(prefix, "tenant") {
			expected = "https://upstream.example/tenant/v1/responses"
		}
		if actual != expected {
			t.Errorf("prefix %q got %q want %q", prefix, actual, expected)
		}
	}
	c := testEngineChannel("a", "https://upstream.example/tenant/v1", "test", 0)
	for _, path := range []string{"//foreign.example/v1", "/v1/%2e%2e/admin", "/v1/%2e%2e%2fadmin", "/v1/../admin", "/v1\\admin"} {
		if _, err := ResolveUpstreamURL(c, path, "test", false); err == nil {
			t.Errorf("accepted unsafe path %s", path)
		}
	}
}

func TestEngineProfileScopeMappingsAndSecrets(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer upstream-secret" || r.Header.Get("Cookie") != "" {
			t.Error("upstream auth isolation failed")
		}
		completionEngineResponse(w)
	}))
	defer upstream.Close()
	c := testEngineChannel("a", upstream.URL, "native", 0)
	c.Tags = []string{"private"}
	c.Config.Aliases = []ModelAlias{{From: "alias", To: "native"}}
	s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{})
	key := &APIKey{ID: "key", Status: "active", ActiveProfile: "profile", Profiles: []KeyProfile{{ID: "profile", Scope: "channels", ChannelIDs: []string{"a"}, ModelMode: "selected", Models: []string{"alias"}, Mappings: []ModelMapping{{From: "public", To: []string{"alias"}}}}}}
	req := testEngineRequest(context.Background(), "public", false)
	req.Header.Set("Authorization", "Bearer client-secret")
	req.Header.Set("Cookie", "session=admin")
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, req, key, "", "api")
	if rec.Code != 200 {
		t.Fatalf("mapping failed %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "native", false), key, "", "api")
	if rec.Code != 403 {
		t.Fatalf("model scope bypass: %d", rec.Code)
	}
}

func TestEngineCredentialProbeHasIndependentCapacityAndTargetsDisabledKey(t *testing.T) {
	entered := make(chan struct{})
	var recovered atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if r.Header.Get("X-Test-Hang") == "1" {
			close(entered)
			<-r.Context().Done()
			return
		}
		if r.Header.Get("Authorization") != "Bearer recovering-secret" {
			t.Errorf("probed wrong credential: %q", r.Header.Get("Authorization"))
		}
		recovered.Add(1)
		completionEngineResponse(w)
	}))
	defer upstream.Close()
	reason := "上游 HTTP 401 连续失败"
	settings := testEngineSettings()
	settings.AutoDisableEnabled = true
	settings.AutoDisableTarget = "key"
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", upstream.URL, "test", 0)}, settings: settings, credentials: []Credential{{ID: "healthy", Enabled: true, Secret: "healthy-secret"}, {ID: "recovering", Enabled: false, Secret: "recovering-secret", Reason: &reason}}}
	e := testEngine(t, s, EngineConfig{ChannelConcurrency: 1})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		req := testEngineRequest(ctx, "test", false)
		req.Header.Set("X-Test-Hang", "1")
		e.ServeGateway(httptest.NewRecorder(), req, nil, "", "api")
	}()
	<-entered
	start := time.Now()
	if err := e.ProbeCredential(context.Background(), s.channels[0], "recovering", false); err != nil {
		t.Fatalf("probe blocked by occupied inference slot: %v", err)
	}
	if time.Since(start) > 500*time.Millisecond {
		t.Fatal("probe waited on inference connection pool")
	}
	if recovered.Load() != 1 {
		t.Fatalf("targeted key probe calls=%d", recovered.Load())
	}
	cancel()
	<-done
}

func TestEngineProbeReportsStreamErrorAfterOutput(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\nevent: error\ndata: {\"error\":{\"message\":\"failure\"}}\n\n")
	}))
	defer upstream.Close()
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", upstream.URL, "test", 0)}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{})
	if err := e.ProbeChannel(context.Background(), s.channels[0], true); err == nil {
		t.Fatal("stream failure incorrectly reported as successful probe")
	}
}

func TestMaintenanceRecoveryPoliciesAndDisabledCredentialSelection(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	s := testEngineSettings()
	s.AutoRecover = false
	s.AutoDisableEnabled = true
	s.AutoDisableTarget = "key"
	s.AutoDisableRecover = true
	reason := "上游 HTTP 401 连续失败"
	credentials := []Credential{{ID: "manual", Enabled: false}, {ID: "automatic", Enabled: false, Reason: &reason}, {ID: "healthy", Enabled: true}}
	job, ok := recoveryForChannel(c, s, credentials, time.Now())
	if !ok || job.credentialID != "automatic" {
		t.Fatalf("healthy channel disabled key not selected: %+v %v", job, ok)
	}
	c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "key", Recover: false}
	if _, ok := recoveryForChannel(c, s, credentials, time.Now()); ok {
		t.Fatal("per-channel recover=false ignored")
	}
	c.Config.AutoDisable = DefaultChannelConfig().AutoDisable
	s.AutoDisableEnabled = false
	c.Status = "degraded"
	s.AutoRecover = true
	slow := "响应耗时超过阈值"
	c.Health.Reason = &slow
	job, ok = recoveryForChannel(c, s, nil, time.Now())
	if !ok || job.stream {
		t.Fatal("response duration degradation must use nonstream recovery")
	}
}

func TestEngineErrorModeSuppressesUpstreamBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = io.WriteString(w, `{"error":{"message":"private provider diagnostic"}}`)
	}))
	defer upstream.Close()
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", upstream.URL, "test", 0)}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{})
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
	if strings.Contains(rec.Body.String(), "private provider diagnostic") || !strings.Contains(rec.Body.String(), s.settings.CustomErrorMessage) {
		t.Fatalf("custom errorMode leaked provider body: %s", rec.Body.String())
	}
}

func TestEngineGeminiAliasStripsClientQueryCredentialAndRoutingModel(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.EscapedPath() != "/tenant/v1beta/models/native%2Fmodel:generateContent" {
			t.Errorf("wrong native path %s", r.URL.EscapedPath())
		}
		if r.URL.Query().Get("key") != "" || r.URL.Query().Get("alt") != "json" || r.Header.Get("X-Goog-Api-Key") != "upstream-secret" {
			t.Error("native auth/query routing failed")
		}
		data, _ := io.ReadAll(r.Body)
		if strings.Contains(string(data), `"model"`) {
			t.Errorf("routing field leaked into Gemini body: %s", data)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"OK"}]}}]}`)
	}))
	defer upstream.Close()
	c := testEngineChannel("a", upstream.URL+"/tenant/v1beta", "native/model", 0)
	c.Config.Protocol = "gemini"
	c.Config.Aliases = []ModelAlias{{From: "public", To: "native/model"}}
	s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{})
	req := httptest.NewRequest(http.MethodPost, "http://gateway/v1beta/models/public:generateContent?key=client-secret&alt=json", strings.NewReader(`{"contents":[{"role":"user","parts":[{"text":"test"}]}]}`))
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, req, nil, "", "api")
	if rec.Code != 200 {
		t.Fatalf("native Gemini failed %d %s", rec.Code, rec.Body.String())
	}
}

func TestEngineOverallDeadlineReturnsGatewayTimeout(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.Copy(io.Discard, r.Body); <-r.Context().Done() }))
	defer upstream.Close()
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a", upstream.URL, "test", 0)}, settings: testEngineSettings()}
	e := testEngine(t, s, EngineConfig{RequestTimeout: 30 * time.Millisecond})
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
	if rec.Code != 504 {
		t.Fatalf("deadline produced invalid response %d %s", rec.Code, rec.Body.String())
	}
}

func TestEngineRoundRobinIndependentOfOtherModels(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { completionEngineResponse(w) }))
	defer upstream.Close()
	settings := testEngineSettings()
	settings.Strategy = "round-robin"
	s := &engineMemoryStore{channels: []Channel{testEngineChannel("a1", upstream.URL, "a", 0), testEngineChannel("a2", upstream.URL, "a", 1), testEngineChannel("b1", upstream.URL, "b", 0), testEngineChannel("b2", upstream.URL, "b", 1)}, settings: settings}
	e := testEngine(t, s, EngineConfig{})
	for _, test := range []struct{ model, channel string }{{"a", "a1"}, {"b", "b1"}, {"a", "a2"}, {"b", "b2"}} {
		rec := httptest.NewRecorder()
		e.ServeGateway(rec, testEngineRequest(context.Background(), test.model, false), nil, "", "api")
		if rec.Header().Get("X-Pulsegate-Channel-Id") != test.channel {
			t.Fatalf("cross-model round robin interference: wanted %s got %s", test.channel, rec.Header().Get("X-Pulsegate-Channel-Id"))
		}
	}
}

func TestEngineRecoveryRequiresConfiguredSuccessCount(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	c.Status = "offline"
	c.Health.FailureCount = 3
	r := &channelRuntime{}
	s := testEngineSettings()
	s.Recovery = 2
	attempt := Attempt{StartedAt: time.Now().UTC().Format(time.RFC3339Nano), Result: "success", Status: 200, Duration: 0.1}
	first := r.observe(c, attempt, s)
	if first.status != "offline" {
		t.Fatal("channel recovered before required successful probes")
	}
	second := r.observe(c, attempt, s)
	if second.status != "healthy" || second.event == nil || second.event.Type != "recovery" {
		t.Fatal("channel did not recover or emit event after successful probes")
	}
}
