package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ApplyCredentialAttempt updates only key health fields. Telemetry never writes
// an old decrypted credential or overwrites an administrator's secret edit.
func (s *Store) ApplyCredentialAttempt(ctx context.Context, a Attempt, c Channel, settings Settings, source string) error {
	if a.CredentialID == nil || a.Result == "cancelled" || a.HealthIgnored {
		return nil
	}
	if _, err := time.Parse(time.RFC3339Nano, a.StartedAt); err != nil {
		return nil
	}
	policy := c.Config.AutoDisable
	if !policy.Enabled {
		policy = AutoDisable{Enabled: settings.AutoDisableEnabled, Target: settings.AutoDisableTarget, Statuses: settings.AutoDisableStatuses, Threshold: settings.AutoDisableThreshold, Recover: settings.AutoDisableRecover, Cooldown: settings.AutoDisableCooldown}
	}
	if !c.Config.Cooldown.Error {
		return nil
	}
	if source != "probe" && (!policy.Enabled || policy.Target != "key") {
		return nil
	}
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	currentChannel, err := integrationLockChannel(ctx, tx, c.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !currentChannel.Config.Cooldown.Error {
		return nil
	}
	policy = currentChannel.Config.AutoDisable
	if !policy.Enabled {
		policy = AutoDisable{Enabled: settings.AutoDisableEnabled, Target: settings.AutoDisableTarget, Statuses: settings.AutoDisableStatuses, Threshold: settings.AutoDisableThreshold, Recover: settings.AutoDisableRecover, Cooldown: settings.AutoDisableCooldown}
	}
	if source != "probe" && (!policy.Enabled || policy.Target != "key") {
		return nil
	}
	allowed, err := cutoffAllowsTx(ctx, tx, c.ID, a.StartedAt)
	if err != nil {
		return err
	}
	if !allowed {
		return nil
	}
	var raw []byte
	if err = tx.QueryRowContext(ctx, "SELECT data FROM credentials WHERE id=$1 AND channel_id=$2 FOR UPDATE", *a.CredentialID, c.ID).Scan(&raw); errors.Is(err, sql.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	var credential Credential
	if err = json.Unmarshal(raw, &credential); err != nil {
		return err
	}
	if credential.Reason != nil && strings.HasPrefix(*credential.Reason, "BBDevLab ") {
		return nil
	}
	failures := credential.FailureCount
	enabled := credential.Enabled
	reason := credential.Reason
	disabledAt := credential.DisabledAt
	var metadata map[string]any
	_ = json.Unmarshal(raw, &metadata)
	recovery := int(engineCount(metadata["recoveryCount"]))
	if containsStatus(policy.Statuses, a.Status) {
		failures++
	} else {
		failures = 0
	}
	if !enabled {
		if source != "probe" || reason == nil || !policy.Recover || strings.HasPrefix(*reason, "BBDevLab ") || credentialEngineExpired(credential) {
			return nil
		}
		if !recoveryDue(disabledAt, time.Now()) {
			return nil
		}
		recovery = 0
		if a.Result == "success" {
			recovery = int(engineCount(metadata["recoveryCount"])) + 1
		}
		if recovery >= max(1, settings.Recovery) {
			enabled = true
			reason = nil
			disabledAt = nil
			recovery = 0
			failures = 0
		}
	} else {
		recovery = 0
		if policy.Enabled && policy.Target == "key" && failures >= max(1, policy.Threshold) {
			enabled = false
			message := fmt.Sprintf("HTTP %d", a.Status)
			reason = &message
			until := time.Now().Add(time.Duration(max(0, policy.Cooldown) * float64(time.Second))).UTC().Format(time.RFC3339Nano)
			disabledAt = &until
		}
	}
	metadata["failureCount"] = failures
	metadata["recoveryCount"] = recovery
	metadata["enabled"] = enabled
	metadata["reason"] = reason
	metadata["disabledAt"] = disabledAt
	err = putJSONTx(ctx, tx, "credentials", "id", *a.CredentialID, metadata)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}
