package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

type integrationJob struct {
	channelID    string
	credentialID string
	dueAt        int64
}
type integrationClaim struct {
	channel    Channel
	credential Credential
	account    accountCredentials
	metadata   accountMetadata
	ciphertext string
	lease      int64
}

// Lock the destination before reading any credential. UPDATE ... FROM alone is
// unsafe at READ COMMITTED: a waited-on target row can be newer than its joined
// channel snapshot. All edit/claim paths use channel -> credential -> lease.
func integrationLockChannel(ctx context.Context, tx *DBTx, id string) (Channel, error) {
	channel := Channel{Config: DefaultChannelConfig()}
	var data []byte
	if err := tx.QueryRowContext(ctx, `SELECT data FROM channels WHERE id=$1 FOR SHARE`, id).Scan(&data); err != nil {
		return channel, err
	}
	if err := json.Unmarshal(data, &channel); err != nil {
		return channel, err
	}
	return channel, nil
}

// ValidateAccount is called before committing a channel edit so invalid account
// reuse cannot leave a channel partially saved.
func (i *Integrations) ValidateAccount(ctx context.Context, channel Channel, draft map[string]any) error {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	value, present := draft["accountCredentials"]
	if present && value != nil {
		account, err := parseIntegrationCredentials(value)
		if err != nil {
			return err
		}
		return validateIntegrationCredentials(channel.Config.Integration, account)
	}
	if channel.Config.Integration != "newapi" && channel.Config.Integration != "sub2api" {
		return nil
	}
	var data []byte
	err := i.store.db.QueryRowContext(ctx, `SELECT data FROM gateway_accounts WHERE channel_id=$1`, channel.ID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return integrationFailure(400, "开启余额监控或切换后台类型时，请填写对应的后台凭据")
	}
	if err != nil {
		return err
	}
	var metadata accountMetadata
	if err = json.Unmarshal(data, &metadata); err != nil {
		return err
	}
	if metadata.Integration != channel.Config.Integration {
		return integrationFailure(400, "切换后台类型时，请填写对应的后台凭据")
	}
	return nil
}

func (i *Integrations) SaveAccount(ctx context.Context, channelID string, draft map[string]any) error {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	channel, err := i.store.Channel(ctx, channelID)
	if err != nil {
		return err
	}
	if err = i.ValidateAccount(ctx, channel, draft); err != nil {
		return err
	}
	value, present := draft["accountCredentials"]
	if !present || value == nil {
		return nil
	}
	account, err := parseIntegrationCredentials(value)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(account)
	if err != nil {
		return err
	}
	encrypted, err := i.store.Encrypt(string(encoded))
	if err != nil {
		return err
	}
	metadata := accountMetadata{Integration: channel.Config.Integration, AuthMode: account.Mode, Version: time.Now().UnixNano(), Balance: &GatewayBalance{Status: "pending", Unit: ""}}
	data, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = i.store.db.ExecContext(ctx, `INSERT INTO gateway_accounts(channel_id,data,secret) VALUES($1,$2,$3) ON CONFLICT(channel_id) DO UPDATE SET data=EXCLUDED.data,secret=EXCLUDED.secret`, channelID, data, encrypted)
	if err == nil {
		i.store.InvalidateCache()
	}
	return err
}

func (s *Store) integrationDueJobs(ctx context.Context, limit int) ([]integrationJob, error) {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	now := time.Now().UnixMilli()
	// Key jobs are seeded independently so deleting/replacing a key cannot leave
	// an orphaned lease. Channel edits never reuse ciphertext from a stale snapshot.
	_, err := s.db.ExecContext(ctx, `INSERT INTO credential_balance_jobs(credential_id) SELECT k.id FROM credentials k JOIN channels c ON c.id=k.channel_id WHERE c.data->'config'->>'integration'='bbdevlab' AND COALESCE((c.data->>'archived')::boolean,false)=false ON CONFLICT DO NOTHING`)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT channel_id,credential_id,due FROM (SELECT jobs.*,row_number() OVER (PARTITION BY channel_id ORDER BY due,credential_id) AS channel_rank FROM (
	 SELECT a.channel_id,'' AS credential_id,COALESCE((a.data->>'nextRefreshAt')::bigint,0) AS due FROM gateway_accounts a JOIN channels c ON c.id=a.channel_id WHERE COALESCE((a.data->>'leaseUntil')::bigint,0)<=$1 AND COALESCE((a.data->>'nextRefreshAt')::bigint,0)<=$1 AND COALESCE((c.data->>'archived')::boolean,false)=false AND c.data->'config'->>'integration' IN ('newapi','sub2api') AND a.data->>'integration'=c.data->'config'->>'integration'
	 UNION ALL
	 SELECT k.channel_id,k.id,b.next_refresh_at AS due FROM credential_balance_jobs b JOIN credentials k ON k.id=b.credential_id JOIN channels c ON c.id=k.channel_id WHERE b.lease_until<=$1 AND b.next_refresh_at<=$1 AND c.data->'config'->>'integration'='bbdevlab' AND COALESCE((c.data->>'enabled')::boolean,true) AND COALESCE((c.data->>'archived')::boolean,false)=false AND (COALESCE((k.data->>'enabled')::boolean,true) OR k.data->>'reason' IN ($3,$4) OR (k.data->>'reason' LIKE 'HTTP %' AND k.data->>'disabledAt' IS NOT NULL))
	) jobs) fair_jobs ORDER BY channel_rank,due,channel_id,credential_id LIMIT $2`, now, limit, bbExhaustedReason, bbExpiredReason)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []integrationJob{}
	for rows.Next() {
		var job integrationJob
		if err := rows.Scan(&job.channelID, &job.credentialID, &job.dueAt); err != nil {
			return nil, err
		}
		jobs = append(jobs, job)
	}
	return jobs, rows.Err()
}

func (s *Store) claimIntegrationAccount(ctx context.Context, id string, force bool) (*integrationClaim, error) {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	now := time.Now().UnixMilli()
	claim := &integrationClaim{lease: now + 45000}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	claim.channel, err = integrationLockChannel(ctx, tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if claim.channel.Archived || (claim.channel.Config.Integration != "newapi" && claim.channel.Config.Integration != "sub2api") {
		return nil, nil
	}
	err = s.portableClaimAccount(ctx, tx, id, claim, now, force)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	plaintext, err := s.Decrypt(claim.ciphertext)
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal([]byte(plaintext), &claim.account); err != nil {
		return nil, err
	}
	return claim, nil
}

func (i *Integrations) refreshAccount(ctx context.Context, id string, force bool) error {
	claim, err := i.store.claimIntegrationAccount(ctx, id, force)
	if err != nil || claim == nil {
		return err
	}
	jobCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var session integrationSession
	if claim.metadata.Session != "" {
		if plain, err := i.store.Decrypt(claim.metadata.Session); err == nil {
			_ = json.Unmarshal([]byte(plain), &session)
		}
	}
	amount, unit, nextSession, fetchErr := i.fetchAccountBalance(jobCtx, claim.channel, claim.account, session)
	now := integrationNowString()
	balance := &GatewayBalance{Status: "ok", Amount: &amount, Unit: unit, UpdatedAt: &now, CheckedAt: &now}
	if fetchErr != nil {
		balance = &GatewayBalance{Status: "error", CheckedAt: &now, Error: "余额刷新失败，请检查后台连接与凭据"}
		if old := claim.metadata.Balance; old != nil {
			balance.Amount = old.Amount
			balance.Unit = old.Unit
			balance.UpdatedAt = old.UpdatedAt
		}
		var safe *integrationError
		if errors.As(fetchErr, &safe) {
			balance.Error = safe.message
		}
	} else {
		encoded, err := json.Marshal(nextSession)
		if err != nil {
			return err
		}
		claim.metadata.Session, err = i.store.Encrypt(string(encoded))
		if err != nil {
			return err
		}
	}
	claim.metadata.Balance = balance
	claim.metadata.NextRefreshAt = time.Now().Add(5 * time.Minute).UnixMilli()
	claim.metadata.LeaseUntil = 0
	data, err := json.Marshal(claim.metadata)
	if err != nil {
		return err
	}
	// A concurrent credential/endpoint edit invalidates this result, including an
	// otherwise successful login. Never save a response against new credentials.
	writeCtx, writeCancel := storeContext(ctx)
	defer writeCancel()
	tx, err := i.store.db.BeginTx(writeCtx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	currentChannel, err := integrationLockChannel(writeCtx, tx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if currentChannel.Archived || currentChannel.Endpoint != claim.channel.Endpoint || currentChannel.Config.Integration != claim.channel.Config.Integration {
		return nil
	}
	_, err = tx.ExecContext(writeCtx, `UPDATE gateway_accounts SET data=$2 WHERE channel_id=$1 AND secret=$3 AND COALESCE((data->>'leaseUntil')::bigint,0)=$4 AND data->>'integration'=$5`, id, data, claim.ciphertext, claim.lease, claim.channel.Config.Integration)
	if err == nil {
		err = tx.Commit()
	}
	if err == nil {
		i.store.InvalidateCache()
	}
	return err
}

func (s *Store) claimIntegrationCredential(ctx context.Context, channelID, id string, force bool) (*integrationClaim, error) {
	ctx, cancel := storeContext(ctx)
	defer cancel()
	now := time.Now().UnixMilli()
	claim := &integrationClaim{lease: now + 45000}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	claim.channel, err = integrationLockChannel(ctx, tx, channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if claim.channel.Archived || claim.channel.Config.Integration != "bbdevlab" || !force && !claim.channel.Enabled {
		return nil, nil
	}
	var credentialData []byte
	err = tx.QueryRowContext(ctx, `SELECT data,secret FROM credentials WHERE id=$1 AND channel_id=$2 FOR UPDATE`, id, channelID).Scan(&credentialData, &claim.ciphertext)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(credentialData, &claim.credential); err != nil {
		return nil, err
	}
	if !force && !integrationMonitoredCredential(claim.credential) {
		return nil, nil
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO credential_balance_jobs(credential_id) VALUES($1) ON CONFLICT DO NOTHING`, id); err != nil {
		return nil, err
	}
	err = s.portableClaimCredentialLease(ctx, tx, id, claim.lease, now, force)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	claim.credential.Secret, err = s.Decrypt(claim.ciphertext)
	if err != nil {
		return nil, err
	}
	return claim, nil
}

func (i *Integrations) refreshCredential(ctx context.Context, channelID, id string, force bool) error {
	claim, err := i.store.claimIntegrationCredential(ctx, channelID, id, force)
	if err != nil || claim == nil {
		return err
	}
	jobCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	base, fetchErr := integrationAccountBase(claim.channel)
	var amount float64
	var expires *string
	if fetchErr == nil {
		object, _, err := i.accountRequest(jobCtx, base, "/api/usage/token/", http.MethodGet, http.Header{"Authorization": []string{"Bearer " + claim.credential.Secret}}, nil)
		fetchErr = err
		if err == nil {
			data := integrationData(object)
			amount, fetchErr = integrationNumber(data["total_available"])
			if fetchErr == nil {
				amount /= 100000
				expires, fetchErr = integrationParseExpiry(data, claim.credential.Balance)
			}
		}
	}
	now := time.Now()
	stamp := now.UTC().Format(time.RFC3339Nano)
	balance := &GatewayBalance{Status: "ok", Amount: &amount, Unit: "余额", ExpiresAt: expires, UpdatedAt: &stamp, CheckedAt: &stamp}
	if fetchErr != nil {
		balance = &GatewayBalance{Status: "error", Unit: "余额", CheckedAt: &stamp, Error: bbBalanceError}
		if old := claim.credential.Balance; old != nil {
			balance.Amount = old.Amount
			balance.ExpiresAt = old.ExpiresAt
			balance.Unit = old.Unit
			balance.UpdatedAt = old.UpdatedAt
		}
	}
	next := now.Add(time.Minute)
	if balance.ExpiresAt != nil {
		if expiry, err := time.Parse(time.RFC3339Nano, *balance.ExpiresAt); err == nil && expiry.After(now) && expiry.Before(next) {
			next = expiry
		}
	}
	writeCtx, writeCancel := storeContext(ctx)
	defer writeCancel()
	ctx = writeCtx
	tx, err := i.store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	currentChannel, err := integrationLockChannel(ctx, tx, channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if currentChannel.Archived || currentChannel.Endpoint != claim.channel.Endpoint || currentChannel.Config.Integration != "bbdevlab" {
		return nil
	}
	var currentData []byte
	// The channel is already locked (shared on PostgreSQL, exclusive on MySQL).
	// Lock only this key and then its lease: upgrading PostgreSQL's shared
	// channel lock here would deadlock concurrent completions for different keys.
	err = tx.QueryRowContext(ctx, `SELECT data FROM credentials WHERE id=$1 AND channel_id=$2 AND secret=$3 FOR UPDATE`, id, channelID, claim.ciphertext).Scan(&currentData)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var lease int64
	err = tx.QueryRowContext(ctx, `SELECT lease_until FROM credential_balance_jobs WHERE credential_id=$1 FOR UPDATE`, id).Scan(&lease)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if lease != claim.lease {
		return nil
	}
	var current Credential
	if err = json.Unmarshal(currentData, &current); err != nil {
		return err
	}
	current.Balance = balance
	current.ExpiresAt = balance.ExpiresAt
	// Manual disables never recover automatically. A failed refresh retains both
	// the last known quota and a confirmed expiration, so errors cannot revive keys.
	if integrationMonitoredCredential(current) {
		restriction := ""
		if integrationBalanceExpired(balance, now) {
			restriction = bbExpiredReason
		} else if fetchErr == nil && amount <= 0 {
			restriction = bbExhaustedReason
		}
		if restriction != "" {
			current.Enabled = false
			current.Reason = &restriction
			current.DisabledAt = nil
			current.FailureCount = 0
		} else if fetchErr == nil && integrationRestriction(current.Reason) {
			current.Enabled = true
			current.Reason = nil
			current.DisabledAt = nil
			current.FailureCount = 0
		}
	}
	data, err := json.Marshal(current)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE credentials SET data=$3 WHERE id=$1 AND channel_id=$2`, id, channelID, data); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE credential_balance_jobs SET next_refresh_at=$2,lease_until=0 WHERE credential_id=$1 AND lease_until=$3`, id, next.UnixMilli(), claim.lease); err != nil {
		return err
	}
	err = tx.Commit()
	if err == nil {
		i.store.InvalidateCache()
	}
	return err
}

// IntegrationAccountMetadata merges only nonsecret management metadata.
func IntegrationAccountMetadata(channel *Channel, data []byte) {
	var metadata accountMetadata
	if len(data) == 0 || json.Unmarshal(data, &metadata) != nil {
		return
	}
	channel.HasAccountCredentials = true
	channel.AccountAuthMode = metadata.AuthMode
	channel.AccountIntegration = metadata.Integration
	if metadata.Integration == channel.Config.Integration && channel.Config.Integration != "bbdevlab" {
		channel.AccountBalance = metadata.Balance
	}
}

func isIntegrationHTTPRestriction(credential Credential) bool {
	return credential.Reason != nil && strings.HasPrefix(*credential.Reason, "HTTP ") && credential.DisabledAt != nil
}
