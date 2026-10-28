package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

func credentialMapsTx(ctx context.Context, tx *DBTx, channelID string) ([]map[string]any, error) {
	rows, err := tx.QueryContext(ctx, "SELECT data FROM credentials WHERE channel_id=$1 ORDER BY id FOR UPDATE", channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var raw []byte
		var item map[string]any
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (s *Store) portableResetManagedBalancesTx(ctx context.Context, tx *DBTx, id string, resetAccount bool) error {
	creds, err := credentialMapsTx(ctx, tx, id)
	if err != nil {
		return err
	}
	for _, item := range creds {
		delete(item, "balance")
		delete(item, "expiresAt")
		if reason, _ := item["reason"].(string); reason == bbExhaustedReason || reason == bbExpiredReason {
			item["enabled"] = true
			item["reason"] = nil
			item["disabledAt"] = nil
			item["failureCount"] = 0
		}
		if err = putJSONTx(ctx, tx, "credentials", "id", item["id"].(string), item); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE credential_balance_jobs SET next_refresh_at=0,lease_until=0 WHERE credential_id IN(SELECT id FROM credentials WHERE channel_id=$1)", id); err != nil {
		return err
	}
	if resetAccount {
		var metadata map[string]any
		err = jsonRowTx(ctx, tx, "gateway_accounts", "channel_id", id, &metadata)
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		metadata["session"] = ""
		metadata["balance"] = nil
		metadata["nextRefreshAt"] = 0
		metadata["leaseUntil"] = 0
		metadata["version"] = time.Now().UnixNano()
		err = putJSONTx(ctx, tx, "gateway_accounts", "channel_id", id, metadata)
	}
	return err
}
func (s *Store) portableReleaseExemptTx(ctx context.Context, tx *DBTx, ch Channel) error {
	if err := jsonRowTx(ctx, tx, "channels", "id", ch.ID, &ch); err != nil {
		return err
	}
	if adminCooldownExempt(ch) {
		ch.Status = "healthy"
		ch.Health.CooldownUntil = nil
		ch.Health.Reason = nil
		ch.Health.RecoveryCount = 0
		ch.Health.AutoDisabled = false
		if err := putJSONTx(ctx, tx, "channels", "id", ch.ID, ch); err != nil {
			return err
		}
		if err := saveManagedCutoffTx(ctx, tx, ch.ID); err != nil {
			return err
		}
	}
	if ch.Config.Cooldown.Error {
		return nil
	}
	creds, err := credentialMapsTx(ctx, tx, ch.ID)
	if err != nil {
		return err
	}
	released := false
	for _, item := range creds {
		data, _ := json.Marshal(item)
		var cr Credential
		if err = json.Unmarshal(data, &cr); err != nil {
			return err
		}
		if cr.Enabled || cr.Reason == nil || cr.DisabledAt == nil || integrationRestriction(cr.Reason) || credentialEngineExpired(cr) {
			continue
		}
		if !adminHTTPReason.MatchString(*cr.Reason) && !strings.Contains(*cr.Reason, "失败率") {
			continue
		}
		item["enabled"] = true
		item["failureCount"] = 0
		item["reason"] = nil
		item["disabledAt"] = nil
		if err = putJSONTx(ctx, tx, "credentials", "id", cr.ID, item); err != nil {
			return err
		}
		released = true
	}
	if released {
		return saveManagedCutoffTx(ctx, tx, ch.ID)
	}
	return nil
}
func (s *Store) portableSetCredentialEnabledTx(ctx context.Context, tx *DBTx, id string, enabled bool) error {
	var item map[string]any
	if err := jsonRowTx(ctx, tx, "credentials", "id", id, &item); err != nil {
		return err
	}
	item["enabled"] = enabled
	item["reason"] = nil
	item["disabledAt"] = nil
	item["failureCount"] = 0
	item["recoveryCount"] = 0
	return putJSONTx(ctx, tx, "credentials", "id", id, item)
}
func (s *Store) portableClaimAccount(ctx context.Context, tx *DBTx, id string, claim *integrationClaim, now int64, force bool) error {
	var raw []byte
	err := tx.QueryRowContext(ctx, "SELECT data,secret FROM gateway_accounts WHERE channel_id=$1 FOR UPDATE", id).Scan(&raw, &claim.ciphertext)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &claim.metadata); err != nil {
		return err
	}
	if claim.metadata.Integration != claim.channel.Config.Integration || claim.metadata.LeaseUntil > now || !force && claim.metadata.NextRefreshAt > now {
		return sql.ErrNoRows
	}
	claim.metadata.LeaseUntil = claim.lease
	return putJSONTx(ctx, tx, "gateway_accounts", "channel_id", id, claim.metadata)
}
func (s *Store) portableClaimCredentialLease(ctx context.Context, tx *DBTx, id string, lease, now int64, force bool) error {
	var until, next int64
	if err := tx.QueryRowContext(ctx, "SELECT lease_until,next_refresh_at FROM credential_balance_jobs WHERE credential_id=$1 FOR UPDATE", id).Scan(&until, &next); err != nil {
		return err
	}
	if until > now || !force && next > now {
		return sql.ErrNoRows
	}
	_, err := tx.ExecContext(ctx, "UPDATE credential_balance_jobs SET lease_until=$2 WHERE credential_id=$1", id, lease)
	return err
}
