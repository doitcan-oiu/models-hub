package gateway

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"
)

type recoveryJob struct {
	channel      Channel
	credentialID string
	stream       bool
}

// Channel recovery and key recovery have independent enablement policies.
// Manually disabled keys have no failure reason and remain disabled.
func recoveryForChannel(c Channel, s Settings, credentials []Credential, now time.Time) (recoveryJob, bool) {
	job := recoveryJob{channel: c, stream: true}
	if !c.Enabled || c.Archived {
		return job, false
	}
	policy := c.Config.AutoDisable
	if !policy.Enabled {
		policy = AutoDisable{Enabled: s.AutoDisableEnabled, Target: s.AutoDisableTarget, Recover: s.AutoDisableRecover, Cooldown: s.AutoDisableCooldown}
	}
	due := func(value *string) bool {
		if value == nil {
			return true
		}
		t, err := time.Parse(time.RFC3339Nano, *value)
		return err != nil || !t.After(now)
	}
	if policy.Recover {
		eligible := make([]Credential, 0)
		for _, cr := range credentials {
			if !cr.Enabled && cr.Reason != nil && !strings.HasPrefix(*cr.Reason, "BBDevLab ") && !credentialEngineExpired(cr) && due(cr.DisabledAt) {
				eligible = append(eligible, cr)
			}
		}
		sort.SliceStable(eligible, func(i, j int) bool {
			a, b := "", ""
			if eligible[i].DisabledAt != nil {
				a = *eligible[i].DisabledAt
			}
			if eligible[j].DisabledAt != nil {
				b = *eligible[j].DisabledAt
			}
			if a != b {
				return a < b
			}
			return eligible[i].ID < eligible[j].ID
		})
		if len(eligible) > 0 {
			job.credentialID = eligible[0].ID
			return job, true
		}
	}
	recoverChannel := c.Status != "healthy" && s.AutoRecover
	if c.Health.AutoDisabled {
		recoverChannel = policy.Recover
	}
	if !recoverChannel || !due(c.Health.CooldownUntil) {
		return job, false
	}
	if c.Health.Reason != nil && strings.Contains(*c.Health.Reason, "响应耗时") {
		job.stream = false
	}
	return job, true
}

// Maintenance has dedicated per-channel probe transports and admission slots.
// At most four recovery requests run at once; a bad channel never holds an
// inference slot or another channel's connection pool.
func RunMaintenance(ctx context.Context, s *Store, e *Engine) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	lastCleanup := time.Time{}
	lastProbed := make(map[string]time.Time)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		configctx, configcancel := context.WithTimeout(ctx, 5*time.Second)
		settings, err := s.Settings(configctx)
		channels, channelErr := s.Channels(configctx)
		configcancel()
		if err != nil || channelErr != nil {
			continue
		}
		if time.Since(lastCleanup) > time.Hour {
			cleanup, cancel := context.WithTimeout(ctx, 5*time.Second)
			err = s.Cleanup(cleanup, settings.LogRetentionDays)
			cancel()
			if err != nil {
				slog.Warn("housekeeping failed", "error", err)
			}
			lastCleanup = time.Now()
		}
		jobs := make([]recoveryJob, 0)
		for _, c := range channels {
			policy := c.Config.AutoDisable
			needKeys := policy.Enabled && policy.Recover || !policy.Enabled && settings.AutoDisableRecover
			var credentials []Credential
			if needKeys && c.Enabled && !c.Archived {
				credctx, cancel := context.WithTimeout(ctx, 2*time.Second)
				credentials, _ = s.Credentials(credctx, c.ID, true)
				cancel()
			}
			if job, ok := recoveryForChannel(c, settings, credentials, time.Now()); ok {
				jobs = append(jobs, job)
			}
		}
		sort.SliceStable(jobs, func(i, j int) bool {
			a, b := lastProbed[jobs[i].channel.ID], lastProbed[jobs[j].channel.ID]
			if !a.Equal(b) {
				return a.Before(b)
			}
			return jobs[i].channel.ID < jobs[j].channel.ID
		})
		if len(jobs) > 8 {
			jobs = jobs[:8]
		}
		sem := make(chan struct{}, 4)
		var wg sync.WaitGroup
		for _, job := range jobs {
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				wg.Wait()
				return
			}
			lastProbed[job.channel.ID] = time.Now()
			wg.Add(1)
			go func(job recoveryJob) {
				defer wg.Done()
				defer func() { <-sem }()
				probe, cancel := context.WithTimeout(ctx, 40*time.Second)
				defer cancel()
				var err error
				if job.credentialID != "" {
					err = e.ProbeCredential(probe, job.channel, job.credentialID, job.stream)
				} else {
					err = e.ProbeChannel(probe, job.channel, job.stream)
				}
				if err != nil && ctx.Err() == nil {
					slog.Debug("recovery probe failed", "channel_id", job.channel.ID, "credential_id", job.credentialID)
				}
			}(job)
		}
		wg.Wait()
		_ = e.Refresh(ctx)
	}
}
