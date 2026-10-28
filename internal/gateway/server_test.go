package gateway

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestManagementReadBodyRejectsMalformedAndOversizedInput(t *testing.T) {
	for _, body := range []string{"null", "[]", "true", `{"ok":true}{"another":true}`, `{"ok":true} trailing`, `{"broken":`} {
		request := httptest.NewRequest(http.MethodPost, "/api/channels", strings.NewReader(body))
		if _, err := readBody(httptest.NewRecorder(), request, 1000); err == nil {
			t.Fatalf("malformed body accepted: %s", body)
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/channels", strings.NewReader(`{"value":"`+strings.Repeat("x", 100)+`"}`))
	_, err := readBody(httptest.NewRecorder(), request, 32)
	var status interface{ StatusCode() int }
	if !errors.As(err, &status) || status.StatusCode() != 413 {
		t.Fatalf("oversized request expected 413, got %v", err)
	}
	request = httptest.NewRequest(http.MethodPost, "/api/channels", strings.NewReader("{\"ok\":true}\n\t"))
	if _, err := readBody(httptest.NewRecorder(), request, 1000); err != nil {
		t.Fatalf("valid trailing whitespace rejected: %v", err)
	}
}

func managementChannelDraft() map[string]any {
	return map[string]any{"name": "Test", "endpoint": "https://example.invalid/v1", "models": []string{"first"}}
}
func TestManagementChannelPatchPreservesReadOnlyFieldsAndSelectsNewPrimary(t *testing.T) {
	if channel, err := newChannel(map[string]any{"name": "Model only", "endpoint": "https://example.invalid/v1", "model": "single"}, nil, false); err != nil || len(channel.Models) != 1 || channel.Models[0] != "single" {
		t.Fatalf("legacy model-only channel rejected: %#v %v", channel, err)
	}
	channel, err := newChannel(managementChannelDraft(), nil, false)
	if err != nil {
		t.Fatal(err)
	}
	channel.Requests = 42
	channel.Status = "offline"
	channel.Health.FailureCount = 3
	changed, err := newChannel(map[string]any{"id": "attacker-id", "requests": 0, "status": "healthy", "hasAccountCredentials": true, "models": []string{"new", " new "}, "tags": []string{" x ", "x"}, "ignored": true}, &channel, false)
	if err != nil {
		t.Fatal(err)
	}
	if changed.ID != channel.ID || changed.Requests != 42 || changed.Status != "offline" || changed.Health.FailureCount != 3 || changed.HasAccountCredentials {
		t.Fatalf("read-only fields modified: %#v", changed)
	}
	if changed.Model != "new" || !reflect.DeepEqual(changed.Models, []string{"new"}) || !reflect.DeepEqual(changed.Tags, []string{"x"}) {
		t.Fatalf("model/tag normalization differs from editor: %#v", changed)
	}
}

func TestManagementValidationRejectsNullConfigurationAndPlaintextSecrets(t *testing.T) {
	for _, patch := range []map[string]any{
		{"enabled": nil}, {"config": nil}, {"config": map[string]any{"headers": nil}}, {"config": map[string]any{"headers": map[string]any{"X-Value": nil}}}, {"config": map[string]any{"aliases": []any{nil}}},
		{"config": map[string]any{"aliases": []any{map[string]any{"from": "", "to": "model"}}}},
		{"config": map[string]any{"headers": map[string]any{"X-Custom": "Bearer secret-value"}}},
		{"config": map[string]any{"bodyOverrides": map[string]any{"metadata": []any{map[string]any{"access_token": "sensitive"}}}}},
		{"config": map[string]any{"bodyOverrides": map[string]any{"metadata": "sk-abcdefghijklmnopqrstuvwxyz"}}},
		{"config": map[string]any{"bodyOverrides": map[string]any{"stream": true}}},
		{"config": map[string]any{"bodyOverrides": map[string]any{"metadata": strings.Repeat("x", 32001)}}},
		{"endpoint": "https://user:password@example.invalid/v1"}, {"endpoint": "https://example.invalid/v1?secret=abc"},
	} {
		draft := managementChannelDraft()
		for key, value := range patch {
			draft[key] = value
		}
		if _, err := newChannel(draft, nil, false); err == nil {
			encoded, _ := json.Marshal(patch)
			t.Fatalf("invalid channel patch accepted: %s", encoded)
		}
	}
	draft := managementChannelDraft()
	draft["config"] = map[string]any{"bodyOverrides": map[string]any{"metadata": nil, "temperature": 0.5}}
	if _, err := newChannel(draft, nil, false); err != nil {
		t.Fatalf("ordinary JSON null inside request overrides rejected: %v", err)
	}
}

func TestManagementAPIKeyValidationCannotWidenMalformedOrRevokedProfiles(t *testing.T) {
	for _, profiles := range []any{nil, []any{nil}, []any{map[string]any{"scope": nil}}, []any{map[string]any{"scope": "channels", "channelIds": []any{nil}}}, []any{map[string]any{"scope": "all", "requestLimit": "9007199254740992"}}, []any{map[string]any{"mappings": []any{map[string]any{"from": "entry", "to": []string{"a"}}, map[string]any{"from": "entry", "to": []string{"b"}}}}}} {
		if _, err := newAPIKey(map[string]any{"name": "Test", "profiles": profiles}, nil); err == nil {
			encoded, _ := json.Marshal(profiles)
			t.Fatalf("malformed profiles accepted: %s", encoded)
		}
	}
	key, err := newAPIKey(map[string]any{"name": "Test", "profiles": []any{map[string]any{"scope": "channels", "channelIds": []string{"a"}, "modelMode": "selected", "models": []string{"target"}, "mappings": []any{map[string]any{"from": "entry", "to": []string{"target"}}}}}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	key.TokenHash = "original-hash"
	updated, err := newAPIKey(map[string]any{"name": "Updated", "id": "replace", "tokenHash": "replace", "used": 999}, &key)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ID != key.ID || updated.TokenHash != "original-hash" || updated.Used != key.Used {
		t.Fatal("untrusted patch modified immutable key fields")
	}
	key.Status = "revoked"
	if _, err := newAPIKey(map[string]any{"status": "active"}, &key); err == nil {
		t.Fatal("revoked key revived through PATCH")
	}
}

func TestManagementSettingsPreserveFractionalSeconds(t *testing.T) {
	patch := map[string]any{"threshold": 0.001, "responseThreshold": 0.125, "streamFirstTokenTimeout": 0.5, "nonStreamTimeout": 2.75, "cooldown": 1.5, "autoDisableCooldown": 1.25}
	settings, err := validateSettings(patch, DefaultSettings())
	if err != nil {
		t.Fatalf("fractional second settings rejected: %v", err)
	}
	encoded, _ := json.Marshal(settings)
	var actual map[string]any
	_ = json.Unmarshal(encoded, &actual)
	for key, value := range patch {
		if actual[key] != value {
			t.Fatalf("fractional setting lost: %s=%v expected %v", key, actual[key], value)
		}
	}
	for _, invalid := range []map[string]any{{"threshold": nil}, {"retryEnabled": nil}, {"threshold": 0.0}, {"samples": 21, "window": 20}, {"maxChannelRetries": 1.5}, {"customErrorMessage": strings.Repeat("x", 2001)}} {
		if _, err := validateSettings(invalid, DefaultSettings()); err == nil {
			t.Fatalf("invalid settings accepted: %#v", invalid)
		}
	}
}

func TestManagementOriginRequiresSameOriginForCookieAuthentication(t *testing.T) {
	handler := NewHandler(nil, nil, nil, HTTPConfig{AdminToken: "correct-token", PublicURL: "https://gateway.example"})
	for _, test := range []struct {
		origin, bearer string
		allowed        bool
	}{{"https://gateway.example", "", true}, {"https://attacker.example", "", false}, {"", "", false}, {"https://attacker.example", "fake", false}, {"https://attacker.example", "correct-token", true}, {"null", "", false}, {"https://gateway.example/path", "", false}} {
		request := httptest.NewRequest(http.MethodPatch, "https://gateway.example/api/settings", nil)
		request.AddCookie(&http.Cookie{Name: "pg_session", Value: "session"})
		if test.origin != "" {
			request.Header.Set("Origin", test.origin)
		}
		if test.bearer != "" {
			request.Header.Set("Authorization", "Bearer "+test.bearer)
		}
		if (handler.origin(request) == nil) != test.allowed {
			t.Fatalf("origin=%q bearer=%q allowed=%v", test.origin, test.bearer, test.allowed)
		}
	}
}

func TestManagementVisibleModelsRespectsScopeAndMappedTargets(t *testing.T) {
	config := DefaultChannelConfig()
	config.Aliases = []ModelAlias{{From: "alias", To: "physical"}}
	channels := []Channel{{ID: "a", Enabled: true, Tags: []string{"team", "prod"}, Models: []string{"physical", "private"}, Config: config}, {ID: "b", Enabled: true, Tags: []string{"other"}, Models: []string{"foreign"}, Config: DefaultChannelConfig()}, {ID: "c", Enabled: false, Tags: []string{"team"}, Models: []string{"disabled"}, Config: DefaultChannelConfig()}, {ID: "d", Enabled: true, Archived: true, Tags: []string{"team"}, Models: []string{"archived"}, Config: DefaultChannelConfig()}}
	profile := KeyProfile{ID: "p", Scope: "tags", Tags: []string{"team", "prod"}, Match: "all", ModelMode: "selected", Models: []string{"alias"}, Mappings: []ModelMapping{{From: "entry", To: []string{"foreign", "alias"}}, {From: "hidden", To: []string{"foreign"}}}}
	key := APIKey{ActiveProfile: "p", Profiles: []KeyProfile{profile}}
	if got := visibleModels(channels, key); !reflect.DeepEqual(got, []string{"alias", "entry"}) {
		t.Fatalf("scope or model mapping leaked: %v", got)
	}
	key.ActiveProfile = "missing"
	if got := visibleModels(channels, key); len(got) != 0 {
		t.Fatalf("invalid active profile exposed models: %v", got)
	}
}

func TestManagementDateOnlyExpiryIsInclusiveInBeijing(t *testing.T) {
	key := APIKey{Expires: "2026-10-28"}
	before, _ := time.Parse(time.RFC3339Nano, "2026-10-28T15:59:59.998Z")
	at, _ := time.Parse(time.RFC3339Nano, "2026-10-28T15:59:59.999Z")
	if keyExpiredAt(key, before) {
		t.Fatal("date-only key expired before end of selected Beijing date")
	}
	if !keyExpiredAt(key, at) {
		t.Fatal("date-only key remained valid past selected Beijing date")
	}
}

func TestManagementUnauthorizedRouteReturnsStructuredJSON(t *testing.T) {
	handler := NewHandler(nil, nil, nil, HTTPConfig{AdminToken: "correct-token"})
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized || recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unauthorized response: %d", recorder.Code)
	}
	var body map[string]any
	if json.Unmarshal(recorder.Body.Bytes(), &body) != nil || body["error"] == nil {
		t.Fatalf("missing frontend error envelope: %s", recorder.Body.String())
	}
}
