package gateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var ErrNotFound = errors.New("not found")
var ErrConflict = errors.New("resource conflict")

//go:embed migrations
var migrations embed.FS

type cacheEntry struct {
	value   any
	expires time.Time
}
type cacheFlight struct{ done chan struct{} }
type Store struct {
	db      *DB
	aead    cipher.AEAD
	cacheMu sync.Mutex
	cache   map[string]cacheEntry
	flights map[string]*cacheFlight
	epoch   uint64
}

func NewStore(ctx context.Context, databaseURL, encryptionKey string) (*Store, error) {
	key, err := base64.StdEncoding.DecodeString(encryptionKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("ENCRYPTION_KEY must be a base64 encoded 32 byte key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	db, err := openDatabase(databaseURL)
	if err != nil {
		return nil, err
	}
	s := &Store{db: db, aead: aead, cache: make(map[string]cacheEntry), flights: make(map[string]*cacheFlight)}
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err = db.PingContext(startup); err != nil {
		db.Close()
		return nil, fmt.Errorf("connect database: %w", err)
	}
	if err = s.migrate(startup); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func envPoolSize(name string, fallback int) int {
	n, err := strconv.Atoi(os.Getenv(name))
	if err != nil || n < 1 || n > 1000 {
		return fallback
	}
	return n
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) DB() *DB      { return s.db }
func storeContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 3*time.Second)
}
func (s *Store) migratePostgres(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(732469235154)"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"); err != nil {
		return err
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.IsDir() {
			continue
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=$1)", file.Name()).Scan(&exists); err != nil {
			return err
		}
		if exists {
			continue
		}
		body, readErr := migrations.ReadFile("migrations/" + file.Name())
		if readErr != nil {
			return readErr
		}
		if _, err = tx.ExecContext(ctx, string(body)); err != nil {
			return fmt.Errorf("migration %s: %w", file.Name(), err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO schema_migrations(name) VALUES($1)", file.Name()); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// InvalidateCache is synchronous. A load started before an admin write cannot
// repopulate the cache after this call; network/database work never holds cacheMu.
func (s *Store) InvalidateCache() { s.cacheMu.Lock(); s.epoch++; clear(s.cache); s.cacheMu.Unlock() }
func (s *Store) cached(ctx context.Context, key string, load func() (any, error)) (any, error) {
	for {
		s.cacheMu.Lock()
		if hit, ok := s.cache[key]; ok && time.Now().Before(hit.expires) {
			s.cacheMu.Unlock()
			return hit.value, nil
		}
		if flight := s.flights[key]; flight != nil {
			done := flight.done
			s.cacheMu.Unlock()
			select {
			case <-done:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		flight := &cacheFlight{done: make(chan struct{})}
		s.flights[key] = flight
		epoch := s.epoch
		s.cacheMu.Unlock()
		value, err := load()
		s.cacheMu.Lock()
		if err == nil && epoch == s.epoch {
			if len(s.cache) >= 4096 {
				clear(s.cache)
			}
			s.cache[key] = cacheEntry{value: value, expires: time.Now().Add(2 * time.Second)}
		}
		delete(s.flights, key)
		close(flight.done)
		s.cacheMu.Unlock()
		return value, err
	}
}

func cloneJSON[T any](v T) T {
	data, _ := json.Marshal(v)
	var copy T
	_ = json.Unmarshal(data, &copy)
	return copy
}
func jsonData(v any) ([]byte, error) { return json.Marshal(v) }
func notFound(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}
func (s *Store) Encrypt(value string) (string, error) {
	iv := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", err
	}
	data := s.aead.Seal(nil, iv, []byte(value), nil)
	return "v1:" + base64.StdEncoding.EncodeToString(iv) + ":" + base64.StdEncoding.EncodeToString(data), nil
}
func (s *Store) Decrypt(value string) (string, error) {
	parts := strings.Split(value, ":")
	if len(parts) != 3 || parts[0] != "v1" {
		return "", errors.New("unsupported encrypted credential")
	}
	iv, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil || len(iv) != s.aead.NonceSize() {
		return "", errors.New("invalid encrypted credential nonce")
	}
	data, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return "", errors.New("invalid encrypted credential ciphertext")
	}
	plain, err := s.aead.Open(nil, iv, data, nil)
	if err != nil {
		return "", errors.New("credential decryption failed; verify ENCRYPTION_KEY")
	}
	return string(plain), nil
}
func HashToken(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}
func NewToken() (string, error) {
	var data [32]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return "pg_live_" + base64.RawURLEncoding.EncodeToString(data[:]), nil
}

func (s *Store) Settings(ctx context.Context) (Settings, error) {
	v, err := s.cached(ctx, "settings", func() (any, error) {
		c, cancel := storeContext(ctx)
		defer cancel()
		settings := DefaultSettings()
		var data []byte
		err := s.db.QueryRowContext(c, "SELECT data FROM settings WHERE id='gateway'").Scan(&data)
		if errors.Is(err, sql.ErrNoRows) {
			return settings, nil
		}
		if err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &settings); err != nil {
			return nil, err
		}
		return settings, nil
	})
	if err != nil {
		return Settings{}, err
	}
	return cloneJSON(v.(Settings)), nil
}
func (s *Store) SaveSettings(ctx context.Context, settings Settings) error {
	// Cloudflare's gateway is intentionally unavailable in the standalone backend.
	settings.AIGatewayEnabled = false
	settings.HasAIGatewayToken = false
	data, err := jsonData(settings)
	if err != nil {
		return err
	}
	c, cancel := storeContext(ctx)
	defer cancel()
	_, err = s.db.ExecContext(c, "INSERT INTO settings(id,data) VALUES('gateway',$1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", data)
	if err == nil {
		s.InvalidateCache()
	}
	return err
}
func (s *Store) Channels(ctx context.Context) ([]Channel, error) {
	v, err := s.cached(ctx, "channels", func() (any, error) {
		c, cancel := storeContext(ctx)
		defer cancel()
		rows, err := s.db.QueryContext(c, "SELECT c.data,(SELECT count(*) FROM credentials cr WHERE cr.channel_id=c.id),a.data FROM channels c LEFT JOIN gateway_accounts a ON a.channel_id=c.id ORDER BY c.data->>'createdAt' DESC,c.id")
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []Channel{}
		for rows.Next() {
			var data, account []byte
			var count int
			if err = rows.Scan(&data, &count, &account); err != nil {
				return nil, err
			}
			ch := Channel{Config: DefaultChannelConfig(), DisplayMultiplier: 1}
			if err = json.Unmarshal(data, &ch); err != nil {
				return nil, err
			}
			ch.CredentialCount = count
			IntegrationAccountMetadata(&ch, account)
			out = append(out, ch)
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
		rows.Close()
		for idx := range out {
			if out[idx].Config.Integration == "bbdevlab" {
				creds, e := s.Credentials(ctx, out[idx].ID, true)
				if e != nil {
					return nil, e
				}
				out[idx].AccountBalance = credentialBalanceSummary(creds, time.Now())
			}
		}
		return out, nil
	})
	if err != nil {
		return nil, err
	}
	return cloneJSON(v.([]Channel)), nil
}
func (s *Store) Channel(ctx context.Context, id string) (Channel, error) {
	channels, err := s.Channels(ctx)
	if err != nil {
		return Channel{}, err
	}
	for _, c := range channels {
		if c.ID == id {
			return c, nil
		}
	}
	return Channel{}, ErrNotFound
}
func (s *Store) SaveChannel(ctx context.Context, ch Channel) error {
	return s.SaveChannelBundle(ctx, ch, nil, nil, nil)
}

// SaveChannelBundle commits a validated channel edit and all of its credential
// changes together. A missing credential or a failed encryption rolls it back.
func (s *Store) SaveChannelBundle(ctx context.Context, ch Channel, adds, updates []Credential, deletes []string) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(c, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.saveChannelTx(c, tx, ch); err != nil {
		return err
	}
	for _, cred := range adds {
		if cred.Secret == "" {
			return errors.New("credential secret is required")
		}
		if err = s.saveCredentialTx(c, tx, ch.ID, cred, true); err != nil {
			return err
		}
	}
	for _, cred := range updates {
		if err = s.saveCredentialTx(c, tx, ch.ID, cred, false); err != nil {
			return err
		}
	}
	for _, id := range deletes {
		r, e := tx.ExecContext(c, "DELETE FROM credentials WHERE id=$1 AND channel_id=$2", id, ch.ID)
		if e != nil {
			return e
		}
		n, _ := r.RowsAffected()
		if n == 0 {
			return ErrNotFound
		}
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}

func (s *Store) saveChannelTx(ctx context.Context, tx *DBTx, ch Channel) error {
	return s.portableSaveChannelTx(ctx, tx, ch)
}

func (s *Store) DeleteChannel(ctx context.Context, id string) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	r, err := s.db.ExecContext(c, "DELETE FROM channels WHERE id=$1", id)
	if err != nil {
		return err
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	s.InvalidateCache()
	return nil
}
func (s *Store) Credentials(ctx context.Context, channelID string, includeDisabled bool) ([]Credential, error) {
	v, err := s.cached(ctx, "credentials:"+channelID, func() (any, error) {
		c, cancel := storeContext(ctx)
		defer cancel()
		rows, err := s.db.QueryContext(c, "SELECT data,secret FROM credentials WHERE channel_id=$1 ORDER BY data->>'createdAt',id", channelID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []Credential{}
		for rows.Next() {
			var data []byte
			var secret string
			var cred Credential
			if err = rows.Scan(&data, &secret); err != nil {
				return nil, err
			}
			if err = json.Unmarshal(data, &cred); err != nil {
				return nil, err
			}
			if cred.Secret, err = s.Decrypt(secret); err != nil {
				return nil, err
			}
			out = append(out, cred)
		}
		return out, rows.Err()
	})
	if err != nil {
		return nil, err
	}
	original := v.([]Credential)
	out := make([]Credential, 0, len(original))
	for _, cred := range original {
		if !includeDisabled && !cred.Enabled {
			continue
		}
		secret := cred.Secret
		copy := cloneJSON(cred)
		copy.Secret = secret
		out = append(out, copy)
	}
	return out, nil
}
func (s *Store) SaveCredential(ctx context.Context, channelID string, cred Credential) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(c, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = s.saveCredentialTx(c, tx, channelID, cred, true); err != nil {
		return err
	}
	if err = tx.Commit(); err == nil {
		s.InvalidateCache()
	}
	return err
}

func (s *Store) saveCredentialTx(ctx context.Context, tx *DBTx, channelID string, cred Credential, allowInsert bool) error {
	return s.portableSaveCredentialTx(ctx, tx, channelID, cred, allowInsert)
}

func (s *Store) DeleteCredential(ctx context.Context, channelID, id string) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	r, err := s.db.ExecContext(c, "DELETE FROM credentials WHERE id=$1 AND channel_id=$2", id, channelID)
	if err != nil {
		return err
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	s.InvalidateCache()
	return nil
}

func scanKey(row interface{ Scan(...any) error }) (APIKey, error) {
	var key APIKey
	var data []byte
	err := row.Scan(&data, &key.TokenHash, &key.Used)
	if err != nil {
		return key, notFound(err)
	}
	used := key.Used
	hash := key.TokenHash
	err = json.Unmarshal(data, &key)
	key.Used = used
	key.TokenHash = hash
	return key, err
}
func (s *Store) Keys(ctx context.Context) ([]APIKey, error) {
	c, cancel := storeContext(ctx)
	defer cancel()
	rows, err := s.db.QueryContext(c, "SELECT data,token_hash,used FROM api_keys ORDER BY data->>'createdAt' DESC,id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIKey{}
	for rows.Next() {
		key, e := scanKey(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, key)
	}
	return out, rows.Err()
}
func (s *Store) Key(ctx context.Context, id string) (APIKey, error) {
	c, cancel := storeContext(ctx)
	defer cancel()
	return scanKey(s.db.QueryRowContext(c, "SELECT data,token_hash,used FROM api_keys WHERE id=$1", id))
}
func (s *Store) FindKey(ctx context.Context, rawToken string) (APIKey, error) {
	hash := HashToken(rawToken)
	v, err := s.cached(ctx, "key:"+hash, func() (any, error) {
		c, cancel := storeContext(ctx)
		defer cancel()
		return scanKey(s.db.QueryRowContext(c, "SELECT data,token_hash,used FROM api_keys WHERE token_hash=$1", hash))
	})
	if err != nil {
		return APIKey{}, err
	}
	key := v.(APIKey)
	copy := cloneJSON(key)
	copy.TokenHash = key.TokenHash
	return copy, nil
}
func (s *Store) SaveKey(ctx context.Context, key APIKey) error { return s.portableSaveKey(ctx, key) }

func (s *Store) DeleteKey(ctx context.Context, id string) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	r, err := s.db.ExecContext(c, "DELETE FROM api_keys WHERE id=$1", id)
	if err != nil {
		return err
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	s.InvalidateCache()
	return nil
}

func (s *Store) BulkKeys(ctx context.Context, ids []string, action string) error {
	return s.portableBulkKeys(ctx, ids, action)
}

func storedKeyExpired(key APIKey, now time.Time) bool {
	if key.Expires == "" || key.Expires == "never" || key.Expires == "永不过期" {
		return false
	}
	value := key.Expires
	if len(value) == 10 {
		value += "T23:59:59.999+08:00"
	}
	deadline, err := time.Parse(time.RFC3339Nano, value)
	return err != nil || !now.Before(deadline)
}
func (s *Store) ConsumeKey(ctx context.Context, keyID, profileID string, limit int64) (bool, error) {
	c, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(c, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	// Lock only this API key; one exhausted/dead channel cannot serialize other
	// keys. Re-read policy so cached authentication cannot bypass a recent edit.
	key, err := scanKey(tx.QueryRowContext(c, "SELECT data,token_hash,used FROM api_keys WHERE id=$1 FOR UPDATE", keyID))
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if key.Status != "active" || key.ActiveProfile != profileID || storedKeyExpired(key, time.Now()) {
		return false, nil
	}
	found := false
	for _, profile := range key.Profiles {
		if profile.ID == profileID {
			found = true
			limit, _ = strconv.ParseInt(profile.RequestLimit, 10, 64)
			if limit < 0 {
				limit = 0
			}
			break
		}
	}
	if !found {
		return false, nil
	}
	r, err := tx.ExecContext(c, "UPDATE profile_usage SET used=used+1 WHERE key_id=$1 AND profile_id=$2 AND ($3::bigint<=0 OR used<$3)", keyID, profileID, limit)
	if err != nil {
		return false, err
	}
	n, _ := r.RowsAffected()
	if n == 0 {
		return false, nil
	}
	if _, err = tx.ExecContext(c, "UPDATE api_keys SET used=used+1 WHERE id=$1", keyID); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) Record(ctx context.Context, log RequestLog, attempts []Attempt) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(c, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	log.Error = redactPointer(log.Error)
	data, err := jsonData(log)
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(c, "INSERT INTO request_logs(id,created_at,channel_id,result,model,source,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING", log.ID, log.CreatedAt, log.ChannelID, log.Result, log.Model, log.Source, data)
	if err != nil {
		return err
	}
	n, _ := result.RowsAffected()
	if n == 0 {
		return nil
	}
	type channelStats struct {
		count, success int64
		ttft           float64
		history        []int
	}
	stats := map[string]*channelStats{}
	for _, attempt := range attempts {
		attempt.Error = redactPointer(attempt.Error)
		data, err = jsonData(attempt)
		if err != nil {
			return err
		}
		r, insertErr := tx.ExecContext(c, "INSERT INTO attempts(id,request_id,channel_id,started_at,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", attempt.ID, attempt.RequestID, attempt.ChannelID, attempt.StartedAt, data)
		if insertErr != nil {
			return insertErr
		}
		inserted, _ := r.RowsAffected()
		if inserted == 0 {
			continue
		}
		st := stats[attempt.ChannelID]
		if st == nil {
			st = &channelStats{}
			stats[attempt.ChannelID] = st
		}
		st.count++
		if attempt.TTFT != nil {
			st.ttft = *attempt.TTFT
		}
		if attempt.Result == "success" || attempt.Result == "slow" {
			st.success++
		}
		if attempt.Result != "cancelled" {
			state := 2
			if attempt.Result == "success" {
				state = 0
			} else if attempt.Result == "slow" {
				state = 1
			}
			st.history = append(st.history, state)
		}
	}
	ids := make([]string, 0, len(stats))
	for id := range stats {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		st := stats[id]
		err = s.portableRecordStatsTx(c, tx, id, st.count, st.success, st.ttft, st.history)
		if err != nil {
			return err
		}
	}
	// Health state is updated by the engine's bounded asynchronous worker. Logs
	// never acquire locks for all channels or wait for any upstream network call.
	return tx.Commit()
}
func (s *Store) Logs(ctx context.Context, limit, offset int, q, result, channelID string) ([]RequestLog, int, error) {
	if limit < 1 {
		limit = 50
	}
	if limit > 1000 {
		limit = 1000
	}
	if offset < 0 {
		offset = 0
	}
	c, cancel := storeContext(ctx)
	defer cancel()
	// Omit inactive filters so SQLite and MySQL can use the result/channel
	// indexes instead of scanning every log through optional OR predicates.
	filters := []string{}
	args := []any{}
	if q != "" {
		args = append(args, "%"+strings.ToLower(q)+"%")
		filters = append(filters, "(LOWER(model) LIKE $1 OR LOWER(data->>'channel') LIKE $1 OR LOWER(id) LIKE $1)")
	}
	if result != "" {
		args = append(args, result)
		filters = append(filters, "result=$"+strconv.Itoa(len(args)))
	}
	if channelID != "" {
		args = append(args, channelID)
		filters = append(filters, "channel_id=$"+strconv.Itoa(len(args)))
	}
	where := ""
	if len(filters) > 0 {
		where = " WHERE " + strings.Join(filters, " AND ")
	}
	var count int
	if err := s.db.QueryRowContext(c, "SELECT count(*) FROM request_logs"+where, args...).Scan(&count); err != nil {
		return nil, 0, err
	}
	query := "SELECT data FROM request_logs" + where + " ORDER BY created_at DESC,id LIMIT $" + strconv.Itoa(len(args)+1) + " OFFSET $" + strconv.Itoa(len(args)+2)
	args = append(args, limit, offset)
	rows, err := s.db.QueryContext(c, query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []RequestLog{}
	for rows.Next() {
		var data []byte
		var log RequestLog
		if err = rows.Scan(&data); err != nil {
			return nil, 0, err
		}
		if err = json.Unmarshal(data, &log); err != nil {
			return nil, 0, err
		}
		out = append(out, log)
	}
	return out, count, rows.Err()
}
func (s *Store) Log(ctx context.Context, id string) (RequestLog, []Attempt, error) {
	c, cancel := storeContext(ctx)
	defer cancel()
	var log RequestLog
	var data []byte
	if err := s.db.QueryRowContext(c, "SELECT data FROM request_logs WHERE id=$1", id).Scan(&data); err != nil {
		return log, nil, notFound(err)
	}
	if err := json.Unmarshal(data, &log); err != nil {
		return log, nil, err
	}
	rows, err := s.db.QueryContext(c, "SELECT data FROM attempts WHERE request_id=$1 ORDER BY started_at,id", id)
	if err != nil {
		return log, nil, err
	}
	defer rows.Close()
	attempts := []Attempt{}
	for rows.Next() {
		var attempt Attempt
		if err = rows.Scan(&data); err != nil {
			return log, nil, err
		}
		if err = json.Unmarshal(data, &attempt); err != nil {
			return log, nil, err
		}
		attempts = append(attempts, attempt)
	}
	return log, attempts, rows.Err()
}
func (s *Store) ClearLogs(ctx context.Context) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	_, err := s.db.ExecContext(c, "DELETE FROM request_logs")
	return err
}
func (s *Store) Events(ctx context.Context, limits ...int) ([]Event, error) {
	limit := 30
	if len(limits) > 0 {
		limit = limits[0]
	}
	if limit < 1 {
		limit = 30
	}
	if limit > 1000 {
		limit = 1000
	}
	c, cancel := storeContext(ctx)
	defer cancel()
	rows, err := s.db.QueryContext(c, "SELECT data FROM events ORDER BY created_at DESC LIMIT $1", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var data []byte
		var event Event
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &event); err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	return out, rows.Err()
}
func (s *Store) AddEvent(ctx context.Context, event Event) error {
	event.Description = redactText(event.Description)
	data, err := jsonData(event)
	if err != nil {
		return err
	}
	c, cancel := storeContext(ctx)
	defer cancel()
	_, err = s.db.ExecContext(c, "INSERT INTO events(id,created_at,data) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING", event.ID, event.CreatedAt, data)
	return err
}
func (s *Store) Tags(ctx context.Context) ([]string, error) {
	c, cancel := storeContext(ctx)
	defer cancel()
	rows, err := s.db.QueryContext(c, "SELECT name FROM tags ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var tag string
		if err = rows.Scan(&tag); err != nil {
			return nil, err
		}
		out = append(out, tag)
	}
	return out, rows.Err()
}
func (s *Store) AddTag(ctx context.Context, name string) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	_, err := s.db.ExecContext(c, "INSERT INTO tags(name) VALUES($1) ON CONFLICT DO NOTHING", name)
	return err
}
func (s *Store) DeleteTag(ctx context.Context, name string) error {
	return s.portableTag(ctx, name, "", true)
}

func (s *Store) RenameTag(ctx context.Context, oldName, newName string) error {
	return s.portableTag(ctx, oldName, newName, false)
}

func (s *Store) UpdateHealth(ctx context.Context, id string, health Health, status string) error {
	return s.portableUpdateHealth(ctx, id, health, status, "", false)
}

func (s *Store) UpdateHealthAfter(ctx context.Context, id string, health Health, status, startedAt string) error {
	return s.portableUpdateHealth(ctx, id, health, status, startedAt, false)
}

func (s *Store) ResetChannelHealth(ctx context.Context, id string) error {
	return s.portableUpdateHealth(ctx, id, Health{}, "healthy", "", true)
}

func (s *Store) ResetHealth(ctx context.Context, id string) error {
	return s.ResetChannelHealth(ctx, id)
}
func (s *Store) BulkChannels(ctx context.Context, changes []Channel) error {
	return s.portableBulkChannels(ctx, changes)
}

func (s *Store) GetSticky(ctx context.Context, scope string) (string, error) {
	c, cancel := storeContext(ctx)
	defer cancel()
	var value string
	err := s.db.QueryRowContext(c, "SELECT value FROM gateway_state WHERE id=$1 AND expires_at>now()", "sticky:"+scope).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return value, err
}
func (s *Store) SetSticky(ctx context.Context, scope, channelID string) error {
	c, cancel := storeContext(ctx)
	defer cancel()
	_, err := s.db.ExecContext(c, "INSERT INTO gateway_state(id,value,expires_at) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at", "sticky:"+scope, channelID, time.Now().Add(24*time.Hour))
	return err
}
func (s *Store) ReserveChannel(ctx context.Context, ch Channel, tokens int64) (bool, error) {
	return s.portableReserveChannel(ctx, ch, tokens)
}

func (s *Store) Cleanup(ctx context.Context, days int) error {
	if days < 1 {
		days = 30
	}
	c, cancel := storeContext(ctx)
	defer cancel()
	tx, err := s.db.BeginTx(c, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	before := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	for _, table := range []string{"request_logs", "events"} {
		if _, err = tx.ExecContext(c, "DELETE FROM "+table+" WHERE created_at<$1", before); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(c, "DELETE FROM gateway_state WHERE expires_at<now()"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(c, "DELETE FROM channel_rate_limits WHERE minute<$1", time.Now().Unix()/60-2); err != nil {
		return err
	}
	return tx.Commit()
}

var redactPatterns = []struct {
	re          *regexp.Regexp
	replacement string
}{
	{regexp.MustCompile(`(?i)Bearer\s+[^\s"'<>]+`), "Bearer [REDACTED]"},
	{regexp.MustCompile(`(?:sk-|pg_live_|AIza)[a-zA-Z0-9_-]{12,}`), "[REDACTED]"},
	{regexp.MustCompile(`(?i)([?&](?:key|api_key|token|access_token)=)[^&\s]+`), "${1}[REDACTED]"},
	{regexp.MustCompile(`(?i)("?(?:api[_-]?key|authorization|secret|token|password)"?\s*[:=]\s*")[^"]+`), "${1}[REDACTED]"},
}

func redactText(value string) string {
	if len(value) > 16000 {
		value = value[:16000]
	}
	for _, pattern := range redactPatterns {
		value = pattern.re.ReplaceAllString(value, pattern.replacement)
	}
	return value
}
func redactPointer(value *string) *string {
	if value == nil {
		return nil
	}
	clean := redactText(*value)
	return &clean
}
