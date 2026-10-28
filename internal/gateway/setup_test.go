package gateway

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func applicationTestConfig(t *testing.T) ApplicationConfig {
	t.Helper()
	root := t.TempDir()
	static := filepath.Join(root, "static")
	if err := os.MkdirAll(static, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(static, "index.html"), []byte("<html>setup application</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	return ApplicationConfig{DataDir: filepath.Join(root, "data"), StaticDir: static, Engine: EngineConfig{LogWorkers: 1}}
}

func newTestApplication(t *testing.T, cfg ApplicationConfig) *Application {
	t.Helper()
	application, err := NewApplication(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := application.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return application
}

func setupHTTP(application http.Handler, method, path string, input any) *httptest.ResponseRecorder {
	var body io.Reader
	if input != nil {
		content, _ := json.Marshal(input)
		body = strings.NewReader(string(content))
	}
	request := httptest.NewRequest(method, "http://gateway.test"+path, body)
	if method == "POST" {
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "http://gateway.test")
	}
	response := httptest.NewRecorder()
	application.ServeHTTP(response, request)
	return response
}

func setupInput() setupRequest {
	return setupRequest{AdminPassword: "correct-password-for-setup", ConfirmPassword: "correct-password-for-setup", Database: DatabaseConfiguration{Type: "sqlite"}}
}

func TestApplicationFirstRunServesSetupBeforeAnyDatabaseExists(t *testing.T) {
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	for _, test := range []struct {
		path string
		want int
	}{{"/", 200}, {"/setup", 200}, {"/api/setup", 200}, {"/api/session", 200}, {"/health/live", 200}, {"/health/ready", 503}, {"/api/settings", 503}, {"/v1/models", 503}} {
		response := setupHTTP(application, "GET", test.path, nil)
		if response.Code != test.want {
			t.Errorf("%s: got %d: %s", test.path, response.Code, response.Body.String())
		}
	}
	if _, err := os.Stat(cfg.DataDir); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("first read created data or required a database: %v", err)
	}
	response := setupHTTP(application, "GET", "/api/setup", nil)
	if !strings.Contains(response.Body.String(), `"initialized":false`) || !strings.Contains(response.Body.String(), `"databaseType":"sqlite"`) {
		t.Fatal(response.Body.String())
	}
}

func TestSetupSQLiteLifecyclePersistsPasswordAndSessionAcrossRestart(t *testing.T) {
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	input := setupInput()
	probe := setupHTTP(application, "POST", "/api/setup/test-database", map[string]any{"database": input.Database})
	if probe.Code != 200 {
		t.Fatalf("connection test: %d %s", probe.Code, probe.Body.String())
	}
	// Testing a database connection must never migrate the schema.
	db, err := sql.Open("sqlite", filepath.Join(cfg.DataDir, "pulsegate.db"))
	if err != nil {
		t.Fatal(err)
	}
	var tables int
	err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='schema_migrations'").Scan(&tables)
	db.Close()
	if err != nil || tables != 0 {
		t.Fatalf("connection test changed schema: %d %v", tables, err)
	}
	response := setupHTTP(application, "POST", "/api/setup", input)
	if response.Code != 200 {
		t.Fatalf("initialize: %d %s", response.Code, response.Body.String())
	}
	content, err := os.ReadFile(filepath.Join(cfg.DataDir, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), input.AdminPassword) {
		t.Fatal("administrator password saved in plaintext")
	}
	var saved savedConfiguration
	if json.Unmarshal(content, &saved) != nil || !validSavedConfiguration(saved) || bcrypt.CompareHashAndPassword([]byte(saved.AdminPasswordHash), []byte(input.AdminPassword)) != nil {
		t.Fatal("invalid persisted password/configuration")
	}
	if response = setupHTTP(application, "GET", "/api/setup", nil); response.Body.String() != "{\"initialized\":true}\n" {
		t.Fatalf("initialized setup metadata leaked: %s", response.Body.String())
	}
	for _, path := range []string{"/api/setup", "/api/setup/test-database"} {
		if response = setupHTTP(application, "POST", path, input); response.Code != 409 {
			t.Fatalf("repeat setup accepted: %s %d", path, response.Code)
		}
	}
	if response = setupHTTP(application, "POST", "/api/session", map[string]any{"password": "wrong-password"}); response.Code != 401 {
		t.Fatalf("wrong password accepted: %d", response.Code)
	}
	response = setupHTTP(application, "POST", "/api/session", map[string]any{"password": input.AdminPassword})
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"authMode":"password"`) || !strings.Contains(response.Body.String(), `"databaseType":"sqlite"`) {
		t.Fatalf("password login: %d %s", response.Code, response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("insecure session cookie: %+v", cookies)
	}
	request := httptest.NewRequest("GET", "http://gateway.test/api/settings", nil)
	request.AddCookie(cookies[0])
	authorized := httptest.NewRecorder()
	application.ServeHTTP(authorized, request)
	if authorized.Code != 200 {
		t.Fatalf("cookie authentication failed: %d %s", authorized.Code, authorized.Body.String())
	}
	if response = setupHTTP(application, "GET", "/health/ready", nil); response.Code != 200 {
		t.Fatalf("initialized gateway not ready: %s", response.Body.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := application.Close(ctx); err != nil {
		t.Fatal(err)
	}
	// Constructor startup cancellation must not stop the initialized runtime.
	startup, cancelStartup := context.WithTimeout(context.Background(), 5*time.Second)
	restarted, err := NewApplication(startup, cfg)
	cancelStartup()
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close(ctx)
	request = httptest.NewRequest("GET", "http://gateway.test/api/session", nil)
	request.AddCookie(cookies[0])
	authorized = httptest.NewRecorder()
	restarted.ServeHTTP(authorized, request)
	if authorized.Code != 200 || !strings.Contains(authorized.Body.String(), `"authenticated":true`) {
		t.Fatalf("persisted session lost after restart: %d %s", authorized.Code, authorized.Body.String())
	}
	request = httptest.NewRequest("GET", "http://gateway.test/api/settings", nil)
	request.Header.Set("Authorization", "Bearer "+saved.AdminPasswordHash)
	authorized = httptest.NewRecorder()
	restarted.ServeHTTP(authorized, request)
	if authorized.Code != 401 {
		t.Fatal("password hash accepted as an administration bearer token")
	}
}

func TestSetupConcurrentSubmissionsInitializeExactlyOnce(t *testing.T) {
	application := newTestApplication(t, applicationTestConfig(t))
	start := make(chan struct{})
	statuses := make(chan int, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			statuses <- setupHTTP(application, "POST", "/api/setup", setupInput()).Code
		}()
	}
	close(start)
	workers.Wait()
	close(statuses)
	var got []int
	for status := range statuses {
		got = append(got, status)
	}
	sort.Ints(got)
	if !reflect.DeepEqual(got, []int{200, 409}) {
		t.Fatalf("expected one setup winner: %v", got)
	}
}

func TestSetupFileLockExcludesOtherProcessesAndSurvivesStaleLockFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".setup.lock")
	first, err := lockSetup(path)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := lockSetup(path); err == nil {
		second()
		first()
		t.Fatal("separate file handles acquired the same exclusive setup lock")
	}
	first()
	third, err := lockSetup(path)
	if err != nil {
		t.Fatalf("stale lock file prevented initialization: %v", err)
	}
	third()
}

func TestSetupRejectsCrossOriginAndMalformedCredentialsBeforePersistence(t *testing.T) {
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	for _, change := range []func(*setupRequest){
		func(input *setupRequest) { input.AdminPassword = "short"; input.ConfirmPassword = "short" },
		func(input *setupRequest) {
			input.AdminPassword = strings.Repeat("x", 73)
			input.ConfirmPassword = input.AdminPassword
		},
		func(input *setupRequest) { input.ConfirmPassword = "different-password" },
		func(input *setupRequest) { input.Database.Type = "invalid" },
		func(input *setupRequest) { input.Database.Path = ":memory:" },
		func(input *setupRequest) { input.PublicURL = "https://user:secret@gateway.test" },
	} {
		input := setupInput()
		change(&input)
		response := setupHTTP(application, "POST", "/api/setup", input)
		if response.Code != 400 {
			t.Fatalf("bad setup accepted: %d %s", response.Code, response.Body.String())
		}
	}
	for _, origin := range []string{"", "null", "http://attacker.test", "http://gateway.test/path"} {
		content, _ := json.Marshal(setupInput())
		request := httptest.NewRequest("POST", "http://gateway.test/api/setup", strings.NewReader(string(content)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		application.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("origin %q accepted: %d", origin, response.Code)
		}
	}
	request := httptest.NewRequest("POST", "http://gateway.test/api/setup", strings.NewReader(`{"database":{"type":"sqlite"}}`))
	request.Header.Set("Content-Type", "text/plain")
	request.Header.Set("Origin", "http://gateway.test")
	response := httptest.NewRecorder()
	application.ServeHTTP(response, request)
	if response.Code != 415 {
		t.Fatalf("non-JSON setup accepted: %d", response.Code)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "config.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected setup saved configuration: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "pulsegate.db")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected credentials created database: %v", err)
	}
}

func TestSetupDatabaseFailuresDoNotExposeCredentialsOrCommitConfiguration(t *testing.T) {
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	input := setupInput()
	input.Database = DatabaseConfiguration{Type: "mysql", Host: "127.0.0.1", Port: 1, Name: "unavailable", User: "private-user", Password: "private-database-password"}
	for _, path := range []string{"/api/setup/test-database", "/api/setup"} {
		response := setupHTTP(application, "POST", path, input)
		if response.Code != 400 {
			t.Fatalf("database failure response: %d %s", response.Code, response.Body.String())
		}
		for _, secret := range []string{input.AdminPassword, input.Database.Password, input.Database.User, "mysql://"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatal("database error exposed credentials")
			}
		}
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "config.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed database setup committed configuration: %v", err)
	}
}

func TestSetupAcceptsSameHostHTTPSOriginBehindTLSReverseProxy(t *testing.T) {
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	input := setupInput()
	publicURL := "https://gateway.test:9443"
	content, _ := json.Marshal(input)
	// The proxy has terminated TLS and preserved the external Host header.
	request := httptest.NewRequest("POST", "http://gateway.test:9443/api/setup", strings.NewReader(string(content)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", publicURL)
	response := httptest.NewRecorder()
	application.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("HTTPS reverse proxy setup rejected: %d %s", response.Code, response.Body.String())
	}
	loginBody, _ := json.Marshal(map[string]any{"password": input.AdminPassword})
	request = httptest.NewRequest("POST", "http://gateway.test:9443/api/session", strings.NewReader(string(loginBody)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", publicURL)
	response = httptest.NewRecorder()
	application.ServeHTTP(response, request)
	if response.Code != 200 || len(response.Result().Cookies()) != 1 || !response.Result().Cookies()[0].Secure {
		t.Fatalf("saved public HTTPS origin not enforced for login: %d %s", response.Code, response.Body.String())
	}
}

func TestSetupOriginRequiresExactHostPortAndExplicitPublicURL(t *testing.T) {
	application := newTestApplication(t, applicationTestConfig(t))
	for _, test := range []struct {
		origin, fetchSite string
	}{
		{"https://attacker.test:9443", ""}, {"https://gateway.test:8443", ""}, {"https://gateway.test", ""},
		{"https://gateway.test:9443/path", ""}, {"https://gateway.test:9443?value=x", ""}, {"https://gateway.test:9443?", ""},
		{"https://gateway.test:9443#fragment", ""}, {"https://gateway.test:9443#", ""}, {"https://user:password@gateway.test:9443", ""},
		{"ftp://gateway.test:9443", ""}, {"null", ""}, {"https://gateway.test:9443", "cross-site"},
	} {
		request := httptest.NewRequest("POST", "http://gateway.test:9443/api/setup/test-database", strings.NewReader(`{"database":{"type":"sqlite"}}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", test.origin)
		request.Header.Set("Sec-Fetch-Site", test.fetchSite)
		request.Header.Set("X-Forwarded-Host", "attacker.test:9443")
		request.Header.Set("X-Forwarded-Proto", "https")
		response := httptest.NewRecorder()
		application.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("unsafe setup origin %q/%q accepted: %d", test.origin, test.fetchSite, response.Code)
		}
	}
	cfg := applicationTestConfig(t)
	cfg.PublicURL = "https://configured.test:9443"
	cfg.DevMode = true
	configured := newTestApplication(t, cfg)
	for _, origin := range []string{"http://gateway.test:9443", "https://gateway.test:9443", "http://localhost:9443"} {
		request := httptest.NewRequest("POST", "http://gateway.test:9443/api/setup/test-database", strings.NewReader(`{"database":{"type":"sqlite"}}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		configured.ServeHTTP(response, request)
		if response.Code != 403 {
			t.Fatalf("explicit public URL ignored for origin %q: %d", origin, response.Code)
		}
	}
	request := httptest.NewRequest("POST", "http://gateway.test:9443/api/setup/test-database", strings.NewReader(`{"database":{"type":"sqlite"}}`))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Origin", cfg.PublicURL)
	response := httptest.NewRecorder()
	configured.ServeHTTP(response, request)
	if response.Code != 200 {
		t.Fatalf("configured public origin rejected: %d %s", response.Code, response.Body.String())
	}
}

func TestHTTPOriginNormalizationAndValidation(t *testing.T) {
	for input, want := range map[string]string{
		"http://EXAMPLE.com:00080/":  "http://example.com",
		"https://EXAMPLE.com:00443":  "https://example.com",
		"https://EXAMPLE.com:08787/": "https://example.com:8787",
		"https://[2001:DB8::1]:443":  "https://[2001:db8::1]",
	} {
		got, err := normalizeHTTPOrigin(input)
		if err != nil || got != want {
			t.Fatalf("normalize %q: %q %v", input, got, err)
		}
	}
	for _, input := range []string{"https://user:password@example.com", "https://example.com/path", "https://example.com?query=x", "https://example.com?", "https://example.com#fragment", "https://example.com#", "https://example.com:", "https://example.com:65536", "ftp://example.com"} {
		if _, err := normalizeHTTPOrigin(input); err == nil {
			t.Fatalf("malformed origin accepted: %q", input)
		}
	}
	for _, configured := range []string{"https://GATEWAY.EXAMPLE.COM:00443", "http://GATEWAY.EXAMPLE.COM:00080"} {
		handler := NewHandler(nil, nil, nil, HTTPConfig{PublicURL: configured})
		canonical, _ := normalizeHTTPOrigin(configured)
		request := httptest.NewRequest("POST", canonical+"/api/settings", nil)
		request.Header.Set("Origin", canonical)
		if err := handler.origin(request); err != nil {
			t.Fatalf("canonical browser origin rejected for %q: %v", configured, err)
		}
	}
}

func TestSetupCanonicalPublicURLAllowsPasswordLoginAndRestart(t *testing.T) {
	for _, source := range []string{"setup", "environment"} {
		t.Run(source, func(t *testing.T) {
			cfg := applicationTestConfig(t)
			input := setupInput()
			if source == "setup" {
				input.PublicURL = "https://GATEWAY.EXAMPLE.COM:00443"
			} else {
				cfg.PublicURL = "https://GATEWAY.EXAMPLE.COM:00443"
			}
			application := newTestApplication(t, cfg)
			call := func(application http.Handler, path string, body any) *httptest.ResponseRecorder {
				content, _ := json.Marshal(body)
				request := httptest.NewRequest("POST", "http://gateway.example.com"+path, strings.NewReader(string(content)))
				request.Header.Set("Content-Type", "application/json")
				request.Header.Set("Origin", "https://gateway.example.com")
				response := httptest.NewRecorder()
				application.ServeHTTP(response, request)
				return response
			}
			if response := call(application, "/api/setup", input); response.Code != 200 {
				t.Fatalf("canonical URL setup: %d %s", response.Code, response.Body.String())
			}
			if response := call(application, "/api/session", map[string]any{"password": input.AdminPassword}); response.Code != 200 {
				t.Fatalf("canonical URL login: %d %s", response.Code, response.Body.String())
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := application.Close(ctx); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(cfg.DataDir, "config.json")
			content, _ := os.ReadFile(path)
			var saved savedConfiguration
			if err := json.Unmarshal(content, &saved); err != nil || saved.PublicURL != "https://gateway.example.com" {
				t.Fatalf("noncanonical persisted URL: %q %v", saved.PublicURL, err)
			}
			// Older saved files may contain an unnormalized origin too.
			saved.PublicURL = "https://GATEWAY.EXAMPLE.COM:00443"
			content, _ = json.Marshal(saved)
			if err := os.WriteFile(path, content, 0600); err != nil {
				t.Fatal(err)
			}
			cfg.PublicURL = ""
			restarted := newTestApplication(t, cfg)
			if response := call(restarted, "/api/session", map[string]any{"password": input.AdminPassword}); response.Code != 200 {
				t.Fatalf("canonical saved URL restart login: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestSavedConfigurationCannotBeOverwrittenOrReopenedAsFirstRun(t *testing.T) {
	cfg := applicationTestConfig(t)
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(cfg.DataDir, "config.json")
	if err := os.WriteFile(path, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if application, err := NewApplication(context.Background(), cfg); err == nil {
		application.Close(context.Background())
		t.Fatal("invalid existing configuration reopened unauthenticated setup")
	}
	if err := persistConfiguration(path, savedConfiguration{Version: 1}); err == nil {
		t.Fatal("existing configuration overwritten")
	}
	content, _ := os.ReadFile(path)
	if string(content) != "{}" {
		t.Fatal("existing configuration was modified")
	}
}

func TestApplicationLegacyEnvironmentSkipsSetup(t *testing.T) {
	cfg := applicationTestConfig(t)
	cfg.DatabaseURL = "sqlite:" + filepath.Join(t.TempDir(), "legacy.db")
	cfg.AdminToken = "legacy-administrator-token-at-least-24"
	cfg.EncryptionKey = base64.StdEncoding.EncodeToString(make([]byte, 32))
	application := newTestApplication(t, cfg)
	if response := setupHTTP(application, "GET", "/api/setup", nil); !strings.Contains(response.Body.String(), `"initialized":true`) {
		t.Fatalf("legacy installation reopened setup: %s", response.Body.String())
	}
	if response := setupHTTP(application, "POST", "/api/session", map[string]any{"token": cfg.AdminToken}); response.Code != 200 || !strings.Contains(response.Body.String(), `"authMode":"token"`) {
		t.Fatalf("legacy token login broken: %d %s", response.Code, response.Body.String())
	}
}

func TestPersistedConfigurationWinsLegacyEnvironmentAndBrokenDatabaseNeverReopensSetup(t *testing.T) {
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	if response := setupHTTP(application, "POST", "/api/setup", setupInput()); response.Code != 200 {
		t.Fatalf("setup failed: %s", response.Body.String())
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := application.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	cfg.DatabaseURL, cfg.AdminToken, cfg.EncryptionKey = "not-a-valid-url", "an-environment-token-at-least-24", "wrong-environment-key"
	restored := newTestApplication(t, cfg)
	if response := setupHTTP(restored, "POST", "/api/session", map[string]any{"password": setupInput().AdminPassword}); response.Code != 200 {
		t.Fatalf("saved password did not override environment: %d %s", response.Code, response.Body.String())
	}
	if response := setupHTTP(restored, "POST", "/api/session", map[string]any{"token": cfg.AdminToken}); response.Code != 401 {
		t.Fatal("environment token overrode saved administrator password")
	}
	if err := restored.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(cfg.DataDir, "config.json")
	content, _ := os.ReadFile(path)
	var saved savedConfiguration
	if err := json.Unmarshal(content, &saved); err != nil {
		t.Fatal(err)
	}
	// Existing directory cannot be opened as a SQLite database.
	saved.Database.Path = cfg.DataDir
	content, _ = json.Marshal(saved)
	if err := os.WriteFile(path, content, 0600); err != nil {
		t.Fatal(err)
	}
	if unexpected, err := NewApplication(context.Background(), cfg); err == nil {
		unexpected.Close(context.Background())
		t.Fatal("unavailable saved database reopened setup or fell back to legacy environment")
	}
	if _, err := OpenConfiguredStore(context.Background(), cfg.DataDir); err == nil {
		t.Fatal("maintenance command accepted unavailable saved database")
	}
	if after, _ := os.ReadFile(path); string(after) != string(content) {
		t.Fatal("failed startup changed saved configuration")
	}
}

func TestConfiguredStoreImportsAndReencryptsD1SecretsWithIndependentWizardKey(t *testing.T) {
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	if response := setupHTTP(application, "POST", "/api/setup", setupInput()); response.Code != 200 {
		t.Fatalf("setup failed: %s", response.Body.String())
	}
	login := setupHTTP(application, "POST", "/api/session", map[string]any{"password": setupInput().AdminPassword})
	if login.Code != 200 {
		t.Fatalf("installer login failed: %s", login.Body.String())
	}
	cookie := login.Result().Cookies()[0]
	closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := application.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
	target, err := OpenConfiguredStore(context.Background(), cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	source := testMemoryStore(t)
	snapshot := d1TestSnapshot(t, source)
	original := string(d1JSON(snapshot))
	if _, err := target.ImportD1WithSourceKey(context.Background(), snapshot, base64.StdEncoding.EncodeToString([]byte(strings.Repeat("x", 32)))); err == nil {
		t.Fatal("wrong source encryption key was accepted")
	}
	var count int
	if err := target.DB().QueryRow("SELECT count(*) FROM channels").Scan(&count); err != nil || count != 0 {
		t.Fatalf("wrong source key wrote partial migration rows: %d %v", count, err)
	}
	if _, err := target.ImportD1WithSourceKey(context.Background(), snapshot, base64.StdEncoding.EncodeToString(make([]byte, 32))); err != nil {
		t.Fatal(err)
	}
	if string(d1JSON(snapshot)) != original {
		t.Fatal("source migration snapshot was modified")
	}
	credentials, err := target.Credentials(context.Background(), "bb", true)
	if err != nil || len(credentials) != 1 || credentials[0].Secret != "sk-original-inference-secret" {
		t.Fatalf("source inference key was not reencrypted: %#v %v", credentials, err)
	}
	var cipherText string
	if err := target.DB().QueryRow(`SELECT secret FROM gateway_accounts WHERE channel_id='newapi'`).Scan(&cipherText); err != nil {
		t.Fatal(err)
	}
	plain, err := target.Decrypt(cipherText)
	if err != nil || !strings.Contains(plain, `"password":"original-password"`) {
		t.Fatalf("source account was not reencrypted: %v", err)
	}
	if _, err := source.Decrypt(cipherText); err == nil {
		t.Fatal("imported account still used the old source encryption key")
	}
	if err := target.DB().QueryRow("SELECT count(*) FROM gateway_state WHERE id=$1", "session:"+tokenHash(cookie.Value)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("new installation session removed by import: %d %v", count, err)
	}
}

func TestNormalizeDatabasePreservesCredentialsAndSeparatesTLSModes(t *testing.T) {
	password := `p@ss:/?#%&!\word`
	for _, test := range []struct{ database, ssl, key, want string }{
		{"pgsql", "require", "sslmode", "require"}, {"pgsql", "verify-full", "sslmode", "verify-full"},
		{"mysql", "disable", "tls", "false"}, {"mysql", "require", "tls", "skip-verify"}, {"mysql", "verify-full", "tls", "true"},
	} {
		_, dsn, err := normalizeDatabase(DatabaseConfiguration{Type: test.database, Host: "::1", Name: "pulsegate", User: "test@user", Password: password, SSLMode: test.ssl}, "data")
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		got, _ := parsed.User.Password()
		if got != password || parsed.User.Username() != "test@user" || parsed.Query().Get(test.key) != test.want {
			t.Fatalf("credentials or TLS lost from %s: %s", test.database, dsn)
		}
	}
}

func TestSetupExternalDatabasePasswordLifecycle(t *testing.T) {
	for _, test := range []struct{ kind, environment string }{{"mysql", "TEST_MYSQL_URL"}, {"pgsql", "TEST_DATABASE_URL"}} {
		t.Run(test.kind, func(t *testing.T) {
			dsn := os.Getenv(test.environment)
			if dsn == "" {
				t.Skip(test.environment + " is not set")
			}
			parsed, err := url.Parse(dsn)
			if err != nil {
				t.Fatal(err)
			}
			admin, err := openDatabase(dsn)
			if err != nil {
				t.Fatal(err)
			}
			database := fmt.Sprintf("pulsegate_setup_%d", time.Now().UnixNano())
			if _, err := admin.ExecContext(context.Background(), "CREATE DATABASE "+database); err != nil {
				admin.Close()
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := admin.ExecContext(context.Background(), "DROP DATABASE "+database); err != nil {
					t.Error(err)
				}
				admin.Close()
			})
			port, _ := strconv.Atoi(parsed.Port())
			password, _ := parsed.User.Password()
			cfg := applicationTestConfig(t)
			application := newTestApplication(t, cfg)
			input := setupInput()
			input.Database = DatabaseConfiguration{Type: test.kind, Host: parsed.Hostname(), Port: port, Name: database, User: parsed.User.Username(), Password: password, SSLMode: "disable"}
			if probe := setupHTTP(application, "POST", "/api/setup/test-database", map[string]any{"database": input.Database}); probe.Code != 200 {
				t.Fatalf("connection test failed: %d %s", probe.Code, probe.Body.String())
			}
			if response := setupHTTP(application, "POST", "/api/setup", input); response.Code != 200 {
				t.Fatalf("database setup failed: %d %s", response.Code, response.Body.String())
			}
			login := setupHTTP(application, "POST", "/api/session", map[string]any{"password": input.AdminPassword})
			if login.Code != 200 {
				t.Fatalf("password login failed: %d %s", login.Code, login.Body.String())
			}
			request := httptest.NewRequest("GET", "http://gateway.test/api/session", nil)
			request.AddCookie(login.Result().Cookies()[0])
			response := httptest.NewRecorder()
			application.ServeHTTP(response, request)
			if response.Code != 200 || !strings.Contains(response.Body.String(), `"authenticated":true`) || !strings.Contains(response.Body.String(), `"databaseType":"`+test.kind+`"`) {
				t.Fatalf("cookie login failed: %d %s", response.Code, response.Body.String())
			}
		})
	}
}
