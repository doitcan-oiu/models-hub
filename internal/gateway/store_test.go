package gateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func testMemoryStore(t *testing.T) *Store {
	t.Helper()
	block, err := aes.NewCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	return &Store{aead: aead, cache: map[string]cacheEntry{}, flights: map[string]*cacheFlight{}}
}

func TestCredentialEncryptionAndJSONSecrecy(t *testing.T) {
	s := testMemoryStore(t)
	secret := "sk-example-private-secret"
	encrypted, err := s.Encrypt(secret)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(encrypted, ":")
	if len(parts) != 3 || parts[0] != "v1" || strings.Contains(encrypted, secret) {
		t.Fatal("invalid encrypted format")
	}
	nonce, _ := base64.StdEncoding.DecodeString(parts[1])
	if len(nonce) != 12 {
		t.Fatal("AES-GCM nonce must match existing Worker format")
	}
	decoded, err := s.Decrypt(encrypted)
	if err != nil || decoded != secret {
		t.Fatalf("decrypt: %q %v", decoded, err)
	}
	ciphertext, _ := base64.StdEncoding.DecodeString(parts[2])
	ciphertext[0] ^= 1
	parts[2] = base64.StdEncoding.EncodeToString(ciphertext)
	if _, err = s.Decrypt(strings.Join(parts, ":")); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
	for _, value := range []any{Credential{Secret: secret}, APIKey{TokenHash: secret}} {
		data, _ := json.Marshal(value)
		if strings.Contains(string(data), secret) {
			t.Fatal("secret exposed in public JSON")
		}
	}
}

func TestCacheSingleFlightAndInvalidation(t *testing.T) {
	s := testMemoryStore(t)
	var calls atomic.Int32
	start := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = s.cached(context.Background(), "channels", func() (any, error) {
			if calls.Add(1) == 1 {
				close(start)
				<-release
				return "old", nil
			}
			return "new", nil
		})
	}()
	<-start
	s.InvalidateCache()
	close(release)
	<-done
	v, err := s.cached(context.Background(), "channels", func() (any, error) { calls.Add(1); return "new", nil })
	if err != nil || v != "new" {
		t.Fatalf("stale load survived invalidation: %v %v", v, err)
	}
	var wg sync.WaitGroup
	for n := 0; n < 100; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := s.cached(context.Background(), "channels", func() (any, error) { calls.Add(1); return "unexpected", nil })
			if err != nil || v != "new" {
				t.Errorf("cache = %v, %v", v, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 2 {
		t.Fatalf("cache loaded %d times", calls.Load())
	}
}

func TestStoredKeyExpiryShanghaiAndRedaction(t *testing.T) {
	deadline := time.Date(2026, 10, 28, 16, 0, 0, 0, time.UTC)
	key := APIKey{Expires: "2026-10-28"}
	if !storedKeyExpired(key, deadline) || storedKeyExpired(key, deadline.Add(-time.Second)) {
		t.Fatal("date expiry must use Asia/Shanghai end of day")
	}
	key.Expires = "invalid"
	if !storedKeyExpired(key, deadline) {
		t.Fatal("invalid expiry must fail closed")
	}
	value := redactText(`Bearer pg_live_abcdefghijklmnopqrstuvwxyz https://example.com?api_key=hidden "password":"private"`)
	if strings.Contains(value, "abcdefghijklmnopqrstuvwxyz") || strings.Contains(value, "hidden") || strings.Contains(value, "private") {
		t.Fatal("log credential redaction failed")
	}
}

// TEST_DATABASE_URL points at a disposable PostgreSQL database. Every test run
// owns a random schema; it never truncates or modifies existing application data.
func testPostgresStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	var random [8]byte
	if _, err = rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	schema := "pulsegate_test_" + hex.EncodeToString(random[:])
	if _, err = admin.ExecContext(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	s, err := NewStore(context.Background(), u.String(), base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		_, _ = admin.Exec("DROP SCHEMA " + schema + " CASCADE")
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = s.Close()
		_, err := admin.ExecContext(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		if err != nil {
			t.Error(err)
		}
		_ = admin.Close()
	})
	return s
}
func testStoredChannel(id string) Channel {
	return Channel{ID: id, Name: id, Enabled: true, Models: []string{"test-model"}, Tags: []string{}, History: []int{}, Status: "healthy", Config: DefaultChannelConfig(), CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), DisplayMultiplier: 1}
}
func testStoredKey(id, token string, limit string) APIKey {
	return APIKey{ID: id, Name: id, TokenHash: HashToken(token), Status: "active", Expires: "never", ActiveProfile: "default", Profiles: []KeyProfile{{ID: "default", Scope: "all", RequestLimit: limit, Tags: []string{}}}, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
}

func TestPostgresAtomicBundleAndEncryptedCredentials(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	channel := testStoredChannel("channel")
	err := s.SaveChannelBundle(ctx, channel, []Credential{{ID: "key", Enabled: true, Secret: "private-upstream-secret"}}, []Credential{{ID: "missing", Label: "missing"}}, nil)
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("bundle should fail: %v", err)
	}
	if _, err = s.Channel(ctx, channel.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("failed bundle partially committed channel")
	}
	if err = s.SaveChannelBundle(ctx, channel, []Credential{{ID: "key", Enabled: true, Secret: "private-upstream-secret"}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	creds, err := s.Credentials(ctx, channel.ID, false)
	if err != nil || len(creds) != 1 || creds[0].Secret != "private-upstream-secret" {
		t.Fatalf("credentials: %v %v", creds, err)
	}
	var ciphertext string
	if err = s.db.QueryRow("SELECT secret FROM credentials WHERE id='key'").Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if ciphertext == creds[0].Secret {
		t.Fatal("plaintext credential at rest")
	}
	reason := "HTTP 503"
	if err = s.UpdateHealth(ctx, channel.ID, Health{FailureCount: 3, Reason: &reason}, "offline"); err != nil {
		t.Fatal(err)
	}
	channel.Name = "edited"
	if err = s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Channel(ctx, channel.ID)
	if err != nil || saved.Health.FailureCount != 3 || saved.Status != "offline" || saved.Name != "edited" {
		t.Fatalf("config edit overwrote runtime health: %+v %v", saved, err)
	}
}

func TestPostgresConcurrentQuotaAndDisable(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	key := testStoredKey("key", "test-token", "17")
	if err := s.SaveKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.FindKey(ctx, "test-token"); err != nil {
		t.Fatal(err)
	}
	var used atomic.Int32
	var wg sync.WaitGroup
	for n := 0; n < 80; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := s.ConsumeKey(ctx, key.ID, "default", 9999)
			if err != nil {
				t.Error(err)
			}
			if ok {
				used.Add(1)
			}
		}()
	}
	wg.Wait()
	if used.Load() != 17 {
		t.Fatalf("quota oversubscribed/underused: %d", used.Load())
	}
	saved, err := s.Key(ctx, key.ID)
	if err != nil || saved.Used != 17 {
		t.Fatalf("stored usage: %d %v", saved.Used, err)
	}
	saved.Status = "disabled"
	if err = s.SaveKey(ctx, saved); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.ConsumeKey(ctx, key.ID, "default", 0); err != nil || ok {
		t.Fatalf("disabled key consumed quota: %v %v", ok, err)
	}
}

func TestPostgresDefaultKeyAuthenticatesEngine(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	key, err := newAPIKey(map[string]any{"name": "default auth"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	key.TokenHash = HashToken("default-auth-token")
	if err = s.SaveKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	found, err := s.FindKey(ctx, "default-auth-token")
	if err != nil {
		t.Fatal(err)
	}
	if found.Status != "active" || currentEngineProfile(&found) == nil || engineExpired(found.Expires) {
		t.Fatalf("default key rejected by engine: %+v profile=%+v expired=%v", found, currentEngineProfile(&found), engineExpired(found.Expires))
	}
}

func TestPostgresConcurrentChannelRateLimit(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	channel := testStoredChannel("limited")
	channel.Config.RateLimit = RateLimit{RequestsPerMinute: 7, TokensPerMinute: 20}
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for n := 0; n < 50; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := s.ReserveChannel(ctx, channel, 3)
			if err != nil {
				t.Error(err)
			}
			if ok {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 6 {
		t.Fatalf("expected six reservations within token limit, got %d", accepted.Load())
	}
}

func TestPostgresTagsAndAtomicBulk(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	channel := testStoredChannel("tagged")
	channel.Tags = []string{"old"}
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	key := testStoredKey("key", "token", "0")
	key.Profiles[0].Scope = "tags"
	key.Profiles[0].Tags = []string{"old"}
	if err := s.SaveKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := s.RenameTag(ctx, "old", "new"); err != nil {
		t.Fatal(err)
	}
	key, err := s.Key(ctx, key.ID)
	if err != nil || key.Profiles[0].Tags[0] != "new" {
		t.Fatalf("tag rename did not update scope: %v %v", key, err)
	}
	if err = s.DeleteTag(ctx, "new"); !errors.Is(err, ErrConflict) {
		t.Fatalf("referenced tag deleted: %v", err)
	}
	if err = s.BulkKeys(ctx, []string{key.ID, "missing"}, "disable"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing key in bulk: %v", err)
	}
	key, err = s.Key(ctx, key.ID)
	if err != nil || key.Status != "active" {
		t.Fatal("bulk update partially committed")
	}
	key.Status = "revoked"
	if err = s.SaveKey(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteTag(ctx, "new"); err != nil {
		t.Fatal(err)
	}
	channel, err = s.Channel(ctx, channel.ID)
	if err != nil || len(channel.Tags) != 0 {
		t.Fatalf("tag removal from channels failed: %v %v", channel.Tags, err)
	}
}

func TestPostgresLogIdempotencyAndCascade(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	problem := "Bearer secret-upstream-token"
	log := RequestLog{ID: "request", CreatedAt: now, Result: "error", Source: "api", Error: &problem}
	attempt := Attempt{ID: "attempt", RequestID: log.ID, ChannelID: "deleted-channel", StartedAt: now, Result: "error", Error: &problem}
	for n := 0; n < 2; n++ {
		if err := s.Record(ctx, log, []Attempt{attempt}); err != nil {
			t.Fatal(err)
		}
	}
	saved, attempts, err := s.Log(ctx, log.ID)
	if err != nil || len(attempts) != 1 || saved.Error == nil || strings.Contains(*saved.Error, "secret-upstream-token") {
		t.Fatalf("logs: %+v %d %v", saved, len(attempts), err)
	}
	if err = s.ClearLogs(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.db.QueryRow("SELECT count(*) FROM attempts").Scan(&count); err != nil || count != 0 {
		t.Fatalf("clear did not cascade: %d %v", count, err)
	}
}

func TestPostgresHealthResetRejectsLateDecisionsAndCountsAttempts(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	channel := testStoredChannel("health")
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	started := time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	if err := s.ResetHealth(ctx, channel.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.UpdateHealthAfter(ctx, channel.ID, Health{FailureCount: 100}, "offline", started); err != nil {
		t.Fatal(err)
	}
	s.InvalidateCache()
	saved, err := s.Channel(ctx, channel.ID)
	if err != nil || saved.Health.FailureCount != 0 || saved.Status != "healthy" {
		t.Fatalf("late health decision undid reset: %+v %v", saved, err)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	ttft := .123
	log := RequestLog{ID: "counted", CreatedAt: now, Result: "success", Source: "api"}
	attempt := Attempt{ID: "counted-attempt", RequestID: log.ID, ChannelID: channel.ID, StartedAt: now, Result: "success", TTFT: &ttft}
	if err = s.Record(ctx, log, []Attempt{attempt}); err != nil {
		t.Fatal(err)
	}
	s.InvalidateCache()
	saved, err = s.Channel(ctx, channel.ID)
	if err != nil || saved.Requests != 1 || saved.TTFT != ttft || saved.SuccessRate != 100 || len(saved.History) != 1 || saved.History[0] != 0 {
		t.Fatalf("runtime counters not updated: %+v %v", saved, err)
	}
}
