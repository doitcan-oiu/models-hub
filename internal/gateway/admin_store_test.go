package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestPostgresManagedImportAndAccountEditsRollbackTogether(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	h := &Handler{store: s}
	first := testStoredChannel("first")
	first.Tags = []string{"must-rollback"}
	first.Config.Integration = "newapi"
	first.Endpoint = "https://old.test"
	bundle, err := h.prepareAccountBundle(first, map[string]any{"accountCredentials": map[string]any{"accessToken": "first-account-token"}})
	if err != nil {
		t.Fatal(err)
	}
	bundle.adds = []Credential{{ID: "first-key", Secret: "first-upstream-key", Enabled: true}}
	second := testStoredChannel("second")
	second.Config.Integration = "newapi"
	if err = s.saveManagedBundles(ctx, []managedBundle{bundle, {channel: second, adds: []Credential{{ID: "second-key", Secret: "second-secret", Enabled: true}}}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("late invalid account should roll back import: %v", err)
	}
	for _, table := range []string{"channels", "credentials", "gateway_accounts", "tags"} {
		var count int
		if err = s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s partially committed: %d %v", table, count, err)
		}
	}
	if err = s.saveManagedBundles(ctx, []managedBundle{bundle}); err != nil {
		t.Fatal(err)
	}
	var oldSecret string
	if err = s.db.QueryRow("SELECT secret FROM gateway_accounts WHERE channel_id=$1", first.ID).Scan(&oldSecret); err != nil {
		t.Fatal(err)
	}
	first.Name = "changed"
	first.Endpoint = "https://new.test"
	edited, err := h.prepareAccountBundle(first, map[string]any{"accountCredentials": map[string]any{"accessToken": "replacement-account-token"}})
	if err != nil {
		t.Fatal(err)
	}
	edited.mustExist = true
	broken := testStoredChannel("z-broken")
	if err = s.saveManagedBundles(ctx, []managedBundle{edited, {channel: broken, deletes: []string{"missing"}}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("late missing credential should fail: %v", err)
	}
	s.InvalidateCache()
	saved, err := s.Channel(ctx, first.ID)
	if err != nil || saved.Name == "changed" || saved.Endpoint != "https://old.test" {
		t.Fatalf("channel edit survived rollback: %+v %v", saved, err)
	}
	var currentSecret string
	if err = s.db.QueryRow("SELECT secret FROM gateway_accounts WHERE channel_id=$1", first.ID).Scan(&currentSecret); err != nil || currentSecret != oldSecret {
		t.Fatal("account edit survived rollback")
	}
}

func TestPostgresManagedCooldownReleaseIsSelective(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	avg := 1.5
	for _, test := range []struct {
		name, reason                                         string
		errorPolicy, firstTokenPolicy, autoDisabled, release bool
	}{
		{"http-first-token", "HTTP 503 首字超时", true, false, false, false},
		{"failure-first-token", "最近请求失败率超过 50%（首字）", true, false, false, false},
		{"auto-first-token", "连续首字超时", true, false, true, false},
		{"http-exempt", "HTTP 503", false, true, false, true},
		{"failure-exempt", "最近请求失败率超过 50%", false, true, false, true},
		{"first-token-exempt", "连续 3 次首字延迟均超过 1s", true, false, false, true},
		{"token-exempt", "连续 3 次首 Token 延迟均超过 1s", true, false, false, true},
		{"response-latency", "平均响应耗时 30s 超过 20s", false, false, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			channel := testStoredChannel(test.name)
			channel.Enabled = false
			channel.Status = "offline"
			channel.Requests = 42
			channel.History = []int{2}
			reason := test.reason
			channel.Health = Health{Reason: &reason, CooldownUntil: &now, FailureCount: 4, RecoveryCount: 2, Samples: 8, AverageTTFT: &avg, AutoDisabled: test.autoDisabled}
			if err := s.SaveChannel(ctx, channel); err != nil {
				t.Fatal(err)
			}
			channel.Config.Cooldown = CooldownPolicy{Error: test.errorPolicy, FirstToken: test.firstTokenPolicy}
			if err := s.saveManagedBundles(ctx, []managedBundle{{channel: channel, mustExist: true}}); err != nil {
				t.Fatal(err)
			}
			saved, err := s.Channel(ctx, channel.ID)
			if err != nil {
				t.Fatal(err)
			}
			if saved.Enabled || saved.Requests != 42 || saved.Health.FailureCount != 4 || saved.Health.Samples != 8 || saved.Health.AverageTTFT == nil || *saved.Health.AverageTTFT != avg || len(saved.History) != 1 {
				t.Fatalf("release changed manual activation or metrics: %+v", saved)
			}
			var cutoff string
			cutoffErr := s.db.QueryRow("SELECT value FROM gateway_state WHERE id=$1", "health-reset:"+channel.ID).Scan(&cutoff)
			if test.release {
				if saved.Status != "healthy" || saved.Health.Reason != nil || saved.Health.CooldownUntil != nil || saved.Health.AutoDisabled || saved.Health.RecoveryCount != 0 || cutoffErr != nil {
					t.Fatalf("exempt cooldown retained: %+v cutoff=%v", saved, cutoffErr)
				}
				if _, err = time.Parse(time.RFC3339Nano, cutoff); err != nil {
					t.Fatal(err)
				}
			} else {
				if saved.Status != "offline" || saved.Health.Reason == nil || *saved.Health.Reason != reason || cutoffErr == nil {
					t.Fatalf("unrelated restriction released: %+v cutoff=%v", saved, cutoffErr)
				}
			}
		})
	}
}

func TestPostgresManagedCooldownPreservesManualAndQuotaKeys(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	channel := testStoredChannel("keys")
	channel.Config.Integration = "bbdevlab"
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	due := time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)
	expired := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
	zero := float64(0)
	one := float64(1)
	ptr := func(v string) *string { return &v }
	credentials := []Credential{
		{ID: "http", Enabled: false, Reason: ptr("HTTP 401"), DisabledAt: &due},
		{ID: "go-http", Enabled: false, Reason: ptr("上游 HTTP 401 连续失败"), DisabledAt: &due},
		{ID: "manual", Enabled: false},
		{ID: "bb-quota", Enabled: false, Reason: ptr(bbExhaustedReason), DisabledAt: &due, Balance: &GatewayBalance{Status: "ok", Amount: &zero}},
		{ID: "bb-expired", Enabled: false, Reason: ptr(bbExpiredReason), DisabledAt: &due, ExpiresAt: &expired},
		{ID: "http-expired", Enabled: false, Reason: ptr("HTTP 401"), DisabledAt: &due, ExpiresAt: &expired, Balance: &GatewayBalance{Status: "ok", Amount: &one}},
		{ID: "other-reason", Enabled: false, Reason: ptr("管理员维护"), DisabledAt: &due},
	}
	for idx := range credentials {
		credentials[idx].Secret = "secret-" + credentials[idx].ID
		credentials[idx].Label = credentials[idx].ID
		if err := s.SaveCredential(ctx, channel.ID, credentials[idx]); err != nil {
			t.Fatal(err)
		}
	}
	channel.Config.Cooldown.Error = false
	if err := s.saveManagedBundles(ctx, []managedBundle{{channel: channel, mustExist: true}}); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Credentials(ctx, channel.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, credential := range saved {
		want := credential.ID == "http" || credential.ID == "go-http"
		if credential.Enabled != want {
			t.Fatalf("key %s enabled=%v, want %v", credential.ID, credential.Enabled, want)
		}
	}
	// An administrator opened this draft before a quota refresh disabled the key.
	// A label-only edit still preserves the current confirmed quota restriction.
	stale := Credential{ID: "bb-quota", Label: "renamed", Enabled: true, Secret: "secret-bb-quota"}
	if err = s.saveManagedBundles(ctx, []managedBundle{{channel: channel, mustExist: true, updates: []Credential{stale}}}); err != nil {
		t.Fatal(err)
	}
	saved, err = s.Credentials(ctx, channel.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, credential := range saved {
		if credential.ID == stale.ID && (credential.Enabled || credential.Reason == nil || *credential.Reason != bbExhaustedReason || credential.Balance == nil || credential.Label != "renamed") {
			t.Fatalf("label edit revived quota key: %+v", credential)
		}
	}
}

func TestPostgresManagedDeletedUpdateCannotResurrectChannel(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	channel := testStoredChannel("deleted")
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteChannel(ctx, channel.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.saveManagedBundles(ctx, []managedBundle{{channel: channel, mustExist: true}}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stale edit did not fail: %v", err)
	}
	if _, err := s.Channel(ctx, channel.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("stale edit resurrected deleted channel")
	}
}

func TestPostgresManagedDestinationChangeResetsBalanceSession(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	h := &Handler{store: s}
	channel := testStoredChannel("destination")
	channel.Endpoint = "https://old.test"
	channel.Config.Integration = "newapi"
	bundle, err := h.prepareAccountBundle(channel, map[string]any{"accountCredentials": map[string]any{"accessToken": "account-token"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.saveManagedBundles(ctx, []managedBundle{bundle}); err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`UPDATE gateway_accounts SET data=data||'{"session":"old-session","balance":{"status":"ok","amount":100},"nextRefreshAt":9999999999999,"leaseUntil":9999999999999}'::jsonb WHERE channel_id=$1`, channel.ID); err != nil {
		t.Fatal(err)
	}
	channel.Endpoint = "https://new.test"
	if err = s.saveManagedBundles(ctx, []managedBundle{{channel: channel, mustExist: true}}); err != nil {
		t.Fatal(err)
	}
	var raw []byte
	if err = s.db.QueryRow("SELECT data FROM gateway_accounts WHERE channel_id=$1", channel.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var metadata accountMetadata
	if err = json.Unmarshal(raw, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata.Session != "" || metadata.Balance != nil || metadata.NextRefreshAt != 0 || metadata.LeaseUntil != 0 {
		t.Fatalf("old account cache retained at new destination: %+v", metadata)
	}
}

func TestPostgresManagedSingleCredentialPatchMergesCurrentState(t *testing.T) {
	s := testPostgresStore(t)
	ctx := context.Background()
	channel := testStoredChannel("single-patch")
	if err := s.SaveChannel(ctx, channel); err != nil {
		t.Fatal(err)
	}
	credential := Credential{ID: "credential", Label: "original", Secret: "original-secret", Enabled: true}
	if err := s.SaveCredential(ctx, channel.ID, credential); err != nil {
		t.Fatal(err)
	}
	// This label-only draft predates another administrator's secret rotation and
	// a newly confirmed quota restriction. Omitted fields must not restore either.
	stale := Credential{ID: credential.ID, Label: "renamed", Enabled: true}
	rotated, err := s.PatchManagedCredential(ctx, channel.ID, Credential{ID: credential.ID, Secret: "rotated-secret"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Label != "original" || rotated.Secret != "rotated-secret" {
		t.Fatalf("omitted label was overwritten: %+v", rotated)
	}
	if _, err = s.db.Exec(`UPDATE credentials SET data=data||'{"enabled":false,"reason":"BBDevLab 额度耗尽","balance":{"status":"ok","amount":0},"failureCount":4}'::jsonb WHERE id=$1`, credential.ID); err != nil {
		t.Fatal(err)
	}
	s.InvalidateCache()
	saved, err := s.PatchManagedCredential(ctx, channel.ID, stale, nil)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Secret != "rotated-secret" || saved.Enabled || saved.Reason == nil || *saved.Reason != bbExhaustedReason || saved.FailureCount != 4 || saved.Balance == nil || saved.Label != "renamed" {
		t.Fatalf("stale patch restored private/runtime fields: %+v", saved)
	}
	disable := false
	saved, err = s.PatchManagedCredential(ctx, channel.ID, Credential{ID: credential.ID}, &disable)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Enabled || saved.Reason != nil || saved.DisabledAt != nil || saved.FailureCount != 0 || saved.Secret != "rotated-secret" || saved.Balance == nil || saved.Label != "renamed" {
		t.Fatalf("explicit manual disable changed other fields: %+v", saved)
	}
}
