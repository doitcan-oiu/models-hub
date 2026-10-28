package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSQLitePortableDomain(t *testing.T) { runPortableDomainTests(t, testSQLiteStore(t)) }
func runPortableDomainTests(t *testing.T, s *Store) {
	t.Helper()
	ctx := context.Background()
	channel := testStoredChannel("portable")
	channel.Tags = []string{"original"}
	if err := s.SaveChannelBundle(ctx, channel, []Credential{{ID: "portable-credential", Label: "original", Secret: "first-upstream-secret", Enabled: true}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if channels, err := s.Channels(ctx); err != nil || len(channels) != 1 || channels[0].CredentialCount != 1 {
		t.Fatalf("channels %v %v", channels, err)
	}
	if _, err := s.PatchManagedCredential(ctx, channel.ID, Credential{ID: "portable-credential", Label: "renamed"}, nil); err != nil {
		t.Fatal(err)
	}
	creds, err := s.Credentials(ctx, channel.ID, true)
	if err != nil || creds[0].Secret != "first-upstream-secret" || creds[0].Label != "renamed" {
		t.Fatalf("credential update %v %v", creds, err)
	}
	key, err := newAPIKey(map[string]any{"name": "portable key"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	key.TokenHash = HashToken("pg_live_portable")
	key.Profiles[0].RequestLimit = "7"
	if err = s.SaveKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	var successes atomic.Int32
	var wg sync.WaitGroup
	for range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			allowed, err := s.ConsumeKey(ctx, key.ID, key.ActiveProfile, 7)
			if err != nil {
				t.Errorf("consume: %v", err)
			}
			if allowed {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 7 {
		t.Fatalf("quota allowed %d, want 7", successes.Load())
	}
	saved, err := s.Key(ctx, key.ID)
	if err != nil || saved.Used != 7 {
		t.Fatalf("quota persistence %v %v", saved, err)
	}
	channel.Config.RateLimit.RequestsPerMinute = 6
	channel.Config.RateLimit.TokensPerMinute = 60
	if err = s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	successes.Store(0)
	for range 40 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			allowed, err := s.ReserveChannel(ctx, channel, 10)
			if err != nil {
				t.Errorf("rate: %v", err)
			}
			if allowed {
				successes.Add(1)
			}
		}()
	}
	wg.Wait()
	if successes.Load() != 6 {
		t.Fatalf("rate allowed %d, want6", successes.Load())
	}
	if err = s.BulkKeys(ctx, []string{key.ID, "missing"}, "delete"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bulk must rollback %v", err)
	}
	if _, err = s.Key(ctx, key.ID); err != nil {
		t.Fatal("partial key deletion", err)
	}
	if err = s.RenameTag(ctx, "original", "renamed"); err != nil {
		t.Fatal(err)
	}
	channel, err = s.Channel(ctx, channel.ID)
	if err != nil || !containsString(channel.Tags, "renamed") {
		t.Fatalf("tag rename: %v %v", channel.Tags, err)
	}
	if err = s.DeleteTag(ctx, "renamed"); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	ttft := .5
	attempt := Attempt{ID: "portable-attempt", RequestID: "portable-log", ChannelID: channel.ID, ChannelName: channel.Name, Model: channel.Model, StartedAt: now, Status: 200, Result: "success", Duration: 1, TTFT: &ttft, InputTokens: 3, OutputTokens: 2, Attempt: 1}
	log := RequestLog{ID: attempt.RequestID, CreatedAt: now, Model: channel.Model, Channel: channel.Name, ChannelID: &channel.ID, Status: 200, Result: "success", Duration: 1, Attempts: 1, Source: "api"}
	for range 2 {
		if err = s.Record(ctx, log, []Attempt{attempt}); err != nil {
			t.Fatal(err)
		}
	}
	channel, err = s.Channel(ctx, channel.ID)
	s.InvalidateCache()
	channel, err = s.Channel(ctx, channel.ID)
	if err != nil || channel.Requests != 1 {
		t.Fatalf("idempotent counters: %d %v", channel.Requests, err)
	}
	logs, total, err := s.Logs(ctx, 10, 0, strings.ToUpper(channel.Model), "success", channel.ID)
	if err != nil || total != 1 || len(logs) != 1 {
		t.Fatalf("logs: %v %d %v", logs, total, err)
	}
	if _, attempts, err := s.Log(ctx, log.ID); err != nil || len(attempts) != 1 {
		t.Fatalf("log detail: %v %v", attempts, err)
	}
	reason := "HTTP 503"
	if err = s.UpdateHealth(ctx, channel.ID, Health{AutoDisabled: true, Reason: &reason}, "offline"); err != nil {
		t.Fatal(err)
	}
	if err = s.ResetHealth(ctx, channel.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.UpdateHealthAfter(ctx, channel.ID, Health{AutoDisabled: true}, "offline", now); err != nil {
		t.Fatal(err)
	}
	s.InvalidateCache()
	channel, err = s.Channel(ctx, channel.ID)
	if err != nil || channel.Status != "healthy" {
		t.Fatalf("health cutoff: %v %v", channel, err)
	}
	channel.Config.Integration = "newapi"
	bundle := managedBundle{channel: channel, mustExist: true}
	accountData, _ := json.Marshal(accountMetadata{Integration: "newapi", AuthMode: "token", Version: 1})
	secret, err := s.Encrypt(`{"mode":"token","accessToken":"private-access-token"}`)
	if err != nil {
		t.Fatal(err)
	}
	bundle.accountData = accountData
	bundle.accountSecret = secret
	if err = s.saveManagedBundles(ctx, []managedBundle{bundle}); err != nil {
		t.Fatal(err)
	}
	claim, err := s.claimIntegrationAccount(ctx, channel.ID, true)
	if err != nil || claim == nil || claim.account.AccessToken != "private-access-token" {
		t.Fatalf("account lease: %+v %v", claim, err)
	}
	claim2, err := s.claimIntegrationAccount(ctx, channel.ID, true)
	if err != nil || claim2 != nil {
		t.Fatalf("lease double claimed %+v %v", claim2, err)
	}
	channel.Config.Integration = "bbdevlab"
	if err = s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	credentialClaim, err := s.claimIntegrationCredential(ctx, channel.ID, "portable-credential", true)
	if err != nil || credentialClaim == nil {
		t.Fatalf("credential lease: %+v %v", credentialClaim, err)
	}
	if _, err = s.integrationDueJobs(ctx, 20); err != nil {
		t.Fatalf("due scan %v", err)
	}
	if err = s.SetSticky(ctx, "portable-scope", channel.ID); err != nil {
		t.Fatal(err)
	}
	if sticky, err := s.GetSticky(ctx, "portable-scope"); err != nil || sticky != channel.ID {
		t.Fatalf("sticky %q %v", sticky, err)
	}
	if err = s.Cleanup(ctx, 30); err != nil {
		t.Fatal(err)
	}
}

func TestSQLiteGatewayManagementHTTP(t *testing.T) {
	s := testSQLiteStore(t)
	ctx := context.Background()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"physical","choices":[{"message":{"content":"OK"}}],"usage":{"prompt_tokens":2,"completion_tokens":3}}`))
	}))
	defer up.Close()
	e := NewEngine(s, EngineConfig{LogWorkers: 1})
	defer e.Close(ctx)
	h := NewHandler(s, e, NewIntegrations(s), HTTPConfig{AdminToken: "sqlite-admin-token-at-least-24"})
	call := func(method, path, body, token string) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, "http://gateway.test"+path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	admin := "sqlite-admin-token-at-least-24"
	response := call("POST", "/api/channels", `{"name":"SQLite HTTP","endpoint":"`+up.URL+`","models":["physical"],"apiKeys":["private-key"],"config":{"aliases":[{"from":"public","to":"physical"}]}}`, admin)
	if response.Code != 201 {
		t.Fatalf("create channel %d %s", response.Code, response.Body.String())
	}
	keyResult := call("POST", "/api/keys", `{"name":"sqlite"}`, admin)
	var value struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(keyResult.Body.Bytes(), &value)
	if value.Token == "" {
		t.Fatal(keyResult.Body.String())
	}
	response = call("POST", "/v1/chat/completions", `{"model":"public","messages":[{"role":"user","content":"hi"}]}`, value.Token)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"model":"public"`) {
		t.Fatalf("gateway %d %s", response.Code, response.Body.String())
	}
	if err := e.Close(ctx); err != nil {
		t.Fatal(err)
	}
	response = call("GET", "/api/dashboard?range=1h", "", admin)
	if response.Code != 200 {
		t.Fatalf("dashboard %d %s", response.Code, response.Body.String())
	}
}

func TestSQLiteD1Import(t *testing.T) {
	s := testSQLiteStore(t)
	snapshot := d1TestSnapshot(t, s)
	result, err := s.ImportD1(context.Background(), snapshot)
	if err != nil || result.Channels < 1 || result.Credentials < 1 {
		t.Fatalf("import %+v %v", result, err)
	}
	if _, err = s.ImportD1(context.Background(), snapshot); err == nil {
		t.Fatal("populated database accepted a second import")
	}
}
