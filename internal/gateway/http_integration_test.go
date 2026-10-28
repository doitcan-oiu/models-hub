package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestHTTPFaultIsolationWithPostgres(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	settings := DefaultSettings()
	settings.RetryEnabled = false
	if err := s.SaveSettings(ctx, settings); err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, 4)
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer dead.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"model":"b","choices":[{"message":{"content":"OK"}}]}`)
	}))
	defer healthy.Close()
	for _, c := range []Channel{testEngineChannel("a", dead.URL, "a", 0), testEngineChannel("b", healthy.URL, "b", 0)} {
		if err := s.SaveChannelBundle(ctx, c, []Credential{{ID: c.ID + "-credential", Enabled: true, Secret: "private-secret"}}, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	key, err := newAPIKey(map[string]any{"name": "same hot application key"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	key.TokenHash = tokenHash("pg_live_shared-key")
	if err = s.SaveKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	engine := NewEngine(s, EngineConfig{ChannelConcurrency: 4, LogQueueSize: 32, LogWorkers: 2})
	defer engine.Close(ctx)
	handler := NewHandler(s, engine, NewIntegrations(s), HTTPConfig{})
	hanging, cancel := context.WithCancel(ctx)
	defer cancel()
	var hangingWG sync.WaitGroup
	for range 4 {
		hangingWG.Add(1)
		go func() {
			defer hangingWG.Done()
			r := httptest.NewRequest("POST", "http://gateway.test/v1/chat/completions", strings.NewReader(`{"model":"a","stream":false}`)).WithContext(hanging)
			r.Header.Set("Authorization", "Bearer pg_live_shared-key")
			handler.ServeHTTP(httptest.NewRecorder(), r)
		}()
	}
	for range 4 {
		select {
		case <-started:
		case <-time.After(3 * time.Second):
			t.Fatal("A did not occupy its slots")
		}
	}
	var calls sync.WaitGroup
	successes := 0
	began := time.Now()
	for i := 0; i < 100; i++ {
		calls.Add(1)
		go func() {
			defer calls.Done()
			r := httptest.NewRequest("POST", "http://gateway.test/v1/chat/completions", strings.NewReader(`{"model":"a","stream":false}`))
			r.Header.Set("Authorization", "Bearer pg_live_shared-key")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != 503 {
				t.Errorf("full A status = %d", w.Code)
			}
		}()
	}
	for range 20 {
		r := httptest.NewRequest("POST", "http://gateway.test/v1/chat/completions", strings.NewReader(`{"model":"b","stream":false}`))
		r.Header.Set("Authorization", "Bearer pg_live_shared-key")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Errorf("B failed under A flood: %d %s", w.Code, w.Body.String())
		} else {
			successes++
		}
	}
	calls.Wait()
	elapsed := time.Since(began)
	cancel()
	hangingWG.Wait()
	if successes != 20 {
		t.Fatalf("healthy B completed %d/20 calls", successes)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("healthy requests blocked by A: %s", elapsed)
	}
}

func TestHTTPPostgresManagementAndGateway(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-upstream-token" {
			t.Error("upstream credential was not forwarded")
			http.Error(w, "bad auth", 401)
			return
		}
		var b map[string]any
		_ = json.NewDecoder(r.Body).Decode(&b)
		if b["model"] != "physical-model" {
			t.Errorf("upstream alias = %v", b["model"])
		}
		writeJSON(w, 200, map[string]any{"model": "physical-model", "choices": []any{map[string]any{"message": map[string]string{"content": "OK"}}}, "usage": map[string]int{"prompt_tokens": 3, "completion_tokens": 2}})
	}))
	defer upstream.Close()
	e := NewEngine(s, EngineConfig{CacheTTL: time.Hour})
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if err := e.Close(closeCtx); err != nil {
			t.Error(err)
		}
	})
	h := NewHandler(s, e, NewIntegrations(s), HTTPConfig{AdminToken: "a-long-test-admin-token-at-least-24", PublicURL: "https://gateway.test"})
	request := func(method, path string, body any, token string) *httptest.ResponseRecorder {
		t.Helper()
		var data []byte
		if body != nil {
			data, _ = json.Marshal(body)
		}
		r := httptest.NewRequest(method, "https://gateway.test"+path, bytes.NewReader(data))
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	admin := "a-long-test-admin-token-at-least-24"
	if w := request("GET", "/api/bootstrap", nil, ""); w.Code != 401 {
		t.Fatalf("unauthorized status %d", w.Code)
	}
	created := request("POST", "/api/channels", map[string]any{"name": "HTTP test", "endpoint": upstream.URL, "models": []string{"physical-model"}, "config": map[string]any{"aliases": []map[string]string{{"from": "public-model", "to": "physical-model"}}, "prices": []map[string]any{{"model": "physical-model", "input": 1, "output": 2}}}, "apiKeys": []string{"private-upstream-token"}}, admin)
	if created.Code != 201 {
		t.Fatalf("create channel %d: %s", created.Code, created.Body.String())
	}
	if strings.Contains(created.Body.String(), "private-upstream-token") {
		t.Fatal("secret exposed")
	}
	var channelResult struct {
		Channel Channel `json:"channel"`
	}
	_ = json.Unmarshal(created.Body.Bytes(), &channelResult)
	keyResponse := request("POST", "/api/keys", map[string]any{"name": "application"}, admin)
	var keyResult struct {
		Key   APIKey `json:"key"`
		Token string `json:"token"`
	}
	if keyResponse.Code != 201 || json.Unmarshal(keyResponse.Body.Bytes(), &keyResult) != nil || keyResult.Token == "" {
		t.Fatalf("create key: %s", keyResponse.Body.String())
	}
	listed := request("GET", "/v1/models", nil, keyResult.Token)
	if listed.Code != 200 || !strings.Contains(listed.Body.String(), "public-model") {
		t.Fatalf("list models: %s", listed.Body.String())
	}
	response := request("POST", "/v1/chat/completions", map[string]any{"model": "public-model", "messages": []map[string]string{{"role": "user", "content": "hello"}}, "stream": false}, keyResult.Token)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"model":"public-model"`) {
		t.Fatalf("gateway: %d %s", response.Code, response.Body.String())
	}
	requestID := response.Header().Get("X-Pulsegate-Request-Id")
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, _, err := s.Log(ctx, requestID); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("async request log did not persist")
		}
		time.Sleep(10 * time.Millisecond)
	}
	for _, selected := range []string{"1h", "24h", "7d"} {
		dashboard := request("GET", "/api/dashboard?range="+selected, nil, admin)
		if dashboard.Code != 200 {
			t.Fatalf("dashboard %s: %d %s", selected, dashboard.Code, dashboard.Body.String())
		}
		var data map[string]any
		_ = json.Unmarshal(dashboard.Body.Bytes(), &data)
		totals := data["totals"].(map[string]any)
		if totals["requests"] != float64(1) || totals["inputTokens"] != float64(3) || totals["outputTokens"] != float64(2) {
			t.Fatalf("dashboard totals: %v", totals)
		}
	}
	rotated := request("POST", "/api/keys/"+keyResult.Key.ID+"/rotate", map[string]any{}, admin)
	if rotated.Code != 200 {
		t.Fatal(rotated.Body.String())
	}
	if w := request("GET", "/v1/models", nil, keyResult.Token); w.Code != 401 {
		t.Fatal("rotated token remains valid")
	}
	if w := request("POST", "/api/keys/bulk", map[string]any{"ids": []string{keyResult.Key.ID, "missing"}, "action": "delete"}, admin); w.Code != 404 {
		t.Fatalf("bulk status %d: %s", w.Code, w.Body.String())
	}
	if _, err := s.Key(ctx, keyResult.Key.ID); err != nil {
		t.Fatal("bulk partially committed")
	}
	login := request("POST", "/api/session", map[string]any{"token": admin}, "")
	if login.Code != 200 {
		t.Fatal(login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure {
		t.Fatal("session cookie protections missing")
	}
	cookieRequest := func(method, origin, authorization string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, "https://gateway.test/api/session", strings.NewReader(`{}`))
		r.AddCookie(cookies[0])
		r.Header.Set("Origin", origin)
		if authorization != "" {
			r.Header.Set("Authorization", authorization)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := cookieRequest("DELETE", "https://attacker.test", "Bearer invalid"); w.Code != 403 {
		t.Fatal("arbitrary bearer bypassed CSRF validation")
	}
	if w := cookieRequest("DELETE", "https://gateway.test", ""); w.Code != 200 {
		t.Fatal("logout failed")
	}
	if w := cookieRequest("GET", "", ""); !strings.Contains(w.Body.String(), `"authenticated":false`) {
		t.Fatal("logout did not revoke session")
	}
}

func TestHTTPNativeAnthropicAndGemini(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "messages") {
			if r.Header.Get("X-Api-Key") != "native-secret" || r.Header.Get("Anthropic-Version") == "" {
				t.Error("Anthropic authentication missing")
			}
			_, _ = io.WriteString(w, `{"type":"message","model":"claude","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":1,"output_tokens":1}}`)
		} else {
			if r.Header.Get("X-Goog-Api-Key") != "native-secret" {
				t.Error("Gemini auth missing")
			}
			_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"OK"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}`)
		}
	}))
	defer up.Close()
	for _, protocol := range []string{"anthropic", "gemini"} {
		c := testEngineChannel(protocol, up.URL, protocol, 0)
		c.Config.Protocol = protocol
		if err := s.SaveChannelBundle(ctx, c, []Credential{{ID: protocol + "-cred", Label: "native", Secret: "native-secret", Enabled: true}}, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	key, err := newAPIKey(map[string]any{"name": "native"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	key.TokenHash = tokenHash("pg_live_native-token")
	if err = s.SaveKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	e := NewEngine(s, EngineConfig{})
	defer e.Close(ctx)
	h := NewHandler(s, e, NewIntegrations(s), HTTPConfig{})
	for _, test := range []struct{ path, body string }{{"/v1/messages", `{"model":"anthropic","messages":[{"role":"user","content":"OK"}],"max_tokens":5}`}, {"/v1beta/models/gemini:generateContent", `{"contents":[{"role":"user","parts":[{"text":"OK"}]}]}`}} {
		r := httptest.NewRequest("POST", "http://gateway.test"+test.path, strings.NewReader(test.body))
		r.Header.Set("X-API-Key", "pg_live_native-token")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("native %s: %d %s", test.path, w.Code, w.Body.String())
		}
	}
}
