package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"
)

// D1Snapshot contains original D1 table rows. Secret fields remain AES-GCM
// ciphertext throughout export, validation and import.
type D1Snapshot struct {
	Version    int                                     `json:"version"`
	ExportedAt string                                  `json:"exportedAt,omitempty"`
	Tables     map[string][]map[string]json.RawMessage `json:"tables"`
}
type D1ImportResult struct {
	Channels       int `json:"channels"`
	Credentials    int `json:"credentials"`
	APIKeys        int `json:"apiKeys"`
	Profiles       int `json:"profileUsage"`
	Accounts       int `json:"accounts"`
	Logs           int `json:"logs"`
	Attempts       int `json:"attempts"`
	Events         int `json:"events"`
	Tags           int `json:"tags"`
	SyntheticLogs  int `json:"syntheticLogs"`
	DirectChannels int `json:"convertedDirectChannels"`
}
type d1Insert struct {
	table string
	query string
	args  []any
}
type d1Prepared struct {
	inserts []d1Insert
	result  D1ImportResult
}

func ReadD1Snapshot(reader io.Reader) (D1Snapshot, error) {
	var snapshot D1Snapshot
	decoder := json.NewDecoder(io.LimitReader(reader, (1<<30)+1))
	if err := decoder.Decode(&snapshot); err != nil {
		return snapshot, errors.New("invalid migration snapshot JSON (maximum 1 GiB)")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return snapshot, errors.New("snapshot must contain one JSON object")
	}
	if snapshot.Version != 1 || snapshot.Tables == nil {
		return snapshot, errors.New("unsupported migration snapshot version")
	}
	return snapshot, nil
}
func d1Text(row map[string]json.RawMessage, key string) string {
	var text string
	_ = json.Unmarshal(row[key], &text)
	return text
}
func d1NullableText(row map[string]json.RawMessage, key string) *string {
	raw, ok := row[key]
	if !ok || string(raw) == "null" {
		return nil
	}
	value := d1Text(row, key)
	return &value
}
func d1Int(row map[string]json.RawMessage, key string) (int64, error) {
	raw, present := row[key]
	if !present {
		return 0, nil
	}
	var integer int64
	if json.Unmarshal(raw, &integer) != nil {
		return 0, fmt.Errorf("invalid integer field %s", key)
	}
	return integer, nil
}
func d1Object(row map[string]json.RawMessage, key string, dst any) error {
	raw, present := row[key]
	if !present || string(raw) == "null" {
		return fmt.Errorf("missing JSON field %s", key)
	}
	if len(raw) > 0 && raw[0] == '"' {
		var text string
		if json.Unmarshal(raw, &text) != nil {
			return fmt.Errorf("invalid JSON field %s", key)
		}
		raw = []byte(text)
	}
	if json.Unmarshal(raw, dst) != nil {
		return fmt.Errorf("invalid JSON field %s", key)
	}
	return nil
}
func d1JSON(value any) []byte { data, _ := json.Marshal(value); return data }
func d1Time(value string) (time.Time, error) {
	stamp, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return stamp, errors.New("snapshot contains an invalid timestamp")
	}
	return stamp, nil
}
func (p *d1Prepared) add(table, query string, args ...any) {
	p.inserts = append(p.inserts, d1Insert{table: table, query: query, args: args})
}

var d1Hash = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func (s *Store) prepareD1Import(snapshot D1Snapshot) (d1Prepared, error) {
	p := d1Prepared{}
	if snapshot.Version != 1 || snapshot.Tables == nil {
		return p, errors.New("unsupported migration snapshot version")
	}
	channels := map[string]Channel{}
	credentials := map[string]bool{}
	keys := map[string]bool{}
	for _, row := range snapshot.Tables["channels"] {
		var channel = Channel{Config: DefaultChannelConfig(), DisplayMultiplier: 1}
		if err := d1Object(row, "data", &channel); err != nil {
			return p, err
		}
		id := d1Text(row, "id")
		if id == "" || channel.ID != id || channels[id].ID != "" {
			return p, errors.New("snapshot contains an invalid or duplicate channel ID")
		}
		if channel.Config.GatewayMode == "ai-gateway" {
			channel.Config.GatewayMode = "direct"
			p.result.DirectChannels++
		}
		channel.HasAccountCredentials = false
		channel.AccountBalance = nil
		channels[id] = channel
		p.add("channels", `INSERT INTO channels(id,data) VALUES($1,$2)`, id, d1JSON(channel))
		p.result.Channels++
	}
	balances := map[string]*GatewayBalance{}
	for _, row := range snapshot.Tables["credential_balances"] {
		id := d1Text(row, "credential_id")
		if raw := row["balance"]; len(raw) == 0 || string(raw) == "null" {
			continue
		}
		var balance GatewayBalance
		if err := d1Object(row, "balance", &balance); err != nil {
			return p, err
		}
		balances[id] = &balance
	}
	for _, row := range snapshot.Tables["credentials"] {
		id, channelID, secret := d1Text(row, "id"), d1Text(row, "channel_id"), d1Text(row, "secret")
		if id == "" || credentials[id] || channels[channelID].ID == "" {
			return p, errors.New("snapshot credential references an invalid channel or duplicate ID")
		}
		if _, err := s.Decrypt(secret); err != nil {
			return p, errors.New("credential decryption failed; import requires the original ENCRYPTION_KEY")
		}
		enabled, err := d1Int(row, "enabled")
		if err != nil {
			return p, err
		}
		failure, err := d1Int(row, "failure_count")
		if err != nil {
			return p, err
		}
		recovery, err := d1Int(row, "recovery_count")
		if err != nil {
			return p, err
		}
		credential := Credential{ID: id, Label: d1Text(row, "label"), Preview: d1Text(row, "preview"), Enabled: enabled != 0, FailureCount: int(failure), DisabledAt: d1NullableText(row, "disabled_at"), Reason: d1NullableText(row, "reason"), CreatedAt: d1Text(row, "created_at")}
		if channels[channelID].Config.Integration == "bbdevlab" {
			credential.Balance = balances[id]
			if credential.Balance != nil {
				credential.ExpiresAt = credential.Balance.ExpiresAt
			}
		}
		data := map[string]any{}
		_ = json.Unmarshal(d1JSON(credential), &data)
		data["recoveryCount"] = recovery
		p.add("credentials", `INSERT INTO credentials(id,channel_id,data,secret) VALUES($1,$2,$3,$4)`, id, channelID, d1JSON(data), secret)
		credentials[id] = true
		p.result.Credentials++
		if channels[channelID].Config.Integration == "bbdevlab" {
			p.add("credential_balance_jobs", `INSERT INTO credential_balance_jobs(credential_id) VALUES($1)`, id)
		}
	}
	for _, row := range snapshot.Tables["api_keys"] {
		var key APIKey
		if err := d1Object(row, "data", &key); err != nil {
			return p, err
		}
		id, hash := d1Text(row, "id"), d1Text(row, "token_hash")
		if id == "" || key.ID != id || keys[id] || !d1Hash.MatchString(hash) {
			return p, errors.New("snapshot contains an invalid API key ID or token hash")
		}
		used, err := d1Int(row, "used")
		if err != nil || used < 0 {
			return p, errors.New("snapshot contains an invalid API key usage counter")
		}
		key.Used = used
		p.add("api_keys", `INSERT INTO api_keys(id,token_hash,data,used) VALUES($1,$2,$3,$4)`, id, strings.ToLower(hash), d1JSON(key), used)
		keys[id] = true
		p.result.APIKeys++
	}
	for _, row := range snapshot.Tables["profile_usage"] {
		id := d1Text(row, "key_id")
		profileID := d1Text(row, "profile_id")
		used, err := d1Int(row, "used")
		if !keys[id] || profileID == "" || err != nil || used < 0 {
			return p, errors.New("snapshot contains an invalid profile usage counter")
		}
		p.add("profile_usage", `INSERT INTO profile_usage(key_id,profile_id,used) VALUES($1,$2,$3)`, id, profileID, used)
		p.result.Profiles++
	}
	for _, row := range snapshot.Tables["settings"] {
		if d1Text(row, "id") != "gateway" {
			continue
		}
		settings := DefaultSettings()
		if err := d1Object(row, "value", &settings); err != nil {
			return p, err
		}
		settings.AIGatewayEnabled = false
		settings.HasAIGatewayToken = false
		p.add("settings", `INSERT INTO settings(id,data) VALUES('gateway',$1)`, d1JSON(settings))
	}
	tags := map[string]bool{}
	for _, row := range snapshot.Tables["tags"] {
		name := d1Text(row, "name")
		if name == "" || tags[name] {
			return p, errors.New("snapshot contains an invalid or duplicate tag")
		}
		tags[name] = true
		p.add("tags", `INSERT INTO tags(name) VALUES($1)`, name)
		p.result.Tags++
	}
	for _, channel := range channels {
		for _, tag := range channel.Tags {
			if tag != "" && !tags[tag] {
				tags[tag] = true
				p.add("tags", `INSERT INTO tags(name) VALUES($1)`, tag)
				p.result.Tags++
			}
		}
	}
	for _, row := range snapshot.Tables["channel_accounts"] {
		id := d1Text(row, "channel_id")
		channel, exists := channels[id]
		if !exists {
			return p, errors.New("snapshot account references an invalid channel")
		}
		plain, err := s.Decrypt(d1Text(row, "credentials"))
		if err != nil {
			return p, errors.New("account decryption failed; import requires the original ENCRYPTION_KEY")
		}
		var raw map[string]any
		if json.Unmarshal([]byte(plain), &raw) != nil {
			return p, errors.New("snapshot account credentials contain invalid JSON")
		}
		delete(raw, "mode")
		account, err := parseIntegrationCredentials(raw)
		if err != nil {
			return p, errors.New("snapshot account credentials have an unsupported format")
		}
		encrypted, err := s.Encrypt(string(d1JSON(account)))
		if err != nil {
			return p, err
		}
		integration := channel.AccountIntegration
		if integration == "" {
			integration = channel.Config.Integration
		}
		metadata := accountMetadata{Integration: integration, AuthMode: account.Mode, Version: 1, Balance: &GatewayBalance{Status: "pending", Unit: ""}}
		if balance := row["balance"]; len(balance) > 0 && string(balance) != "null" {
			var old GatewayBalance
			if err = d1Object(row, "balance", &old); err != nil {
				return p, err
			}
			metadata.Balance = &old
		}
		p.add("gateway_accounts", `INSERT INTO gateway_accounts(channel_id,data,secret) VALUES($1,$2,$3)`, id, d1JSON(metadata), encrypted)
		p.result.Accounts++
	}
	logIDs := map[string]bool{}
	for _, row := range snapshot.Tables["request_logs"] {
		var log RequestLog
		if err := d1Object(row, "data", &log); err != nil {
			return p, err
		}
		id := d1Text(row, "id")
		if id == "" || log.ID != id || logIDs[id] {
			return p, errors.New("snapshot contains an invalid or duplicate request log")
		}
		createdAt, err := d1Time(d1Text(row, "created_at"))
		if err != nil {
			return p, err
		}
		p.add("request_logs", `INSERT INTO request_logs(id,created_at,channel_id,result,source,model,data) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, createdAt, d1NullableText(row, "channel_id"), d1Text(row, "result"), d1Text(row, "source"), d1Text(row, "model"), d1JSON(log))
		logIDs[id] = true
		p.result.Logs++
	}
	// The old attempts table had no foreign key. Reconstruct an unfinished log
	// for a crashed request rather than discarding historical attempt records.
	type importedAttempt struct {
		attempt Attempt
		created time.Time
	}
	attempts := []importedAttempt{}
	orphans := map[string][]Attempt{}
	for _, row := range snapshot.Tables["attempts"] {
		var attempt Attempt
		if err := d1Object(row, "data", &attempt); err != nil {
			return p, err
		}
		if attempt.ID == "" || attempt.ID != d1Text(row, "id") || attempt.RequestID == "" || attempt.RequestID != d1Text(row, "request_id") {
			return p, errors.New("snapshot contains an invalid attempt ID")
		}
		createdAt, err := d1Time(d1Text(row, "started_at"))
		if err != nil {
			return p, err
		}
		attempts = append(attempts, importedAttempt{attempt, createdAt})
		if !logIDs[attempt.RequestID] {
			orphans[attempt.RequestID] = append(orphans[attempt.RequestID], attempt)
		}
	}
	for id, group := range orphans {
		first := group[0]
		for _, attempt := range group {
			if attempt.StartedAt < first.StartedAt {
				first = attempt
			}
		}
		stamp, err := d1Time(first.StartedAt)
		if err != nil {
			return p, err
		}
		message := "D1 导入时恢复的未完成请求记录"
		channelID := first.ChannelID
		log := RequestLog{ID: id, CreatedAt: first.StartedAt, Time: stamp.Format("15:04:05"), Model: first.Model, Channel: first.ChannelName, ChannelID: &channelID, Stream: first.Stream, Status: 0, Result: "error", Attempts: len(group), Source: "api", Error: &message}
		p.add("request_logs", `INSERT INTO request_logs(id,created_at,channel_id,result,source,model,data) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, stamp, channelID, "error", "api", first.Model, d1JSON(log))
		p.result.Logs++
		p.result.SyntheticLogs++
	}
	for _, item := range attempts {
		attempt := item.attempt
		p.add("attempts", `INSERT INTO attempts(id,request_id,channel_id,started_at,data) VALUES($1,$2,$3,$4,$5)`, attempt.ID, attempt.RequestID, attempt.ChannelID, item.created, d1JSON(attempt))
		p.result.Attempts++
	}
	for _, row := range snapshot.Tables["events"] {
		var event Event
		if err := d1Object(row, "data", &event); err != nil {
			return p, err
		}
		id := d1Text(row, "id")
		if id == "" || event.ID != id {
			return p, errors.New("snapshot contains an invalid event ID")
		}
		stamp, err := d1Time(d1Text(row, "created_at"))
		if err != nil {
			return p, err
		}
		p.add("events", `INSERT INTO events(id,created_at,data) VALUES($1,$2,$3)`, id, stamp, d1JSON(event))
		p.result.Events++
	}
	return p, nil
}

// ImportD1 validates all secrets before writing, refuses populated databases,
// and commits the complete migration in one transaction. It never truncates data.
func (s *Store) ImportD1(ctx context.Context, snapshot D1Snapshot) (D1ImportResult, error) {
	prepared, err := s.prepareD1Import(snapshot)
	if err != nil {
		return D1ImportResult{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return D1ImportResult{}, err
	}
	defer tx.Rollback()
	if s.db.Dialect() == "postgres" {
		if _, err = tx.ExecContext(ctx, `LOCK TABLE channels,credentials,api_keys,profile_usage,settings,tags,request_logs,attempts,events,gateway_accounts,gateway_state,credential_balance_jobs,channel_rate_limits IN ACCESS EXCLUSIVE MODE`); err != nil {
			return D1ImportResult{}, errors.New("could not lock target database; stop the application before importing")
		}
	}
	var populated bool
	// A fresh browser installation may already have administrator login
	// sessions. Those are preserved and do not count as application data.
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM channels UNION ALL SELECT 1 FROM credentials UNION ALL SELECT 1 FROM api_keys UNION ALL SELECT 1 FROM profile_usage UNION ALL SELECT 1 FROM settings UNION ALL SELECT 1 FROM tags UNION ALL SELECT 1 FROM request_logs UNION ALL SELECT 1 FROM attempts UNION ALL SELECT 1 FROM events UNION ALL SELECT 1 FROM gateway_accounts UNION ALL SELECT 1 FROM gateway_state WHERE id NOT LIKE 'session:%' UNION ALL SELECT 1 FROM credential_balance_jobs UNION ALL SELECT 1 FROM channel_rate_limits)`).Scan(&populated); err != nil {
		return D1ImportResult{}, err
	}
	if populated {
		return D1ImportResult{}, errors.New("target database is not empty; import requires a new empty database")
	}
	for index, insert := range prepared.inserts {
		if _, err = tx.ExecContext(ctx, insert.query, insert.args...); err != nil {
			return D1ImportResult{}, fmt.Errorf("import %s item %d failed; transaction rolled back: %w", insert.table, index, err)
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO settings(id,data) VALUES('migration_d1',$1)`, d1JSON(map[string]any{"version": 1, "importedAt": integrationNowString()})); err != nil {
		return D1ImportResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return D1ImportResult{}, err
	}
	s.InvalidateCache()
	return prepared.result, nil
}
