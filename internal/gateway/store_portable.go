package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// JSON mutations happen under a short row transaction rather than depending on
// PostgreSQL-only JSON operators. No upstream I/O occurs while a row is locked.
func jsonRowTx(ctx context.Context, tx *DBTx, table, column, id string, dst any) error {
	var data []byte
	err := tx.QueryRowContext(ctx, "SELECT data FROM "+table+" WHERE "+column+"=$1 FOR UPDATE", id).Scan(&data)
	if err != nil {
		return notFound(err)
	}
	return json.Unmarshal(data, dst)
}
func putJSONTx(ctx context.Context, tx *DBTx, table, column, id string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE "+table+" SET data=$2 WHERE "+column+"=$1", id, data)
	return err
}
func (s *Store) portableSaveChannelTx(ctx context.Context, tx *DBTx, ch Channel) error {
	var old Channel
	err := jsonRowTx(ctx, tx, "channels", "id", ch.ID, &old)
	if err == nil {
		ch.Health = old.Health
		ch.Status = old.Status
		ch.Requests = old.Requests
		ch.TTFT = old.TTFT
		ch.SuccessRate = old.SuccessRate
		ch.History = old.History
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	data, err := json.Marshal(ch)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO channels(id,data) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", ch.ID, data); err != nil {
		return err
	}
	return insertTagsTx(ctx, tx, ch.Tags)
}

func insertTagsTx(ctx context.Context, tx *DBTx, tags []string) error {
	tags = append([]string(nil), tags...)
	sort.Strings(tags)
	for index, tag := range tags {
		if index > 0 && tag == tags[index-1] {
			continue
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO tags(name) VALUES($1) ON CONFLICT DO NOTHING", tag); err != nil {
			return err
		}
	}
	return nil
}
func (s *Store) portableSaveCredentialTx(ctx context.Context, tx *DBTx, channelID string, cred Credential, allowInsert bool) error {
	if cred.ID == "" || len(cred.Secret) > 16000 {
		return errors.New("invalid credential")
	}
	var oldChannel, encrypted string
	err := tx.QueryRowContext(ctx, "SELECT channel_id,secret FROM credentials WHERE id=$1 FOR UPDATE", cred.ID).Scan(&oldChannel, &encrypted)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if exists && oldChannel != channelID {
		return ErrConflict
	}
	if !exists && !allowInsert {
		return ErrNotFound
	}
	changed := cred.Secret != ""
	if changed {
		encrypted, err = s.Encrypt(cred.Secret)
		if err != nil {
			return err
		}
		suffix := cred.Secret
		if len(suffix) > 4 {
			suffix = suffix[len(suffix)-4:]
		}
		cred.Preview = "••••" + suffix
	}
	if encrypted == "" {
		return errors.New("credential secret is required")
	}
	if cred.CreatedAt == "" {
		cred.CreatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	data, err := json.Marshal(cred)
	if err != nil {
		return err
	}
	if exists {
		_, err = tx.ExecContext(ctx, "UPDATE credentials SET data=$3,secret=$4 WHERE id=$1 AND channel_id=$2", cred.ID, channelID, data, encrypted)
	} else {
		_, err = tx.ExecContext(ctx, "INSERT INTO credentials(id,channel_id,data,secret) VALUES($1,$2,$3,$4)", cred.ID, channelID, data, encrypted)
	}
	if err != nil {
		return err
	}
	if changed {
		_, err = tx.ExecContext(ctx, "UPDATE credential_balance_jobs SET next_refresh_at=0,lease_until=0 WHERE credential_id=$1", cred.ID)
	}
	return err
}
func (s *Store) portableSaveKey(ctx context.Context, key APIKey) error {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	prior, err := scanKey(tx.QueryRowContext(ctx, "SELECT data,token_hash,used FROM api_keys WHERE id=$1 FOR UPDATE", key.ID))
	exists := err == nil
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	if exists {
		if prior.Status == "revoked" {
			return ErrConflict
		}
		key.Used = prior.Used
		if key.TokenHash == "" {
			key.TokenHash = prior.TokenHash
		}
	} else if key.TokenHash == "" {
		return ErrConflict
	}
	data, err := json.Marshal(key)
	if err != nil {
		return err
	}
	if exists {
		_, err = tx.ExecContext(ctx, "UPDATE api_keys SET data=$2,token_hash=$3 WHERE id=$1", key.ID, data, key.TokenHash)
	} else {
		_, err = tx.ExecContext(ctx, "INSERT INTO api_keys(id,token_hash,data,used) VALUES($1,$2,$3,$4)", key.ID, key.TokenHash, data, key.Used)
	}
	if err != nil {
		return err
	}
	for _, p := range key.Profiles {
		if _, err = tx.ExecContext(ctx, "INSERT INTO profile_usage(key_id,profile_id) VALUES($1,$2) ON CONFLICT DO NOTHING", key.ID, p.ID); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}
func (s *Store) portableBulkKeys(ctx context.Context, ids []string, action string) error {
	if len(ids) < 1 || len(ids) > 200 || !containsString([]string{"enable", "disable", "delete"}, action) {
		return errors.New("invalid bulk selection")
	}
	ids = append([]string(nil), ids...)
	sort.Strings(ids)
	for i, id := range ids {
		if id == "" || i > 0 && id == ids[i-1] {
			return errors.New("invalid or duplicate API key ID")
		}
	}
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	keys := make([]APIKey, len(ids))
	for i, id := range ids {
		keys[i], err = scanKey(tx.QueryRowContext(ctx, "SELECT data,token_hash,used FROM api_keys WHERE id=$1 FOR UPDATE", id))
		if err != nil {
			return err
		}
		if keys[i].Status == "revoked" && action != "delete" {
			return ErrConflict
		}
	}
	for _, key := range keys {
		if action == "delete" {
			_, err = tx.ExecContext(ctx, "DELETE FROM api_keys WHERE id=$1", key.ID)
		} else {
			key.Status = "active"
			if action == "disable" {
				key.Status = "disabled"
			}
			err = putJSONTx(ctx, tx, "api_keys", "id", key.ID, key)
		}
		if err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}
func (s *Store) portableRecordStatsTx(ctx context.Context, tx *DBTx, channelID string, count, success int64, ttft float64, history []int) error {
	var ch Channel
	err := jsonRowTx(ctx, tx, "channels", "id", channelID, &ch)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	ch.SuccessRate = (ch.SuccessRate*float64(ch.Requests) + float64(success)*100) / float64(ch.Requests+count)
	ch.Requests += count
	ch.TTFT = ttft
	ch.History = append(ch.History, history...)
	if len(ch.History) > 20 {
		ch.History = ch.History[len(ch.History)-20:]
	}
	return putJSONTx(ctx, tx, "channels", "id", channelID, ch)
}
func (s *Store) portableTag(ctx context.Context, oldName, newName string, remove bool) error {
	if !remove && oldName == newName {
		return nil
	}
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	replace := func(values []string) []string {
		out := []string{}
		for _, v := range values {
			if v == oldName {
				if !remove && !containsString(out, newName) {
					out = append(out, newName)
				}
			} else if !containsString(out, v) {
				out = append(out, v)
			}
		}
		return out
	}
	// Channel mutations acquire channel rows before tag rows. Match that order
	// before changing a tag so a concurrent channel save cannot form a cycle.
	rows, err := tx.QueryContext(ctx, "SELECT data FROM channels ORDER BY id FOR UPDATE")
	if err != nil {
		return err
	}
	channels := []Channel{}
	for rows.Next() {
		var raw []byte
		var ch Channel
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		if err = json.Unmarshal(raw, &ch); err != nil {
			rows.Close()
			return err
		}
		if containsString(ch.Tags, oldName) {
			ch.Tags = replace(ch.Tags)
			channels = append(channels, ch)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	rows, err = tx.QueryContext(ctx, "SELECT data FROM api_keys ORDER BY id FOR UPDATE")
	if err != nil {
		return err
	}
	keys := []APIKey{}
	for rows.Next() {
		var raw []byte
		var key APIKey
		if err = rows.Scan(&raw); err != nil {
			rows.Close()
			return err
		}
		if err = json.Unmarshal(raw, &key); err != nil {
			rows.Close()
			return err
		}
		keys = append(keys, key)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if remove {
		for _, key := range keys {
			if key.Status != "revoked" {
				for _, p := range key.Profiles {
					if p.Scope == "tags" && containsString(p.Tags, oldName) {
						return fmt.Errorf("%w: tag is referenced by an API key profile", ErrConflict)
					}
				}
			}
		}
		_, err = tx.ExecContext(ctx, "DELETE FROM tags WHERE name=$1", oldName)
	} else {
		var found int
		e := tx.QueryRowContext(ctx, "SELECT 1 FROM tags WHERE name=$1", newName).Scan(&found)
		if e == nil {
			return ErrConflict
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		result, e := tx.ExecContext(ctx, "UPDATE tags SET name=$2 WHERE name=$1", oldName, newName)
		if e != nil {
			return e
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			return ErrNotFound
		}
	}
	if err != nil {
		return err
	}
	for _, ch := range channels {
		if err = putJSONTx(ctx, tx, "channels", "id", ch.ID, ch); err != nil {
			return err
		}
	}
	if !remove {
		for _, key := range keys {
			changed := false
			for i := range key.Profiles {
				if containsString(key.Profiles[i].Tags, oldName) {
					key.Profiles[i].Tags = replace(key.Profiles[i].Tags)
					changed = true
				}
			}
			if changed {
				if err = putJSONTx(ctx, tx, "api_keys", "id", key.ID, key); err != nil {
					return err
				}
			}
		}
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}
func cutoffAllowsTx(ctx context.Context, tx *DBTx, channelID, startedAt string) (bool, error) {
	var value string
	err := tx.QueryRowContext(ctx, "SELECT value FROM gateway_state WHERE id=$1", "health-reset:"+channelID).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	cutoff, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return false, err
	}
	started, err := time.Parse(time.RFC3339Nano, startedAt)
	if err != nil {
		return false, err
	}
	return started.After(cutoff), nil
}
func (s *Store) portableUpdateHealth(ctx context.Context, id string, h Health, status, startedAt string, reset bool) error {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var ch Channel
	if err = jsonRowTx(ctx, tx, "channels", "id", id, &ch); err != nil {
		if errors.Is(err, ErrNotFound) && !reset {
			return nil
		}
		return err
	}
	if startedAt != "" {
		allowed, err := cutoffAllowsTx(ctx, tx, id, startedAt)
		if err != nil {
			return err
		}
		if !allowed {
			return nil
		}
	}
	ch.Health = h
	ch.Status = status
	if err = putJSONTx(ctx, tx, "channels", "id", id, ch); err != nil {
		return err
	}
	if reset {
		if err = saveManagedCutoffTx(ctx, tx, id); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil && reset {
		s.InvalidateCache()
	}
	return err
}
func (s *Store) portableBulkChannels(ctx context.Context, changes []Channel) error {
	if len(changes) < 1 || len(changes) > 200 {
		return errors.New("select 1–200 channels")
	}
	changes = append([]Channel(nil), changes...)
	sort.Slice(changes, func(i, j int) bool { return changes[i].ID < changes[j].ID })
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, ch := range changes {
		if ch.ID == "" || i > 0 && ch.ID == changes[i-1].ID {
			return errors.New("duplicate channel ID")
		}
		var exists int
		if err = tx.QueryRowContext(ctx, "SELECT 1 FROM channels WHERE id=$1 FOR UPDATE", ch.ID).Scan(&exists); err != nil {
			return notFound(err)
		}
	}
	var tags []string
	for _, ch := range changes {
		tags = append(tags, ch.Tags...)
	}
	if err = insertTagsTx(ctx, tx, tags); err != nil {
		return err
	}
	for _, ch := range changes {
		if err = s.saveChannelTx(ctx, tx, ch); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}
func (s *Store) portableReserveChannel(ctx context.Context, ch Channel, tokens int64) (bool, error) {
	limits := ch.Config.RateLimit
	if limits.RequestsPerMinute <= 0 && limits.TokensPerMinute <= 0 {
		return true, nil
	}
	tokens = max(0, tokens)
	ctx, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	minute := time.Now().Unix() / 60
	// Lock the parent first. Concurrent MySQL duplicate inserts otherwise hold
	// shared index locks and deadlock when all upgrade the same minute row.
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT 1 FROM channels WHERE id=$1 FOR UPDATE", ch.ID).Scan(&exists); err != nil {
		return false, notFound(err)
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO channel_rate_limits(channel_id,minute,requests,tokens) VALUES($1,$2,0,0) ON CONFLICT DO NOTHING", ch.ID, minute); err != nil {
		return false, err
	}
	var requests, used int64
	if err = tx.QueryRowContext(ctx, "SELECT requests,tokens FROM channel_rate_limits WHERE channel_id=$1 AND minute=$2 FOR UPDATE", ch.ID, minute).Scan(&requests, &used); err != nil {
		return false, err
	}
	if limits.RequestsPerMinute > 0 && requests >= int64(limits.RequestsPerMinute) || limits.TokensPerMinute > 0 && tokens > int64(limits.TokensPerMinute)-used {
		return false, nil
	}
	if _, err = tx.ExecContext(ctx, "UPDATE channel_rate_limits SET requests=requests+1,tokens=tokens+$3 WHERE channel_id=$1 AND minute=$2", ch.ID, minute, tokens); err != nil {
		return false, err
	}
	err = tx.Commit()
	return err == nil, err
}
func sqlIDs(ids []string, start int) (string, []any) {
	parts := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		parts[i] = "$" + strconv.Itoa(start+i)
		args[i] = id
	}
	return strings.Join(parts, ","), args
}
