package gateway

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func testSQLiteStore(t *testing.T) *Store {
	t.Helper()
	s, err := NewStore(context.Background(), "sqlite:"+filepath.Join(t.TempDir(), "data", "pulsegate.db"), base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := s.Close(); err != nil {
			t.Error(err)
		}
	})
	return s
}

func TestDialectBindingAndJSON(t *testing.T) {
	for _, dialect := range []string{"sqlite", "mysql"} {
		t.Run(dialect, func(t *testing.T) {
			query, args := dialectSQL(dialect, `SELECT '$2',data->'config'->>'integration' FROM channels WHERE id=$2 AND name=$1 AND id<>$2`, []any{"first", "second"})
			if strings.Contains(query, "->") || strings.Count(query, "?") != 3 || !strings.Contains(query, "'$2'") {
				t.Fatal(query)
			}
			if !reflect.DeepEqual(args, []any{"second", "first", "second"}) {
				t.Fatalf("args: %#v", args)
			}
		})
	}
}

func TestDialectTimestampsPreserveApplicationValues(t *testing.T) {
	stamp := "2026-10-28T04:05:06.123456Z"
	for _, dialect := range []string{"sqlite", "mysql"} {
		_, args := dialectSQL(dialect, `INSERT INTO gateway_state(id,value) VALUES($1,$2)`, []any{"health-reset:channel", stamp})
		if args[1] != stamp {
			t.Fatalf("%s changed application value: %v", dialect, args[1])
		}
		_, args = dialectSQL(dialect, `INSERT INTO request_logs(id,created_at,data) VALUES($1,$2,$3)`, []any{"request", stamp, `{}`})
		if args[1] != "2026-10-28 04:05:06.123456" {
			t.Fatalf("%s did not normalize physical timestamp: %v", dialect, args[1])
		}
	}
}

func TestSQLiteMigrationsPersistenceAndConstraints(t *testing.T) {
	s := testSQLiteStore(t)
	ctx := context.Background()
	if s.DB().Dialect() != "sqlite" {
		t.Fatal("wrong dialect")
	}
	if err := s.migrate(ctx); err != nil {
		t.Fatalf("repeat migrations: %v", err)
	}
	for _, table := range []string{"channels", "credentials", "settings", "api_keys", "profile_usage", "request_logs", "attempts", "events", "tags", "gateway_state", "gateway_accounts", "credential_balance_jobs", "channel_rate_limits"} {
		var count int
		if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil {
			t.Fatalf("%s: %v", table, err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO credentials(id,channel_id,data,secret) VALUES($1,$2,$3,$4)`, "orphan", "missing", []byte(`{}`), "secret"); err == nil {
		t.Fatal("foreign keys must be enabled on every pooled connection")
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO channels(id,data) VALUES($1,$2)`, "invalid", "not-json"); err == nil {
		t.Fatal("invalid JSON accepted")
	}
	if err := s.SaveSettings(ctx, DefaultSettings()); err != nil {
		t.Fatal(err)
	}
	settings, err := s.Settings(ctx)
	if err != nil || settings.Strategy != DefaultSettings().Strategy {
		t.Fatalf("settings: %#v %v", settings, err)
	}
}

func TestSQLiteJSONPredicatesAndSessionTimes(t *testing.T) {
	s := testSQLiteStore(t)
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO channels(id,data) VALUES($1,$2)`, "json", `{"enabled":true,"archived":false,"config":{"integration":"newapi"},"balance":null}`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM channels WHERE COALESCE((data->>'enabled')::boolean,true) AND COALESCE((data->>'archived')::boolean,false)=false AND data->'config'->>'integration'='newapi' AND data->>'balance' IS NULL`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("JSON predicate: %d %v", count, err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO gateway_state(id,value,expires_at) VALUES($1,$2,$3)`, "session:valid", "ok", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM gateway_state WHERE expires_at>now()`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("session timestamp: %d %v", count, err)
	}
	if err := s.SetSticky(ctx, "scope", "json"); err != nil {
		t.Fatal(err)
	}
	if value, err := s.GetSticky(ctx, "scope"); err != nil || value != "json" {
		t.Fatalf("sticky: %q %v", value, err)
	}
}
