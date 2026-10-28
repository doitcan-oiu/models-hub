package gateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Different credentials of one channel finish their network work together.
// Persisting them must not upgrade their shared parent locks and deadlock.
func TestConcurrentCredentialBalanceCompletions(t *testing.T) {
	for _, backend := range []struct {
		name string
		open func(*testing.T) *Store
	}{{"sqlite", testSQLiteStore}, {"postgres", testPostgresStore}, {"mysql", testMySQLStore}} {
		t.Run(backend.name, func(t *testing.T) {
			s := backend.open(t)
			const count = 8
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			var arrived atomic.Int32
			release := make(chan struct{})
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if arrived.Add(1) == count {
					close(release)
				}
				select {
				case <-release:
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(`{"code":true,"data":{"total_available":250000,"expires_at":-1}}`))
				case <-ctx.Done():
					w.WriteHeader(http.StatusGatewayTimeout)
				}
			}))
			defer upstream.Close()
			channel := testStoredChannel("balance-concurrency")
			channel.Endpoint = upstream.URL
			channel.Config.Integration = "bbdevlab"
			credentials := make([]Credential, count)
			for index := range credentials {
				credentials[index] = Credential{ID: fmt.Sprintf("balance-key-%d", index), Secret: fmt.Sprintf("secret-%d", index), Enabled: true}
			}
			if err := s.SaveChannelBundle(ctx, channel, credentials, nil, nil); err != nil {
				t.Fatal(err)
			}
			integration := NewIntegrations(s)
			integration.client.Transport.(*http.Transport).MaxConnsPerHost = count
			defer integration.client.CloseIdleConnections()
			results := make(chan error, count)
			for _, credential := range credentials {
				go func(id string) { results <- integration.refreshCredential(ctx, channel.ID, id, true) }(credential.ID)
			}
			for range credentials {
				if err := <-results; err != nil {
					t.Errorf("concurrent balance completion: %v", err)
				}
			}
			persisted, err := s.Credentials(ctx, channel.ID, false)
			if err != nil || len(persisted) != count {
				t.Fatalf("credentials: %d %v", len(persisted), err)
			}
			for _, credential := range persisted {
				if credential.Balance == nil || credential.Balance.Status != "ok" || credential.Balance.Amount == nil || *credential.Balance.Amount != 2.5 {
					t.Errorf("balance not persisted for %s: %+v", credential.ID, credential.Balance)
				}
			}
			var activeLeases int
			if err = s.db.QueryRowContext(ctx, "SELECT count(*) FROM credential_balance_jobs WHERE lease_until<>0").Scan(&activeLeases); err != nil || activeLeases != 0 {
				t.Fatalf("completion left active leases: %d %v", activeLeases, err)
			}
		})
	}
}
