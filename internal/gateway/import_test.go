package gateway

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func d1TestRow(values map[string]any) map[string]json.RawMessage {
	row := map[string]json.RawMessage{}
	for key, value := range values {
		row[key] = d1JSON(value)
	}
	return row
}
func d1TestSnapshot(t *testing.T, s *Store) D1Snapshot {
	t.Helper()
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	newapi := testStoredChannel("newapi")
	newapi.Config.Integration = "newapi"
	newapi.Config.GatewayMode = "ai-gateway"
	newapi.Tags = []string{"kept-tag"}
	bb := testStoredChannel("bb")
	bb.Config.Integration = "bbdevlab"
	secret, err := s.Encrypt("sk-original-inference-secret")
	if err != nil {
		t.Fatal(err)
	}
	account, err := s.Encrypt(`{"username":"original-user","password":"original-password"}`)
	if err != nil {
		t.Fatal(err)
	}
	key := testStoredKey("key", "pg_live_original", "10")
	key.Used = 3
	balance := GatewayBalance{Status: "ok", Unit: "余额", Amount: integrationAmountPointer(0.00001), ExpiresAt: integrationStringPointer(time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano)), UpdatedAt: &stamp, CheckedAt: &stamp}
	event := Event{ID: "event", CreatedAt: stamp, Title: "Kept", Type: "info"}
	attempt := Attempt{ID: "attempt", RequestID: "unfinished", ChannelID: "bb", ChannelName: "BB", Model: "test-model", StartedAt: stamp, Status: 502, Result: "error"}
	settings := DefaultSettings()
	settings.Threshold = 0.5
	settings.AIGatewayEnabled = true
	settings.HasAIGatewayToken = true
	return D1Snapshot{Version: 1, Tables: map[string][]map[string]json.RawMessage{
		"channels":            {d1TestRow(map[string]any{"id": newapi.ID, "data": string(d1JSON(newapi))}), d1TestRow(map[string]any{"id": bb.ID, "data": string(d1JSON(bb))})},
		"credentials":         {d1TestRow(map[string]any{"id": "credential", "channel_id": "bb", "secret": secret, "label": "Kept key", "preview": "••••cret", "enabled": 1, "failure_count": 2, "recovery_count": 1, "created_at": stamp, "disabled_at": nil, "reason": nil})},
		"credential_balances": {d1TestRow(map[string]any{"credential_id": "credential", "balance": string(d1JSON(balance))})},
		"api_keys":            {d1TestRow(map[string]any{"id": key.ID, "token_hash": HashToken("pg_live_original"), "data": string(d1JSON(key)), "used": 3})},
		"profile_usage":       {d1TestRow(map[string]any{"key_id": key.ID, "profile_id": key.ActiveProfile, "used": 2})},
		"settings":            {d1TestRow(map[string]any{"id": "gateway", "value": string(d1JSON(settings))}), d1TestRow(map[string]any{"id": "ai_gateway_token", "value": "intentionally-discarded-cloudflare-token"})},
		"tags":                {d1TestRow(map[string]any{"name": "kept-tag"})},
		"channel_accounts":    {d1TestRow(map[string]any{"channel_id": "newapi", "credentials": account, "auth_secret": "intentionally-discarded-session", "balance": string(d1JSON(GatewayBalance{Status: "ok", Unit: "USD", Amount: integrationAmountPointer(12.5)}))})},
		"attempts":            {d1TestRow(map[string]any{"id": attempt.ID, "request_id": attempt.RequestID, "channel_id": attempt.ChannelID, "started_at": stamp, "data": string(d1JSON(attempt))})},
		"events":              {d1TestRow(map[string]any{"id": event.ID, "created_at": stamp, "data": string(d1JSON(event))})},
	}}
}

func TestD1SnapshotReaderAndEncryptedMigrationPreparation(t *testing.T) {
	s := testMemoryStore(t)
	snapshot := d1TestSnapshot(t, s)
	decoded, err := ReadD1Snapshot(strings.NewReader(string(d1JSON(snapshot))))
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := s.prepareD1Import(decoded)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.result.Channels != 2 || prepared.result.Credentials != 1 || prepared.result.Accounts != 1 || prepared.result.APIKeys != 1 || prepared.result.SyntheticLogs != 1 || prepared.result.DirectChannels != 1 {
		t.Fatalf("incomplete migration result: %#v", prepared.result)
	}
	for _, insert := range prepared.inserts {
		switch insert.table {
		case "channels":
			var channel Channel
			_ = json.Unmarshal(insert.args[1].([]byte), &channel)
			if channel.Config.GatewayMode != "direct" {
				t.Fatal("Cloudflare channel remained dependent on AI Gateway")
			}
		case "gateway_accounts":
			var metadata accountMetadata
			_ = json.Unmarshal(insert.args[1].([]byte), &metadata)
			if metadata.AuthMode != "password" || metadata.Integration != "newapi" || metadata.NextRefreshAt != 0 || metadata.Session != "" || metadata.Balance == nil || metadata.Balance.Amount == nil || *metadata.Balance.Amount != 12.5 {
				t.Fatalf("account metadata lost: %#v", metadata)
			}
			plain, err := s.Decrypt(insert.args[2].(string))
			if err != nil {
				t.Fatal(err)
			}
			var account accountCredentials
			_ = json.Unmarshal([]byte(plain), &account)
			if account.Mode != "password" || account.Username != "original-user" || account.Password != "original-password" {
				t.Fatal("account credentials did not survive migration")
			}
		case "credentials":
			if !strings.HasPrefix(insert.args[3].(string), "v1:") {
				t.Fatal("credential ciphertext not preserved")
			}
			var credential Credential
			_ = json.Unmarshal(insert.args[2].([]byte), &credential)
			if credential.Balance == nil || credential.Balance.Amount == nil || *credential.Balance.Amount != 0.00001 || credential.Balance.ExpiresAt == nil {
				t.Fatal("per-key quota or expiration lost")
			}
		}
	}
	for _, invalid := range []string{"null", `{"version":2,"tables":{}}`, `{"version":1,"tables":{}} {}`, `{"version":1}`} {
		if _, err := ReadD1Snapshot(strings.NewReader(invalid)); err == nil {
			t.Fatalf("invalid snapshot accepted: %s", invalid)
		}
	}
	snapshot.Tables["credentials"][0]["secret"] = d1JSON("v1:invalid:invalid")
	if _, err = s.prepareD1Import(snapshot); err == nil || !strings.Contains(err.Error(), "ENCRYPTION_KEY") {
		t.Fatalf("wrong encryption key was not rejected: %v", err)
	}
}

func TestD1ImportPreservesCredentialsCountersAndHistory(t *testing.T) {
	s := testPostgresStore(t)
	snapshot := d1TestSnapshot(t, s)
	result, err := s.ImportD1(context.Background(), snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if result.SyntheticLogs != 1 || result.Attempts != 1 || result.Events != 1 {
		t.Fatalf("history missing: %#v", result)
	}
	channel, err := s.Channel(context.Background(), "newapi")
	if err != nil || !channel.HasAccountCredentials || channel.AccountAuthMode != "password" || channel.Config.GatewayMode != "direct" {
		t.Fatalf("imported account channel: %#v %v", channel, err)
	}
	credentials, err := s.Credentials(context.Background(), "bb", true)
	if err != nil || len(credentials) != 1 || credentials[0].Secret != "sk-original-inference-secret" || credentials[0].Balance == nil || *credentials[0].Balance.Amount != 0.00001 {
		t.Fatalf("imported upstream key: %#v %v", credentials, err)
	}
	key, err := s.FindKey(context.Background(), "pg_live_original")
	if err != nil || key.Used != 3 {
		t.Fatalf("API token hash/usage changed: %#v %v", key, err)
	}
	var used int
	if err = s.db.QueryRow(`SELECT used FROM profile_usage WHERE key_id='key'`).Scan(&used); err != nil || used != 2 {
		t.Fatalf("profile quota changed: %d %v", used, err)
	}
	settings, err := s.Settings(context.Background())
	if err != nil || settings.Threshold != 0.5 || settings.AIGatewayEnabled || settings.HasAIGatewayToken {
		t.Fatalf("settings changed unexpectedly: %#v %v", settings, err)
	}
	if _, err = s.ImportD1(context.Background(), snapshot); err == nil {
		t.Fatal("import overwrote a populated target")
	}
}

func TestD1ImportRollsBackEveryRowAfterLateFailure(t *testing.T) {
	s := testPostgresStore(t)
	snapshot := d1TestSnapshot(t, s)
	snapshot.Tables["events"] = append(snapshot.Tables["events"], snapshot.Tables["events"][0])
	if _, err := s.ImportD1(context.Background(), snapshot); err == nil {
		t.Fatal("duplicate event should fail entire import")
	}
	for _, table := range []string{"channels", "credentials", "api_keys", "profile_usage", "settings", "request_logs", "attempts", "gateway_accounts"} {
		var count int
		if err := s.db.QueryRow(`SELECT count(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial import remained in %s: %d %v", table, count, err)
		}
	}
	snapshot.Tables["events"] = snapshot.Tables["events"][:1]
	if _, err := s.ImportD1(context.Background(), snapshot); err != nil {
		t.Fatalf("clean retry after rollback failed: %v", err)
	}
}
