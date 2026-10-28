package gateway

import (
	"context"
	"testing"
	"time"
)

func TestRecoveryRotatesDisabledCredentialsAndPreservesProbeMode(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	c.Status = "degraded"
	c.Health.Reason = engineStringPtr("平均响应耗时超过阈值")
	s := DefaultSettings()
	c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "key", Recover: true}
	now := time.Now()
	first := now.Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)
	second := now.Add(-time.Minute).UTC().Format(time.RFC3339Nano)
	credentials := []Credential{
		{ID: "permanent-failure", Reason: engineStringPtr("HTTP 401"), DisabledAt: &first},
		{ID: "recoverable", Reason: engineStringPtr("HTTP 401"), DisabledAt: &second},
		{ID: "manual"},
		{ID: "revoked", Reason: engineStringPtr("BBDevLab 已撤销")},
		{ID: "expired", Reason: engineStringPtr("HTTP 401"), ExpiresAt: &first},
	}
	lastProbed := make(map[string]time.Time)
	for i, expected := range []string{"permanent-failure", "recoverable", "permanent-failure", "recoverable"} {
		job, ok := selectRecoveryJob(c, s, credentials, now, lastProbed)
		if !ok || job.credentialID != expected {
			t.Fatalf("probe %d: selected %q, want %q", i, job.credentialID, expected)
		}
		if job.stream {
			t.Fatal("credential recovery used a different mode from channel degradation")
		}
		lastProbed[job.credentialID] = now.Add(time.Duration(i) * time.Second)
	}
}

func TestRecoveryKeepsManualDisableAndRecoveryPolicies(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	c.Status = "offline"
	s := DefaultSettings()
	s.AutoRecover = false
	c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "key", Recover: true}
	key := Credential{ID: "automatic", Reason: engineStringPtr("HTTP 401")}
	if job, ok := recoveryForChannel(c, s, []Credential{key}, time.Now()); !ok || job.credentialID != key.ID {
		t.Fatal("key recovery incorrectly required channel auto recovery")
	}
	if _, ok := recoveryForChannel(c, s, nil, time.Now()); ok {
		t.Fatal("channel recovered despite auto recovery being disabled")
	}
	s.AutoRecover = true
	c.Health.AutoDisabled = true
	c.Config.AutoDisable.Recover = false
	if _, ok := recoveryForChannel(c, s, []Credential{key}, time.Now()); ok {
		t.Fatal("automatic disable recovery ignored its own policy")
	}
	c.Config.AutoDisable.Recover = true
	c.Enabled = false
	if _, ok := recoveryForChannel(c, s, []Credential{key}, time.Now()); ok {
		t.Fatal("manually disabled channel scheduled recovery")
	}
	c.Enabled = true
	c.Archived = true
	if _, ok := recoveryForChannel(c, s, []Credential{key}, time.Now()); ok {
		t.Fatal("archived channel scheduled recovery")
	}
}

func TestRecoveryFairlySchedulesChannelAndDisabledKeys(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	c.Status = "offline"
	c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "key", Recover: true}
	s := DefaultSettings()
	credentials := []Credential{
		{ID: "healthy", Enabled: true},
		{ID: "a", Reason: engineStringPtr("HTTP 401")},
		{ID: "b", Reason: engineStringPtr("HTTP 401")},
	}
	now := time.Now()
	lastProbed := make(map[string]time.Time)
	for i, expected := range []string{"", "a", "b", "", "a", "b"} {
		job, ok := selectRecoveryJob(c, s, credentials, now, lastProbed)
		if !ok || job.credentialID != expected {
			t.Fatalf("probe %d: selected %q, want %q", i, job.credentialID, expected)
		}
		lastProbed[job.credentialID] = now.Add(time.Duration(i) * time.Second)
	}
}

func TestRecoveryClearsFailureWindowsFromBothResponseModes(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	s := DefaultSettings()
	s.Window = 4
	s.Samples = 4
	s.Recovery = 2
	s.Cooldown = 0
	r := &channelRuntime{}
	base := time.Now().Add(-time.Second)
	for i := range 4 {
		r.observe(c, healthTestAttempt(base.Add(time.Duration(i)*time.Millisecond), false, "error", 0.1), s)
	}
	if r.healthStatus != "offline" {
		t.Fatal("failed requests did not isolate the channel")
	}
	for i := range 2 {
		r.observe(c, healthTestAttempt(base.Add(time.Duration(i+4)*time.Millisecond), true, "success", 0.1), s)
	}
	if r.healthStatus != "healthy" {
		t.Fatal("fresh probes did not restore the channel")
	}
	h := r.observe(c, healthTestAttempt(base.Add(6*time.Millisecond), false, "success", 0.1), s)
	if h.status != "healthy" || h.health.Samples != 1 {
		t.Fatal("old failures from the other response mode immediately isolated a recovered channel")
	}
}

func TestRecoveryIgnoresFailuresThatStartedBeforeSuccessfulRecovery(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	c.Status = "offline"
	c.Health.Reason = engineStringPtr("最近请求失败率超过 50%")
	s := DefaultSettings()
	s.Window = 2
	s.Samples = 2
	s.Recovery = 1
	r := &channelRuntime{}
	recoveredAt := time.Now()
	recovered := r.observe(c, healthTestAttempt(recoveredAt, true, "success", 0.1), s)
	if recovered.id != c.ID || recovered.status != "healthy" || recovered.startedAt != recoveredAt.UTC().Format(time.RFC3339Nano) {
		t.Fatal("successful recovery was not returned for persistence")
	}
	for i := range 4 {
		old := healthTestAttempt(recoveredAt.Add(-time.Duration(i+1)*time.Millisecond), i%2 == 0, "error", 0.1)
		if change := r.observe(c, old, s); change.id != "" {
			t.Fatal("failure started before recovery generated a health update")
		}
	}
	if r.healthStatus != "healthy" || r.health.Samples != 1 || r.healthStartedAt != recovered.startedAt {
		t.Fatal("old in-flight failures polluted the recovered health window")
	}
	for i := range 2 {
		fresh := healthTestAttempt(recoveredAt.Add(time.Duration(i+1)*time.Millisecond), true, "error", 0.1)
		r.observe(c, fresh, s)
	}
	if r.healthStatus != "offline" {
		t.Fatal("failures started after recovery no longer trigger health protection")
	}
}

func TestCredentialRecoveryAcceptsLegacyCooldownMetadata(t *testing.T) {
	for _, disabledAt := range []*string{nil, engineStringPtr("invalid-date")} {
		name := "missing"
		if disabledAt != nil {
			name = "invalid"
		}
		t.Run(name, func(t *testing.T) {
			store := testSQLiteStore(t)
			ctx := context.Background()
			c := testStoredChannel("legacy-recovery")
			c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "key", Recover: true}
			if err := store.SaveChannel(ctx, c); err != nil {
				t.Fatal(err)
			}
			key := Credential{ID: "legacy", Secret: "secret", Reason: engineStringPtr("HTTP 401"), DisabledAt: disabledAt}
			if err := store.SaveCredential(ctx, c.ID, key); err != nil {
				t.Fatal(err)
			}
			s := DefaultSettings()
			s.Recovery = 2
			for i := range 2 {
				a := healthTestAttempt(time.Now(), true, "success", 0.1)
				a.CredentialID = &key.ID
				if err := store.ApplyCredentialAttempt(ctx, a, c, s, "probe"); err != nil {
					t.Fatal(err)
				}
				keys, err := store.Credentials(ctx, c.ID, true)
				if err != nil || len(keys) != 1 || keys[0].Enabled != (i == 1) {
					t.Fatalf("successful recovery probe %d: keys=%+v err=%v", i+1, keys, err)
				}
			}
		})
	}
}

func TestCredentialRecoveryRespectsCurrentPolicyAndRestrictions(t *testing.T) {
	for _, restriction := range []string{"manual", "revoked", "expired", "quota", "future", "recovery-disabled"} {
		t.Run(restriction, func(t *testing.T) {
			store := testSQLiteStore(t)
			ctx := context.Background()
			c := testStoredChannel("restricted-recovery")
			c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "key", Recover: true}
			stale := c
			key := Credential{ID: "key", Secret: "secret", Reason: engineStringPtr("HTTP 401")}
			switch restriction {
			case "manual":
				key.Reason = nil
			case "revoked":
				key.Reason = engineStringPtr("BBDevLab 已撤销")
			case "expired":
				key.ExpiresAt = engineStringPtr(time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano))
			case "quota":
				zero := 0.0
				key.Balance = &GatewayBalance{Status: "ok", Amount: &zero}
			case "future":
				key.DisabledAt = engineStringPtr(time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano))
			case "recovery-disabled":
				c.Config.AutoDisable.Recover = false
			}
			if err := store.SaveChannel(ctx, c); err != nil {
				t.Fatal(err)
			}
			if err := store.SaveCredential(ctx, c.ID, key); err != nil {
				t.Fatal(err)
			}
			s := DefaultSettings()
			s.Recovery = 1
			a := healthTestAttempt(time.Now(), true, "success", 0.1)
			a.CredentialID = &key.ID
			if err := store.ApplyCredentialAttempt(ctx, a, stale, s, "probe"); err != nil {
				t.Fatal(err)
			}
			keys, err := store.Credentials(ctx, c.ID, true)
			if err != nil || len(keys) != 1 || keys[0].Enabled {
				t.Fatalf("recovery removed %s restriction: keys=%+v err=%v", restriction, keys, err)
			}
		})
	}
}
