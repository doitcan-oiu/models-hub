package gateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func integrationTestJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func TestIntegrationModelDiscoveryPagination(t *testing.T) {
	for _, protocol := range []string{"anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if protocol == "anthropic" {
					if r.Header.Get("x-api-key") != "test-key" || r.URL.Query().Get("limit") != "100" {
						t.Error("missing Anthropic credentials or pagination size")
					}
					if r.URL.Query().Get("after_id") == "" {
						integrationTestJSON(w, map[string]any{"data": []any{map[string]any{"id": "zeta"}}, "has_more": true, "last_id": "page2"})
					} else {
						integrationTestJSON(w, map[string]any{"data": []any{map[string]any{"id": "alpha"}, map[string]any{"id": "zeta"}}, "has_more": false})
					}
				} else {
					if r.Header.Get("x-goog-api-key") != "test-key" || r.URL.Query().Get("pageSize") != "1000" {
						t.Error("missing Gemini credentials or pagination size")
					}
					if r.URL.Query().Get("pageToken") == "" {
						integrationTestJSON(w, map[string]any{"models": []any{map[string]any{"name": "models/zeta", "supportedGenerationMethods": []string{"generateContent"}}, map[string]any{"name": "models/embedding", "supportedGenerationMethods": []string{"embedContent"}}}, "nextPageToken": "page2"})
					} else {
						integrationTestJSON(w, map[string]any{"models": []any{map[string]any{"name": "models/alpha"}}, "nextPageToken": ""})
					}
				}
			}))
			defer server.Close()
			integration := NewIntegrations(nil)
			defer integration.client.CloseIdleConnections()
			result, err := integration.Discover(context.Background(), map[string]any{"endpoint": server.URL, "protocol": protocol, "apiKey": "test-key"})
			if err != nil {
				t.Fatal(err)
			}
			models := result["models"].([]string)
			if strings.Join(models, ",") != "alpha,zeta" || calls.Load() != 2 {
				t.Fatalf("incorrect paginated models: %#v, calls=%d", result, calls.Load())
			}
		})
	}
}

func TestIntegrationDiscoveryRejectsRepeatedCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		integrationTestJSON(w, map[string]any{"data": []any{map[string]any{"id": "alpha"}}, "has_more": true, "last_id": "same"})
	}))
	defer server.Close()
	integration := NewIntegrations(nil)
	defer integration.client.CloseIdleConnections()
	_, err := integration.Discover(context.Background(), map[string]any{"endpoint": server.URL, "protocol": "anthropic", "apiKey": "test-key"})
	if err == nil || !strings.Contains(err.Error(), "游标") {
		t.Fatalf("expected cursor rejection, got %v", err)
	}
}

func TestIntegrationRequestBoundsBodyAndCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			<-r.Context().Done()
			return
		}
		fmt.Fprint(w, strings.Repeat("x", 1025))
	}))
	defer server.Close()
	integration := NewIntegrations(nil)
	defer integration.client.CloseIdleConnections()
	if _, _, err := integration.request(context.Background(), server.URL, "/large", http.MethodGet, nil, nil, 1024); err == nil {
		t.Fatal("oversized response accepted")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, _, err := integration.request(ctx, server.URL, "/slow", http.MethodGet, nil, nil, 1024); err == nil {
		t.Fatal("cancelled request accepted")
	}
	if time.Since(started) > time.Second {
		t.Fatal("context cancellation did not bound blocked upstream")
	}
}

func TestIntegrationBadChannelDoesNotBlockOtherHost(t *testing.T) {
	blocked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer blocked.Close()
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { integrationTestJSON(w, map[string]any{"ok": true}) }))
	defer healthy.Close()
	integration := NewIntegrations(nil)
	defer integration.client.CloseIdleConnections()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{}, 4)
	done := make(chan struct{}, 4)
	for n := 0; n < 4; n++ {
		go func() {
			started <- struct{}{}
			_, _, _ = integration.request(ctx, blocked.URL, "", http.MethodGet, nil, nil, 1024)
			done <- struct{}{}
		}()
	}
	for n := 0; n < 4; n++ {
		<-started
	}
	healthyCtx, healthyCancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer healthyCancel()
	if _, _, err := integration.request(healthyCtx, healthy.URL, "", http.MethodGet, nil, nil, 1024); err != nil {
		t.Fatalf("dead channel blocked independent healthy host: %v", err)
	}
	cancel()
	for n := 0; n < 4; n++ {
		<-done
	}
}

func TestIntegrationAccountCredentialValidation(t *testing.T) {
	cases := []struct {
		name        string
		input       map[string]any
		integration string
		valid       bool
	}{
		{"newapi token", map[string]any{"accessToken": "Bearer token", "userId": "123"}, "newapi", true},
		{"sub browser", map[string]any{"cookie": "Cookie: session=abc;", "accessToken": "browser-token"}, "sub2api", true},
		{"sub token", map[string]any{"accessToken": "browser-token"}, "sub2api", false},
		{"header injection", map[string]any{"cookie": "session=abc\r\nx=y"}, "sub2api", false},
		{"ambiguous mode", map[string]any{"accessToken": "token", "username": "name", "password": "pass"}, "newapi", false},
		{"invalid id", map[string]any{"accessToken": "token", "userId": "9007199254740992"}, "newapi", false},
		{"bb unsupported password", map[string]any{"username": "name", "password": "pass"}, "bbdevlab", false},
		{"missing cookie separator", map[string]any{"cookie": "session"}, "sub2api", false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			account, err := parseIntegrationCredentials(test.input)
			if err == nil {
				err = validateIntegrationCredentials(test.integration, account)
			}
			if (err == nil) != test.valid {
				t.Fatalf("valid=%v error=%v", test.valid, err)
			}
		})
	}
}

func TestIntegrationBalancesPreserveSmallQuotasAndExpiry(t *testing.T) {
	now := time.Now()
	expired := now.Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	old := &GatewayBalance{ExpiresAt: &expired}
	if value, err := integrationParseExpiry(map[string]any{}, old); err != nil || value == nil || *value != expired {
		t.Fatal("omitted expiry discarded previously known expiration")
	}
	for _, raw := range []any{"invalid", 1.5, 1700000000000.0} {
		if _, err := integrationParseExpiry(map[string]any{"expires_at": raw}, nil); err == nil {
			t.Fatalf("invalid expiry accepted: %v", raw)
		}
	}
	credentials := []Credential{{Enabled: true, Balance: &GatewayBalance{Status: "ok", Amount: integrationAmountPointer(0.1)}}, {Enabled: true, Balance: &GatewayBalance{Status: "ok", Amount: integrationAmountPointer(0.2)}}, {Enabled: false, Reason: integrationStringPointer(bbExhaustedReason), Balance: &GatewayBalance{Status: "ok", Amount: integrationAmountPointer(-99)}}, {Enabled: true, Balance: &GatewayBalance{Status: "ok", Amount: integrationAmountPointer(100), ExpiresAt: &expired}}, {Enabled: false, Balance: &GatewayBalance{Status: "ok", Amount: integrationAmountPointer(999)}}}
	summary := credentialBalanceSummary(credentials, now)
	if summary.Amount == nil || *summary.Amount != 0.3 || summary.AvailableKeys != 2 || summary.ExhaustedKeys != 1 || summary.ExpiredKeys != 1 {
		t.Fatalf("incorrect isolated pool summary: %#v", summary)
	}
	tiny := credentialBalanceSummary([]Credential{{Enabled: true, Balance: &GatewayBalance{Status: "ok", Amount: integrationAmountPointer(0.00001)}}}, now)
	if tiny.Amount == nil || *tiny.Amount <= 0 {
		t.Fatal("tiny positive quota rounded to zero")
	}
}

func TestIntegrationNewAPITokenBalanceUsesConfiguredQuotaScale(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/tenant/api/user/self":
			if r.Header.Get("Authorization") != "Bearer admin-token" || r.Header.Get("New-Api-User") != "7" {
				t.Error("missing NewAPI auth")
			}
			integrationTestJSON(w, map[string]any{"success": true, "data": map[string]any{"quota": 12345}})
		case "/tenant/api/status":
			integrationTestJSON(w, map[string]any{"success": true, "data": map[string]any{"quota_per_unit": 1000}})
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	integration := NewIntegrations(nil)
	defer integration.client.CloseIdleConnections()
	channel := Channel{Endpoint: server.URL + "/tenant/v1", Config: ChannelConfig{Integration: "newapi"}}
	amount, unit, _, err := integration.fetchAccountBalance(context.Background(), channel, accountCredentials{Mode: "token", AccessToken: "admin-token", UserID: "7"}, integrationSession{})
	if err != nil {
		t.Fatal(err)
	}
	if amount != 12.345 || unit != "USD" {
		t.Fatalf("incorrect custom quota scale: %v %s", amount, unit)
	}
}

func TestIntegrationSub2APIBrowserSessionFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer browser-token" || r.Header.Get("Cookie") != "session=abc" {
			t.Error("missing browser token and cookie")
		}
		if r.URL.Path == "/api/v1/user/profile" {
			http.NotFound(w, r)
			return
		}
		integrationTestJSON(w, map[string]any{"code": 0, "data": map[string]any{"balance": "0.001"}})
	}))
	defer server.Close()
	integration := NewIntegrations(nil)
	defer integration.client.CloseIdleConnections()
	amount, unit, _, err := integration.fetchAccountBalance(context.Background(), Channel{Endpoint: server.URL, Config: ChannelConfig{Integration: "sub2api"}}, accountCredentials{Mode: "cookie", Cookie: "session=abc", AccessToken: "browser-token"}, integrationSession{})
	if err != nil || amount != 0.001 || unit != "USD" {
		t.Fatalf("browser balance failed: %v %s %v", amount, unit, err)
	}
}

func TestIntegrationNewAPIEncryptedPasswordFormats(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	for _, password := range []string{"short-password", strings.Repeat("密", 100)} {
		encrypted, err := integrationEncryptPassword(password, publicKey, "test-key")
		if err != nil {
			t.Fatal(err)
		}
		var plaintext []byte
		if strings.HasPrefix(encrypted, "v2.") {
			parts := strings.Split(encrypted, ".")
			wrapped, _ := base64.StdEncoding.DecodeString(parts[1])
			secret, err := rsa.DecryptOAEP(sha256.New(), rand.Reader, key, wrapped, []byte("password-v2"))
			if err != nil {
				t.Fatal(err)
			}
			block, _ := aes.NewCipher(secret)
			gcm, _ := cipher.NewGCM(block)
			nonce, _ := base64.StdEncoding.DecodeString(parts[2])
			ciphertext, _ := base64.StdEncoding.DecodeString(parts[3])
			plaintext, err = gcm.Open(nil, nonce, ciphertext, []byte("password-v2:test-key"))
			if err != nil {
				t.Fatal(err)
			}
		} else {
			ciphertext, _ := base64.StdEncoding.DecodeString(encrypted)
			plaintext, err = rsa.DecryptOAEP(sha256.New(), rand.Reader, key, ciphertext, nil)
			if err != nil {
				t.Fatal(err)
			}
		}
		if string(plaintext) != password {
			t.Fatal("encrypted login payload does not round trip")
		}
	}
}

func TestIntegrationClaimNeverPairsNewAccountWithOldDestination(t *testing.T) {
	s := testPostgresStore(t)
	channel := testStoredChannel("account-race")
	channel.Endpoint = "https://old.example.invalid/v1"
	channel.Config.Integration = "newapi"
	if err := s.SaveChannel(context.Background(), channel); err != nil {
		t.Fatal(err)
	}
	integration := NewIntegrations(s)
	defer integration.client.CloseIdleConnections()
	if err := integration.SaveAccount(context.Background(), channel.ID, map[string]any{"accountCredentials": map[string]any{"username": "user", "password": "old-password"}}); err != nil {
		t.Fatal(err)
	}
	writer, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	channel.Endpoint = "https://new.example.invalid/v1"
	if _, err = writer.Exec(`UPDATE channels SET data=$2 WHERE id=$1`, channel.ID, d1JSON(channel)); err != nil {
		t.Fatal(err)
	}
	encrypted, err := s.Encrypt(string(d1JSON(accountCredentials{Username: "user", Password: "new-password", Mode: "password"})))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Exec(`UPDATE gateway_accounts SET secret=$2 WHERE channel_id=$1`, channel.ID, encrypted); err != nil {
		t.Fatal(err)
	}
	type result struct {
		claim *integrationClaim
		err   error
	}
	finished := make(chan result, 1)
	go func() {
		claim, err := s.claimIntegrationAccount(context.Background(), channel.ID, true)
		finished <- result{claim, err}
	}()
	select {
	case got := <-finished:
		t.Fatalf("claim bypassed locked channel edit: %#v %v", got.claim, got.err)
	case <-time.After(75 * time.Millisecond):
	}
	if err = writer.Commit(); err != nil {
		t.Fatal(err)
	}
	got := <-finished
	if got.err != nil || got.claim == nil {
		t.Fatalf("claim failed after edit committed: %#v %v", got.claim, got.err)
	}
	if got.claim.account.Password != "new-password" || got.claim.channel.Endpoint != "https://new.example.invalid/v1" {
		t.Fatalf("new account credential paired with stale destination: %q %q", got.claim.account.Password, got.claim.channel.Endpoint)
	}
}

func TestIntegrationCredentialClaimUsesCurrentDestinationAndSecret(t *testing.T) {
	s := testPostgresStore(t)
	channel := testStoredChannel("credential-race")
	channel.Endpoint = "https://old.example.invalid/v1"
	channel.Config.Integration = "bbdevlab"
	if err := s.SaveChannel(context.Background(), channel); err != nil {
		t.Fatal(err)
	}
	credential := Credential{ID: "key-race", Enabled: true, Secret: "old-secret", CreatedAt: integrationNowString()}
	if err := s.SaveCredential(context.Background(), channel.ID, credential); err != nil {
		t.Fatal(err)
	}
	writer, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback()
	channel.Endpoint = "https://new.example.invalid/v1"
	if _, err = writer.Exec(`UPDATE channels SET data=$2 WHERE id=$1`, channel.ID, d1JSON(channel)); err != nil {
		t.Fatal(err)
	}
	encrypted, err := s.Encrypt("new-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = writer.Exec(`UPDATE credentials SET secret=$2 WHERE id=$1`, credential.ID, encrypted); err != nil {
		t.Fatal(err)
	}
	type result struct {
		claim *integrationClaim
		err   error
	}
	finished := make(chan result, 1)
	go func() {
		claim, err := s.claimIntegrationCredential(context.Background(), channel.ID, credential.ID, true)
		finished <- result{claim, err}
	}()
	select {
	case got := <-finished:
		t.Fatalf("claim bypassed locked channel edit: %#v %v", got.claim, got.err)
	case <-time.After(75 * time.Millisecond):
	}
	if err = writer.Commit(); err != nil {
		t.Fatal(err)
	}
	got := <-finished
	if got.err != nil || got.claim == nil {
		t.Fatalf("claim failed after edit: %#v %v", got.claim, got.err)
	}
	if got.claim.credential.Secret != "new-secret" || got.claim.channel.Endpoint != "https://new.example.invalid/v1" {
		t.Fatal("credential claim paired mismatched snapshots")
	}
}
