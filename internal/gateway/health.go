package gateway

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// Only the fields required for health decisions are retained. Each response
// mode has at most 1,000 samples, independent of traffic or telemetry backlog.
type engineHealthSample struct {
	startedAt time.Time
	result    string
	ttft      *float64
	duration  float64
}

func (r *channelRuntime) observe(c Channel, a Attempt, s Settings) engineHealth {
	r.mu.Lock()
	defer r.mu.Unlock()
	if a.Result == "cancelled" || a.HealthIgnored {
		return engineHealth{}
	}
	started, err := time.Parse(time.RFC3339Nano, a.StartedAt)
	if err != nil {
		return engineHealth{}
	}
	if !r.resetAt.IsZero() && !started.After(r.resetAt) {
		return engineHealth{}
	}
	if !r.healthLoaded {
		r.health = c.Health
		r.healthStatus = c.Status
		r.healthLoaded = true
	}
	now := time.Now()
	h := r.health
	previousStatus := r.healthStatus
	if previousStatus == "" {
		previousStatus = "healthy"
	}
	status := previousStatus
	// An administrator may exempt a restriction while an old in-memory window
	// still exists. Apply the current policy before considering new samples.
	restrictionReason := ""
	if h.Reason != nil {
		restrictionReason = *h.Reason
	}
	upperReason := strings.ToUpper(restrictionReason)
	errorRestriction := h.AutoDisabled || strings.HasPrefix(upperReason, "HTTP ") || strings.Contains(restrictionReason, "失败率")
	exempt := errorRestriction && !c.Config.Cooldown.Error || !errorRestriction && !c.Config.Cooldown.FirstToken && (strings.Contains(restrictionReason, "首字") || strings.Contains(restrictionReason, "首 Token"))
	if exempt {
		status = "healthy"
		h.Reason = nil
		h.CooldownUntil = nil
		h.RecoveryCount = 0
		h.AutoDisabled = false
		r.autoDisableFailures = 0
	}
	window := min(1000, max(1, s.Window))
	samples := &r.recentNonstream
	if a.Stream {
		samples = &r.recentStream
	}
	// Sort by request start time, matching the durable implementation even when
	// simultaneous upstream calls finish in a different order.
	v := engineHealthSample{started, a.Result, a.TTFT, a.Duration}
	index := sort.Search(len(*samples), func(i int) bool { return !(*samples)[i].startedAt.After(started) })
	*samples = append(*samples, engineHealthSample{})
	copy((*samples)[index+1:], (*samples)[index:])
	(*samples)[index] = v
	filtered := (*samples)[:0]
	since := time.Time{}
	if s.WindowSeconds > 0 {
		since = now.Add(-time.Duration(s.WindowSeconds) * time.Second)
	}
	for _, sample := range *samples {
		if !sample.startedAt.Before(since) && len(filtered) < window {
			filtered = append(filtered, sample)
		}
	}
	*samples = filtered
	valid, failed, ttftCount := 0, 0, 0
	durationTotal, ttftTotal := 0.0, 0.0
	allSlow := len(filtered) == window
	for _, sample := range filtered {
		good := sample.result == "success" || sample.result == "slow"
		if good {
			valid++
			durationTotal += sample.duration
			if sample.ttft != nil && !math.IsNaN(*sample.ttft) && !math.IsInf(*sample.ttft, 0) && *sample.ttft >= 0 {
				ttftTotal += *sample.ttft
				ttftCount++
			}
		}
		if sample.result == "error" || sample.result == "empty" {
			failed++
		}
		if !good || sample.ttft == nil || math.IsNaN(*sample.ttft) || math.IsInf(*sample.ttft, 0) || *sample.ttft <= s.Threshold {
			allSlow = false
		}
	}
	h.Samples = len(filtered)
	var duration *float64
	if valid > 0 {
		n := durationTotal / float64(valid)
		duration = &n
	}
	var ttft *float64
	if ttftCount > 0 {
		n := ttftTotal / float64(ttftCount)
		ttft = &n
	}
	if a.Stream {
		h.AverageTTFT = ttft
	} else {
		h.AverageDuration = duration
	}
	latestFailed := a.Result == "error" || a.Result == "empty"
	if latestFailed {
		h.FailureCount++
	} else {
		h.FailureCount = 0
	}
	enough := len(filtered) >= max(1, s.Samples)
	tooSlow := c.Config.Cooldown.FirstToken && allSlow
	if !a.Stream {
		eligible := enough
		if !c.Config.Cooldown.Error {
			eligible = valid >= max(1, s.Samples)
		}
		tooSlow = eligible && duration != nil && *duration > s.ResponseThreshold
	}
	mostlyFailed := c.Config.Cooldown.Error && enough && len(filtered) > 0 && float64(failed)/float64(len(filtered)) >= 0.5
	if s.AutoSwitch && (tooSlow || mostlyFailed) {
		status = "degraded"
		reason := fmt.Sprintf("连续 %d 次首字延迟均超过 %gs", window, s.Threshold)
		if !a.Stream && duration != nil {
			reason = fmt.Sprintf("平均响应耗时 %.2fs 超过 %gs", *duration, s.ResponseThreshold)
		}
		if mostlyFailed {
			status = "offline"
			reason = "最近请求失败率超过 50%"
		}
		h.Reason = &reason
		if previousStatus == "healthy" {
			until := now.Add(time.Duration(s.Cooldown * float64(time.Second))).UTC().Format(time.RFC3339Nano)
			h.CooldownUntil = &until
		}
		h.RecoveryCount = 0
	}
	policy := c.Config.AutoDisable
	if !policy.Enabled {
		policy = AutoDisable{Enabled: s.AutoDisableEnabled, Target: s.AutoDisableTarget, Statuses: s.AutoDisableStatuses, Threshold: s.AutoDisableThreshold, Recover: s.AutoDisableRecover, Cooldown: s.AutoDisableCooldown}
	}
	matchingMode := true
	if r.health.Reason != nil {
		if strings.Contains(*r.health.Reason, "首字") || strings.Contains(*r.health.Reason, "首 Token") {
			matchingMode = a.Stream
		} else if strings.Contains(*r.health.Reason, "响应耗时") {
			matchingMode = !a.Stream
		}
	}
	allowRecovery := s.AutoRecover
	if r.health.AutoDisabled {
		allowRecovery = policy.Recover
	}
	currentGood := !latestFailed
	if a.Stream {
		currentGood = currentGood && (!c.Config.Cooldown.FirstToken || a.TTFT != nil && *a.TTFT <= s.Threshold)
	} else {
		currentGood = currentGood && a.Duration <= s.ResponseThreshold
	}
	cooldownDue := true
	if r.health.CooldownUntil != nil {
		until, err := time.Parse(time.RFC3339Nano, *r.health.CooldownUntil)
		cooldownDue = err != nil || !now.Before(until)
	}
	if previousStatus != "healthy" && allowRecovery && matchingMode && cooldownDue {
		h.RecoveryCount = 0
		if currentGood {
			h.RecoveryCount = r.health.RecoveryCount + 1
		}
		if h.RecoveryCount >= max(1, s.Recovery) {
			status = "healthy"
			h.CooldownUntil = nil
			h.Reason = nil
			h.RecoveryCount = 0
			h.AutoDisabled = false
			// Recovery starts a fresh health window for both response modes.
			// Otherwise old failures from the other mode can immediately reopen
			// the circuit after a successful recovery.
			r.recentStream = nil
			r.recentNonstream = nil
			r.resetAt = started
			*samples = []engineHealthSample{v}
			h.Samples = 1
			h.AverageTTFT = nil
			h.AverageDuration = nil
			if a.Stream {
				h.AverageTTFT = a.TTFT
			} else {
				n := a.Duration
				h.AverageDuration = &n
			}
		}
	}
	if containsStatus(policy.Statuses, a.Status) {
		r.autoDisableFailures++
	} else {
		r.autoDisableFailures = 0
	}
	if policy.Enabled && policy.Target == "channel" && c.Config.Cooldown.Error && r.autoDisableFailures >= max(1, policy.Threshold) {
		status = "offline"
		h.AutoDisabled = true
		h.FailureCount = r.autoDisableFailures
		reason := fmt.Sprintf("HTTP %d", a.Status)
		h.Reason = &reason
		until := now.Add(time.Duration(policy.Cooldown * float64(time.Second))).UTC().Format(time.RFC3339Nano)
		h.CooldownUntil = &until
	}
	r.health = h
	r.healthStatus = status
	r.healthStartedAt = a.StartedAt
	change := engineHealth{id: c.ID, health: h, status: status, startedAt: a.StartedAt}
	if previousStatus != status {
		kind, title := "warning", "渠道健康度下降"
		if status == "healthy" {
			kind, title = "recovery", "渠道已恢复"
		}
		reason := "连续检测通过，恢复参与路由"
		if h.Reason != nil {
			reason = *h.Reason
		}
		change.event = &Event{ID: engineID(), CreatedAt: now.UTC().Format(time.RFC3339Nano), Time: now.In(time.FixedZone("CST", 8*3600)).Format("15:04:05"), Title: title, Description: c.Name + "：" + reason, Type: kind, ChannelID: engineStringPtr(c.ID)}
	}
	return change
}
