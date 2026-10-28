package gateway

import (
	"context"
	"math"
	"testing"
	"time"
)

func healthTestAttempt(at time.Time, stream bool, result string, latency float64) Attempt {
	a := Attempt{StartedAt: at.UTC().Format(time.RFC3339Nano), Stream: stream, Result: result, Status: 200, Duration: latency}
	if stream {
		a.TTFT = &latency
	}
	if result == "error" {
		a.Status = 503
		a.TTFT = nil
	}
	return a
}

func TestHealthRequiresEntireStreamWindowSlowAndSeparatesResponseModes(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	s := DefaultSettings()
	s.Window = 4
	s.Samples = 2
	s.Threshold = 1
	s.ResponseThreshold = 1
	r := &channelRuntime{}
	base := time.Now().Add(-time.Second)
	for i := 0; i < 3; i++ {
		h := r.observe(c, healthTestAttempt(base.Add(time.Duration(i)*time.Millisecond), true, "slow", 2), s)
		if h.status != "healthy" {
			t.Fatal("partial slow window degraded channel")
		}
		r.observe(c, healthTestAttempt(base.Add(time.Duration(i)*time.Millisecond), false, "success", 0.1), s)
	}
	fast := r.observe(c, healthTestAttempt(base.Add(3*time.Millisecond), true, "success", 0.1), s)
	if fast.status != "healthy" || fast.health.Samples != 4 {
		t.Fatal("fast request did not break stream slow streak")
	}
	for i := 4; i < 8; i++ {
		h := r.observe(c, healthTestAttempt(base.Add(time.Duration(i)*time.Millisecond), true, "slow", 2), s)
		if i < 7 && h.status != "healthy" {
			t.Fatal("fast sample evicted too early")
		}
		if i == 7 && h.status != "degraded" {
			t.Fatal("full slow window did not degrade")
		}
	}
	if len(r.recentNonstream) != 3 || len(r.recentStream) != 4 {
		t.Fatal("response mode windows were mixed")
	}
}

func TestHealthFailureRatioAndValidDurationMean(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	s := DefaultSettings()
	s.Window = 4
	s.Samples = 4
	s.ResponseThreshold = 1
	r := &channelRuntime{}
	base := time.Now().Add(-time.Second)
	for i, result := range []string{"error", "success", "error", "success"} {
		h := r.observe(c, healthTestAttempt(base.Add(time.Duration(i)*time.Millisecond), false, result, 0.1), s)
		if i < 3 && h.status != "healthy" {
			t.Fatal("failed before minimum samples")
		}
		if i == 3 && (h.status != "offline" || h.health.FailureCount != 0) {
			t.Fatal("50% window failure ratio must trigger even without consecutive errors")
		}
	}
	c.Config.Cooldown.Error = false
	r = &channelRuntime{}
	s.Samples = 2
	for i, result := range []string{"success", "error", "success"} {
		latency := 0.2
		if result == "error" {
			latency = 1000
		}
		h := r.observe(c, healthTestAttempt(base.Add(time.Duration(i)*time.Millisecond), false, result, latency), s)
		if h.status != "healthy" {
			t.Fatal("failed duration biased valid completion average")
		}
		if i == 2 && (h.health.AverageDuration == nil || math.Abs(*h.health.AverageDuration-0.2) > 0.00001) {
			t.Fatal("duration mean includes failed attempts")
		}
	}
}

func TestHealthTimeWindowAndPolicyExemptions(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	s := DefaultSettings()
	s.Window = 2
	s.Samples = 2
	s.WindowSeconds = 1
	s.Threshold = 1
	s.ResponseThreshold = 1
	r := &channelRuntime{}
	old := time.Now().Add(-5 * time.Second)
	for i := range 2 {
		h := r.observe(c, healthTestAttempt(old.Add(time.Duration(i)*time.Millisecond), true, "slow", 2), s)
		if h.health.Samples != 0 || h.health.AverageTTFT != nil || h.status != "healthy" {
			t.Fatal("expired request polluted time window")
		}
	}
	c.Config.Cooldown.FirstToken = false
	c.Config.Cooldown.Error = false
	c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "channel", Statuses: []int{503}, Threshold: 1}
	r = &channelRuntime{}
	for i := range 4 {
		a := healthTestAttempt(time.Now().Add(time.Duration(i)*time.Microsecond), true, "slow", 2)
		if i < 2 {
			a = healthTestAttempt(time.Now().Add(time.Duration(i)*time.Microsecond), true, "error", 2)
		}
		h := r.observe(c, a, s)
		if h.status != "healthy" || h.health.AutoDisabled {
			t.Fatal("disabled cooldown rule still isolated channel")
		}
	}
	r = &channelRuntime{}
	for i := range 2 {
		h := r.observe(c, healthTestAttempt(time.Now().Add(time.Duration(i)*time.Microsecond), false, "slow", 2), s)
		if i == 1 && h.status != "degraded" {
			t.Fatal("error exemption incorrectly disabled nonstream duration quality")
		}
	}
}

func TestHealthFreshRecoveryHonorsModeCooldownAndGoodStreak(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	c.Status = "degraded"
	reason := "连续 2 次首字延迟均超过 1s"
	c.Health.Reason = &reason
	future := time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)
	c.Health.CooldownUntil = &future
	s := DefaultSettings()
	s.Window = 2
	s.Samples = 2
	s.Recovery = 2
	s.Threshold = 1
	s.ResponseThreshold = 1
	r := &channelRuntime{}
	h := r.observe(c, healthTestAttempt(time.Now(), true, "success", 0.1), s)
	if h.health.RecoveryCount != 0 || h.status != "degraded" {
		t.Fatal("recovered before cooldown")
	}
	r.health.CooldownUntil = nil
	h = r.observe(c, healthTestAttempt(time.Now(), false, "success", 0.1), s)
	if h.health.RecoveryCount != 0 {
		t.Fatal("wrong response mode counted towards recovery")
	}
	h = r.observe(c, healthTestAttempt(time.Now(), true, "success", 0.1), s)
	if h.health.RecoveryCount != 1 {
		t.Fatal("fresh good token did not count")
	}
	h = r.observe(c, healthTestAttempt(time.Now(), true, "slow", 2), s)
	if h.health.RecoveryCount != 0 {
		t.Fatal("slow sample counted as fresh recovery")
	}
	for i := range 2 {
		h = r.observe(c, healthTestAttempt(time.Now(), true, "success", 0.1), s)
		if i == 1 && (h.status != "healthy" || h.health.Samples != 1 || h.event == nil || h.event.Type != "recovery") {
			t.Fatal("good streak did not recover and reset window")
		}
	}
}

func TestHealthRingBoundAndIgnoredAttempts(t *testing.T) {
	c := testEngineChannel("a", "http://upstream", "test", 0)
	s := DefaultSettings()
	s.Window = 100000
	s.AutoSwitch = false
	r := &channelRuntime{}
	base := time.Now().Add(-time.Second)
	for i := range 1100 {
		r.observe(c, healthTestAttempt(base.Add(time.Duration(i)*time.Microsecond), true, "success", 0.1), s)
	}
	if len(r.recentStream) != 1000 {
		t.Fatal("health ring exceeded hard bound")
	}
	a := healthTestAttempt(time.Now(), true, "cancelled", 0.1)
	r.observe(c, a, s)
	a.Result = "error"
	a.HealthIgnored = true
	r.observe(c, a, s)
	if len(r.recentStream) != 1000 || r.health.Samples != 1000 {
		t.Fatal("ignored attempts evicted valid bounded samples")
	}
}

func TestPostgresCredentialAutoDisableRecoveryPolicy(t *testing.T) {
	store := testPostgresStore(t)
	ctx := context.Background()
	c := testStoredChannel("credential-health")
	c.Config = DefaultChannelConfig()
	c.Config.AutoDisable = AutoDisable{Enabled: true, Target: "key", Statuses: []int{401}, Threshold: 2, Recover: true, Cooldown: 0.001}
	if err := store.SaveChannel(ctx, c); err != nil {
		t.Fatal(err)
	}
	cred := Credential{ID: "key", Enabled: true, Secret: "secret", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := store.SaveCredential(ctx, c.ID, cred); err != nil {
		t.Fatal(err)
	}
	settings := DefaultSettings()
	settings.Recovery = 2
	a := Attempt{CredentialID: &cred.ID, Result: "error", Status: 401, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	for range 2 {
		if err := store.ApplyCredentialAttempt(ctx, a, c, settings, "api"); err != nil {
			t.Fatal(err)
		}
	}
	keys, _ := store.Credentials(ctx, c.ID, true)
	if keys[0].Enabled {
		t.Fatal("credential not disabled at threshold")
	}
	time.Sleep(2 * time.Millisecond)
	a.Result = "success"
	a.Status = 200
	if err := store.ApplyCredentialAttempt(ctx, a, c, settings, "probe"); err != nil {
		t.Fatal(err)
	}
	keys, _ = store.Credentials(ctx, c.ID, true)
	if keys[0].Enabled {
		t.Fatal("credential recovered before configured streak")
	}
	if err := store.ApplyCredentialAttempt(ctx, a, c, settings, "probe"); err != nil {
		t.Fatal(err)
	}
	keys, _ = store.Credentials(ctx, c.ID, true)
	if !keys[0].Enabled {
		t.Fatal("credential did not recover after successful probes")
	}
	c.Config.Cooldown.Error = false
	if err := store.SaveChannel(ctx, c); err != nil {
		t.Fatal(err)
	}
	a.Result = "error"
	a.Status = 401
	for range 3 {
		if err := store.ApplyCredentialAttempt(ctx, a, c, settings, "api"); err != nil {
			t.Fatal(err)
		}
	}
	keys, _ = store.Credentials(ctx, c.ID, true)
	if !keys[0].Enabled {
		t.Fatal("credential disabled despite error cooldown exemption")
	}
}
