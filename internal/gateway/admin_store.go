package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"
	"time"
)

type managedBundle struct {
	channel       Channel
	adds, updates []Credential
	deletes       []string
	accountData   []byte
	accountSecret string
	mustExist     bool
}

func (h *Handler) prepareAccountBundle(c Channel, b map[string]any) (managedBundle, error) {
	bundle := managedBundle{channel: c}
	value, present := b["accountCredentials"]
	if !present || value == nil {
		return bundle, nil
	}
	account, err := parseIntegrationCredentials(value)
	if err != nil {
		return bundle, err
	}
	if err = validateIntegrationCredentials(c.Config.Integration, account); err != nil {
		return bundle, err
	}
	encoded, err := json.Marshal(account)
	if err != nil {
		return bundle, err
	}
	bundle.accountSecret, err = h.store.Encrypt(string(encoded))
	if err != nil {
		return bundle, err
	}
	bundle.accountData, err = json.Marshal(accountMetadata{Integration: c.Config.Integration, AuthMode: account.Mode, Version: time.Now().UnixNano(), Balance: &GatewayBalance{Status: "pending", Unit: ""}})
	return bundle, err
}
func (s *Store) saveManagedBundles(ctx context.Context, bundles []managedBundle) error {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Match claim and completion lock ordering: channel, credentials, account.
	// Sort multi-channel mutations so concurrent bulk writes cannot form cycles.
	bundles = append([]managedBundle(nil), bundles...)
	sort.Slice(bundles, func(i, j int) bool { return bundles[i].channel.ID < bundles[j].channel.ID })
	seen := map[string]bool{}
	previousRows := make(map[string][]byte, len(bundles))
	var tags []string
	for _, b := range bundles {
		if b.channel.ID == "" || seen[b.channel.ID] {
			return errors.New("invalid or duplicate channel ID")
		}
		seen[b.channel.ID] = true
		var previousRaw []byte
		err = tx.QueryRowContext(ctx, "SELECT data FROM channels WHERE id=$1 FOR UPDATE", b.channel.ID).Scan(&previousRaw)
		if errors.Is(err, sql.ErrNoRows) {
			if b.mustExist {
				return ErrNotFound
			}
		} else if err != nil {
			return err
		}
		previousRows[b.channel.ID] = previousRaw
		tags = append(tags, b.channel.Tags...)
	}
	// Acquire the complete channel set before shared tag rows. Different bulk
	// selections can overlap on a later channel while carrying the same tags.
	if err = insertTagsTx(ctx, tx, tags); err != nil {
		return err
	}
	for _, b := range bundles {
		var previous Channel
		previousRaw := previousRows[b.channel.ID]
		if len(previousRaw) > 0 {
			if err = json.Unmarshal(previousRaw, &previous); err != nil {
				return err
			}
		}
		if err = s.saveChannelTx(ctx, tx, b.channel); err != nil {
			return err
		}
		for _, cr := range b.adds {
			if cr.Secret == "" {
				return errors.New("credential secret is required")
			}
			if err = s.saveCredentialTx(ctx, tx, b.channel.ID, cr, true); err != nil {
				return err
			}
		}
		for _, cr := range b.updates {
			if err = s.saveManagedCredentialTx(ctx, tx, b.channel.ID, cr); err != nil {
				return err
			}
		}
		for _, id := range b.deletes {
			result, e := tx.ExecContext(ctx, "DELETE FROM credentials WHERE id=$1 AND channel_id=$2", id, b.channel.ID)
			if e != nil {
				return e
			}
			n, _ := result.RowsAffected()
			if n != 1 {
				return ErrNotFound
			}
		}
		if b.accountData != nil {
			if _, err = tx.ExecContext(ctx, `INSERT INTO gateway_accounts(channel_id,data,secret) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET data=EXCLUDED.data,secret=EXCLUDED.secret`, b.channel.ID, b.accountData, b.accountSecret); err != nil {
				return err
			}
		} else if b.channel.Config.Integration == "newapi" || b.channel.Config.Integration == "sub2api" {
			var integration string
			if err = tx.QueryRowContext(ctx, "SELECT data->>'integration' FROM gateway_accounts WHERE channel_id=$1 FOR UPDATE", b.channel.ID).Scan(&integration); err == sql.ErrNoRows {
				return ErrConflict
			} else if err != nil {
				return err
			}
			if integration != b.channel.Config.Integration {
				return ErrConflict
			}
		}
		if len(previousRaw) > 0 && (previous.Endpoint != b.channel.Endpoint || previous.Config.Integration != b.channel.Config.Integration) {
			if err = s.resetManagedBalancesTx(ctx, tx, b.channel.ID, b.accountData == nil); err != nil {
				return err
			}
		}
		if err = s.releaseExemptCooldownsTx(ctx, tx, b.channel); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}

// A label edit must merge with current key health/balance. A stale console
// snapshot cannot silently revive an exhausted key or undo a manual disable.
func (s *Store) saveManagedCredentialTx(ctx context.Context, tx *DBTx, channelID string, edit Credential) error {
	var raw []byte
	var encrypted string
	if err := tx.QueryRowContext(ctx, "SELECT data,secret FROM credentials WHERE id=$1 AND channel_id=$2 FOR UPDATE", edit.ID, channelID).Scan(&raw, &encrypted); err != nil {
		return notFound(err)
	}
	var current Credential
	if err := json.Unmarshal(raw, &current); err != nil {
		return err
	}
	secret, err := s.Decrypt(encrypted)
	if err != nil {
		return err
	}
	if edit.Label != "" {
		current.Label = edit.Label
	}
	if edit.Secret != "" && edit.Secret != secret {
		current.Secret = edit.Secret
		current.Preview = ""
		current.Balance = nil
		current.ExpiresAt = nil
		if integrationRestriction(current.Reason) {
			current.Enabled = true
		}
		current.FailureCount = 0
		current.Reason = nil
		current.DisabledAt = nil
	} else {
		current.Secret = ""
	}
	return s.saveCredentialTx(ctx, tx, channelID, current, false)
}

// PatchManagedCredential merges a single console patch with current key state,
// using the same channel-to-key lock order as balance claims and batch edits.
// Empty Secret/Label mean omitted; manual activation is an explicit pointer.
func (s *Store) PatchManagedCredential(ctx context.Context, channelID string, edit Credential, enabled *bool) (Credential, error) {
	c, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(c, nil)
	if err != nil {
		return Credential{}, err
	}
	defer tx.Rollback()
	var exists int
	if err = tx.QueryRowContext(c, "SELECT 1 FROM channels WHERE id=$1 FOR SHARE", channelID).Scan(&exists); err != nil {
		return Credential{}, notFound(err)
	}
	if err = s.saveManagedCredentialTx(c, tx, channelID, edit); err != nil {
		return Credential{}, err
	}
	if enabled != nil {
		err = s.portableSetCredentialEnabledTx(c, tx, edit.ID, *enabled)
		if err != nil {
			return Credential{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return Credential{}, err
	}
	s.InvalidateCache()
	credentials, err := s.Credentials(ctx, channelID, true)
	if err != nil {
		return Credential{}, err
	}
	for _, credential := range credentials {
		if credential.ID == edit.ID {
			return credential, nil
		}
	}
	return Credential{}, ErrNotFound
}

func (s *Store) resetManagedBalancesTx(ctx context.Context, tx *DBTx, id string, resetAccount bool) error {
	return s.portableResetManagedBalancesTx(ctx, tx, id, resetAccount)
}

var adminHTTPPrefix = regexp.MustCompile(`(?i)^HTTP\b`)
var adminHTTPReason = regexp.MustCompile(`(?i)(^|\s)HTTP\b`)
var adminFirstTokenReason = regexp.MustCompile(`(?i)首\s*Token`)

func adminErrorRestriction(health Health) bool {
	reason := ""
	if health.Reason != nil {
		reason = *health.Reason
	}
	return health.AutoDisabled || adminHTTPPrefix.MatchString(reason) || strings.Contains(reason, "失败率")
}
func adminCooldownExempt(channel Channel) bool {
	if adminErrorRestriction(channel.Health) {
		return !channel.Config.Cooldown.Error
	}
	reason := ""
	if channel.Health.Reason != nil {
		reason = *channel.Health.Reason
	}
	return !channel.Config.Cooldown.FirstToken && (strings.Contains(reason, "首字") || adminFirstTokenReason.MatchString(reason))
}

func (s *Store) releaseExemptCooldownsTx(ctx context.Context, tx *DBTx, ch Channel) error {
	return s.portableReleaseExemptTx(ctx, tx, ch)
}

func saveManagedCutoffTx(ctx context.Context, tx *DBTx, id string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO gateway_state(id,value) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET value=excluded.value", "health-reset:"+id, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}
func (s *Store) ProbeLogs(ctx context.Context, channelID string) ([]RequestLog, error) {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	rows, err := s.db.QueryContext(ctx, "SELECT data FROM request_logs WHERE channel_id=$1 AND source='probe' ORDER BY created_at DESC LIMIT 50", channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	logs := []RequestLog{}
	for rows.Next() {
		var data []byte
		var item RequestLog
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &item); err != nil {
			return nil, err
		}
		logs = append(logs, item)
	}
	return logs, rows.Err()
}
