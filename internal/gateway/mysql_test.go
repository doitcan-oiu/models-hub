package gateway

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// TEST_MYSQL_URL points to a MySQL 8+ server whose user may create databases.
// Every run creates and drops its own uniquely named disposable database.
func testMySQLStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("TEST_MYSQL_URL")
	if dsn == "" {
		t.Skip("TEST_MYSQL_URL is not set")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := openDatabase(dsn)
	if err != nil {
		t.Fatal(err)
	}
	database := fmt.Sprintf("pulsegate_test_%d", time.Now().UnixNano())
	if _, err = admin.ExecContext(context.Background(), "CREATE DATABASE "+database+" CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.ExecContext(context.Background(), "DROP DATABASE "+database); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	u.Path = "/" + database
	s, err := NewStore(context.Background(), u.String(), base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestMySQLPortableDomain(t *testing.T) {
	runPortableDomainTests(t, testMySQLStore(t))
}

func TestMySQLJSONPredicatesAndInsertErrors(t *testing.T) {
	s := testMySQLStore(t)
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO channels(id,data) VALUES($1,$2)`, "json", `{"enabled":true,"archived":false,"config":{"integration":"newapi"},"balance":null}`); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM channels WHERE COALESCE((data->>'enabled')::boolean,true) AND COALESCE((data->>'archived')::boolean,false)=false AND data->'config'->>'integration'='newapi' AND data->>'balance' IS NULL`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("JSON predicate: %d %v", count, err)
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO credentials(id,channel_id,data,secret) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, "orphan", "missing", `{}`, "secret"); err == nil {
		t.Fatal("INSERT IGNORE suppressed foreign-key error")
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO tags(name) VALUES($1) ON CONFLICT DO NOTHING`, strings.Repeat("x", 300)); err == nil {
		t.Fatal("INSERT IGNORE suppressed truncation error")
	}
	if err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM tags").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed INSERT IGNORE committed: %d %v", count, err)
	}
}
