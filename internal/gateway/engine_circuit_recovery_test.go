package gateway

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestEngineRecoveryIgnoresInflightCircuitFailures(t *testing.T) {
	for _, recovery := range []string{"manual-reset", "successful-probe"} {
		t.Run(recovery, func(t *testing.T) {
			entered := make(chan struct{}, 3)
			finish := make(chan struct{})
			var finishOnce sync.Once
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("X-Old-Request") == "1" {
					entered <- struct{}{}
					<-finish
					w.WriteHeader(503)
					return
				}
				completionEngineResponse(w)
			}))
			defer upstream.Close()
			defer finishOnce.Do(func() { close(finish) })
			c := testEngineChannel("a", upstream.URL, "test", 0)
			s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}
			s.settings.RetryEnabled = false
			e := testEngine(t, s, EngineConfig{CircuitFailures: 3, CircuitCooldown: time.Hour})
			var requests sync.WaitGroup
			for range 3 {
				requests.Add(1)
				go func() {
					defer requests.Done()
					r := testEngineRequest(context.Background(), "test", false)
					r.Header.Set("X-Old-Request", "1")
					e.ServeGateway(httptest.NewRecorder(), r, nil, "", "api")
				}()
			}
			for range 3 {
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("old requests never reached upstream")
				}
			}
			if recovery == "manual-reset" {
				e.ResetCircuit(c.ID)
			} else if err := e.ProbeChannel(context.Background(), c, false); err != nil {
				t.Fatal(err)
			}
			finishOnce.Do(func() { close(finish) })
			requests.Wait()
			state := e.channelRuntimeState(c.ID)
			if state.Active != 0 || state.CircuitUntil != nil || state.HalfOpen {
				t.Fatalf("old failures refroze recovered channel: %+v", state)
			}
			rec := httptest.NewRecorder()
			e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
			if rec.Code != 200 {
				t.Fatalf("recovered upstream was skipped: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestCircuitHalfOpenLeaseSurvivesOldRequests(t *testing.T) {
	r := &channelRuntime{limit: 4}
	cfg := EngineConfig{CircuitFailures: 1, CircuitCooldown: time.Hour}
	first, blocked := r.acquire(false, true)
	if blocked != "" {
		t.Fatal(blocked)
	}
	old, _ := r.acquire(false, true)
	r.release(first, -1, cfg)
	deadline := r.openUntil
	r.mu.Lock()
	r.openUntil = time.Now().Add(-time.Second)
	r.mu.Unlock()
	half, blocked := r.acquire(false, true)
	if blocked != "" || !half.halfOpen {
		t.Fatal("cooldown expiry did not admit one recovery request")
	}
	r.release(old, -1, cfg)
	if r.openUntil.After(deadline) {
		t.Fatal("an old failure extended the cooldown")
	}
	if _, blocked := r.acquire(false, true); blocked == "" {
		t.Fatal("old request released another request's half-open lease")
	}
	r.release(half, 1, cfg)
	if r.active != 0 || r.halfOpen || !r.openUntil.IsZero() {
		t.Fatal("successful half-open request did not restore capacity")
	}
}

func TestCircuitInflightSuccessClearsAnOpenedCircuit(t *testing.T) {
	r := &channelRuntime{limit: 2}
	cfg := EngineConfig{CircuitFailures: 1, CircuitCooldown: time.Hour}
	good, _ := r.acquire(false, true)
	bad, _ := r.acquire(false, true)
	r.release(bad, -1, cfg)
	if r.openUntil.IsZero() {
		t.Fatal("failure did not open circuit")
	}
	r.release(good, 1, cfg)
	if !r.openUntil.IsZero() || r.failures != 0 {
		t.Fatal("known successful upstream response left channel frozen")
	}
}

func TestEngineErrorCooldownExemptionAlsoDisablesFastCircuit(t *testing.T) {
	var fail atomic.Bool
	var calls atomic.Int64
	fail.Store(true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if fail.Load() {
			w.WriteHeader(503)
			return
		}
		completionEngineResponse(w)
	}))
	defer upstream.Close()
	c := testEngineChannel("a", upstream.URL, "test", 0)
	c.Config.Cooldown.Error = false
	s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}
	s.settings.RetryEnabled = false
	e := testEngine(t, s, EngineConfig{CircuitFailures: 1, CircuitCooldown: time.Hour})
	e.runtime(c).openUntil = time.Now().Add(time.Hour)
	for i := range 4 {
		rec := httptest.NewRecorder()
		e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
		if rec.Code != 503 || calls.Load() != int64(i+1) {
			t.Fatalf("exempt channel did not reach upstream: %d %s", rec.Code, rec.Body.String())
		}
	}
	fail.Store(false)
	rec := httptest.NewRecorder()
	e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
	if rec.Code != 200 || e.channelRuntimeState(c.ID).CircuitUntil != nil {
		t.Fatalf("exempt channel remained frozen: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEngineAdmissionFailureExplainsBlockedState(t *testing.T) {
	for _, state := range []string{"手动停用", "自动停用", "健康检查未恢复", "并发已满", "熔断冷却或恢复检测中"} {
		t.Run(state, func(t *testing.T) {
			c := testEngineChannel("a", "http://unused", "test", 0)
			s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings()}
			s.settings.AutoSwitch = true
			s.settings.ErrorMode = "raw"
			switch state {
			case "手动停用":
				s.channels[0].Enabled = false
			case "自动停用":
				s.channels[0].Health.AutoDisabled = true
			case "健康检查未恢复":
				s.channels[0].Status = "offline"
			}
			e := testEngine(t, s, EngineConfig{})
			rt := e.runtime(c)
			if state == "并发已满" {
				rt.active = rt.limit
			} else if state == "熔断冷却或恢复检测中" {
				rt.openUntil = time.Now().Add(time.Hour)
			}
			rec := httptest.NewRecorder()
			e.ServeGateway(rec, testEngineRequest(context.Background(), "test", false), nil, "", "api")
			if rec.Code != 503 || !strings.Contains(rec.Body.String(), state+" 1 个") || s.credentialCalls.Load() != 0 {
				t.Fatalf("ambiguous rejection: %d %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestChannelRecoveryUsesEnabledKeyAndFiniteOutputBudget(t *testing.T) {
	for _, protocol := range []string{"openai", "anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				budget, _ := body["max_tokens"].(float64)
				if protocol == "gemini" {
					budget = body["generationConfig"].(map[string]any)["maxOutputTokens"].(float64)
				}
				if budget <= 1 || budget > 256 {
					t.Errorf("probe output budget is too small or unbounded: %g", budget)
				}
				if strings.Contains(r.Header.Get("Authorization")+r.Header.Get("X-Api-Key")+r.Header.Get("X-Goog-Api-Key"), "bad-secret") {
					w.WriteHeader(401)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch protocol {
				case "anthropic":
					_, _ = io.WriteString(w, `{"type":"message","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}`)
				case "gemini":
					_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}`)
				default:
					completionEngineResponse(w)
				}
			}))
			defer upstream.Close()
			c := testEngineChannel("a", upstream.URL, "test", 0)
			c.Config.Protocol = protocol
			reason := "HTTP 401"
			s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings(), credentials: []Credential{
				{ID: "bad", Secret: "bad-secret", Reason: &reason},
				{ID: "good", Secret: "good-secret", Enabled: true},
			}}
			e := testEngine(t, s, EngineConfig{})
			for range 2 {
				if err := e.ProbeChannel(context.Background(), c, false); err != nil {
					t.Fatalf("healthy key did not recover channel: %v", err)
				}
			}
		})
	}
}

func TestDisabledKeyProbeDoesNotInterruptChannelRecovery(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
	}))
	defer upstream.Close()
	c := testEngineChannel("a", upstream.URL, "test", 0)
	c.Status = "offline"
	c.Health.RecoveryCount = 1
	reason := "HTTP 401"
	c.Health.Reason = &reason
	s := &engineMemoryStore{channels: []Channel{c}, settings: testEngineSettings(), credentials: []Credential{{ID: "bad", Secret: "bad-secret", Reason: &reason}}}
	e := testEngine(t, s, EngineConfig{})
	rt := e.runtime(c)
	rt.healthLoaded = true
	rt.health = c.Health
	rt.healthStatus = c.Status
	if err := e.ProbeCredential(context.Background(), c, "bad", false); err == nil {
		t.Fatal("invalid key probe reported success")
	}
	if rt.health.RecoveryCount != 1 || len(rt.recentNonstream) != 0 {
		t.Fatal("disabled key failure broke the channel recovery streak")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.attempts) != 1 || s.attempts[0].HealthIgnored || s.attempts[0].Result != "error" {
		t.Fatal("disabled key failure was not retained for key recovery")
	}
}
