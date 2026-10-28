package gateway

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupRefusesPopulatedDatabaseWithoutReplacingEncryptionKey(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "existing.db")
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	store, err := NewStore(ctx, "sqlite:"+path, key)
	if err != nil {
		t.Fatal(err)
	}
	channel := testStoredChannel("existing-channel")
	if err = store.SaveChannelBundle(ctx, channel, []Credential{{ID: "existing-credential", Secret: "original-private-secret", Enabled: true}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	var ciphertext string
	if err = store.DB().QueryRowContext(ctx, "SELECT secret FROM credentials WHERE id=$1", "existing-credential").Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	cfg := applicationTestConfig(t)
	application := newTestApplication(t, cfg)
	input := setupInput()
	input.Database = DatabaseConfiguration{Type: "sqlite", Path: path}
	response := setupHTTP(application, "POST", "/api/setup", input)
	if response.Code != 400 || !strings.Contains(response.Body.String(), "已有 PulseGate 数据") {
		t.Fatalf("populated setup: %d %s", response.Code, response.Body.String())
	}
	if _, err = os.Stat(filepath.Join(cfg.DataDir, "config.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("new configuration persisted: %v", err)
	}
	store, err = NewStore(ctx, "sqlite:"+path, key)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	credentials, err := store.Credentials(ctx, channel.ID, false)
	if err != nil || len(credentials) != 1 || credentials[0].Secret != "original-private-secret" {
		t.Fatalf("original credentials changed: %+v %v", credentials, err)
	}
	var after string
	if err = store.DB().QueryRowContext(ctx, "SELECT secret FROM credentials WHERE id=$1", "existing-credential").Scan(&after); err != nil || after != ciphertext {
		t.Fatalf("stored ciphertext changed: %v", err)
	}
}

func TestSetupAcceptsSchemaOnlyDatabaseAfterEarlierIncompleteSetup(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "schema-only.db")
	store, err := NewStore(ctx, "sqlite:"+path, base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	application := newTestApplication(t, applicationTestConfig(t))
	input := setupInput()
	input.Database = DatabaseConfiguration{Type: "sqlite", Path: path}
	response := setupHTTP(application, "POST", "/api/setup", input)
	if response.Code != 200 {
		t.Fatalf("schema-only setup: %d %s", response.Code, response.Body.String())
	}
}
