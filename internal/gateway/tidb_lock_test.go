package gateway

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Exercise the database/sql transaction adapter without requiring a running
// TiDB instance. This driver accepts only the account balance workflow's SQL
// and rejects the shared-lock clauses that TiDB does not implement.
type tidbBalanceConnector struct {
	channel, account []byte
	secret           string
	active           bool
	begins, commits  int
	rollbacks        int
	channelLocks     int
	writes           []accountMetadata
}

func (c *tidbBalanceConnector) Connect(context.Context) (driver.Conn, error) {
	return &tidbBalanceConn{c}, nil
}
func (c *tidbBalanceConnector) Driver() driver.Driver { return tidbBalanceDriver{} }

type tidbBalanceDriver struct{}

func (tidbBalanceDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use the TiDB balance connector")
}

type tidbBalanceConn struct{ *tidbBalanceConnector }

func (*tidbBalanceConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepared statement")
}
func (*tidbBalanceConn) Close() error { return nil }
func (c *tidbBalanceConn) Begin() (driver.Tx, error) {
	if c.active {
		return nil, errors.New("transaction already active")
	}
	c.active = true
	c.begins++
	return c, nil
}
func (c *tidbBalanceConn) Commit() error {
	c.active = false
	c.commits++
	return nil
}
func (c *tidbBalanceConn) Rollback() error {
	c.active = false
	c.rollbacks++
	return nil
}
func (c *tidbBalanceConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if !c.active {
		return nil, errors.New("balance read escaped its transaction")
	}
	upper := strings.ToUpper(query)
	if strings.Contains(upper, "LOCK IN SHARE MODE") || strings.Contains(upper, "FOR SHARE") {
		return nil, fmt.Errorf("TiDB unsupported shared lock: %s", query)
	}
	if len(args) != 1 || args[0].Value != "channel" {
		return nil, fmt.Errorf("unexpected query bindings: %#v", args)
	}
	switch query {
	case "SELECT data FROM channels WHERE id=? FOR UPDATE":
		c.channelLocks++
		rows := &tidbBalanceRows{columns: []string{"data"}}
		if c.channel != nil {
			rows.values = []driver.Value{c.channel}
		}
		return rows, nil
	case "SELECT data,secret FROM gateway_accounts WHERE channel_id=? FOR UPDATE":
		return &tidbBalanceRows{columns: []string{"data", "secret"}, values: []driver.Value{c.account, c.secret}}, nil
	default:
		return nil, fmt.Errorf("unexpected balance query: %s", query)
	}
}
func (c *tidbBalanceConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if !c.active {
		return nil, errors.New("balance write escaped its transaction")
	}
	if !strings.HasPrefix(query, "UPDATE gateway_accounts SET data=? WHERE channel_id=?") || len(args) < 2 || args[1].Value != "channel" {
		return nil, fmt.Errorf("unexpected balance update: %s, %#v", query, args)
	}
	if len(c.writes) == 0 {
		if query != "UPDATE gateway_accounts SET data=? WHERE channel_id=?" || len(args) != 2 {
			return nil, errors.New("unexpected lease claim update")
		}
	} else {
		// Completion must retain the credential and lease guards after binding.
		if len(args) != 5 || args[2].Value != c.secret || args[3].Value != c.writes[0].LeaseUntil || args[4].Value != "newapi" || !strings.Contains(query, "AND secret=?") || !strings.Contains(query, "$.leaseUntil") || !strings.Contains(query, "$.integration") {
			return nil, fmt.Errorf("missing completion guards: %s, %#v", query, args)
		}
	}
	raw, ok := args[0].Value.(string)
	if !ok {
		return nil, fmt.Errorf("unexpected JSON binding: %T", args[0].Value)
	}
	var metadata accountMetadata
	if err := json.Unmarshal([]byte(raw), &metadata); err != nil {
		return nil, err
	}
	c.writes = append(c.writes, metadata)
	return driver.RowsAffected(1), nil
}

type tidbBalanceRows struct {
	columns []string
	values  []driver.Value
}

func (r *tidbBalanceRows) Columns() []string { return r.columns }
func (*tidbBalanceRows) Close() error        { return nil }
func (r *tidbBalanceRows) Next(values []driver.Value) error {
	if r.values == nil {
		return io.EOF
	}
	copy(values, r.values)
	r.values = nil
	return nil
}

func tidbBalanceStore(t *testing.T, connector *tidbBalanceConnector) *Store {
	t.Helper()
	block, err := aes.NewCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	db := sql.OpenDB(connector)
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	return &Store{db: &DB{DB: db, dialect: "mysql"}, aead: aead}
}

func TestTiDBAccountBalanceRefreshUsesSupportedLocks(t *testing.T) {
	for _, upstreamFailure := range []bool{false, true} {
		t.Run(fmt.Sprintf("upstreamFailure=%t", upstreamFailure), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/user/self":
					if r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("New-Api-User") != "1" {
						t.Error("account credentials were not restored")
					}
					if upstreamFailure {
						w.WriteHeader(http.StatusBadGateway)
						return
					}
					integrationTestJSON(w, map[string]any{"success": true, "data": map[string]any{"quota": 1000000}})
				case "/api/status":
					integrationTestJSON(w, map[string]any{"data": map[string]any{"quota_per_unit": 500000}})
				default:
					t.Errorf("unexpected upstream path: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			channel := Channel{ID: "channel", Endpoint: server.URL, Config: DefaultChannelConfig()}
			channel.Config.Integration = "newapi"
			channelData, err := json.Marshal(channel)
			if err != nil {
				t.Fatal(err)
			}
			connector := &tidbBalanceConnector{channel: channelData, account: []byte(`{"integration":"newapi","authMode":"token"}`)}
			store := tidbBalanceStore(t, connector)
			connector.secret, err = store.Encrypt(`{"mode":"token","accessToken":"test-token","userId":"1"}`)
			if err != nil {
				t.Fatal(err)
			}
			integrations := NewIntegrations(store)
			defer integrations.client.CloseIdleConnections()
			if err = integrations.refreshAccount(context.Background(), "channel", true); err != nil {
				t.Fatal(err)
			}
			if connector.begins != 2 || connector.commits != 2 || connector.rollbacks != 0 || connector.active || connector.channelLocks != 2 || len(connector.writes) != 2 {
				t.Fatalf("unexpected transaction lifecycle: %#v", connector)
			}
			claimed, finished := connector.writes[0], connector.writes[1]
			if claimed.LeaseUntil <= time.Now().UnixMilli() || finished.LeaseUntil != 0 || finished.NextRefreshAt <= time.Now().UnixMilli() || finished.Balance == nil {
				t.Fatalf("lease was not claimed and released: claimed=%#v, finished=%#v", claimed, finished)
			}
			if upstreamFailure {
				if finished.Balance.Status != "error" {
					t.Fatalf("upstream failure was not recorded: %#v", finished.Balance)
				}
			} else if finished.Balance.Status != "ok" || finished.Balance.Amount == nil || *finished.Balance.Amount != 2 || finished.Balance.Unit != "USD" {
				t.Fatalf("incorrect refreshed balance: %#v", finished.Balance)
			}
		})
	}
}

func TestTiDBAccountClaimMissingChannelRollsBack(t *testing.T) {
	connector := &tidbBalanceConnector{}
	store := tidbBalanceStore(t, connector)
	claim, err := store.claimIntegrationAccount(context.Background(), "channel", true)
	if err != nil || claim != nil {
		t.Fatalf("missing channel: claim=%#v, err=%v", claim, err)
	}
	if connector.begins != 1 || connector.commits != 0 || connector.rollbacks != 1 || connector.active || connector.channelLocks != 1 || len(connector.writes) != 0 {
		t.Fatalf("missing channel did not roll back safely: %#v", connector)
	}
}
