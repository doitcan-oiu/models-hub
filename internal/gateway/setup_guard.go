package gateway

import (
	"context"
	"errors"
)

var errSetupDatabasePopulated = errors.New("database already contains PulseGate data")

// First-admin setup creates a new encryption key. Attaching that key to an
// existing installation would make its stored credentials unreadable and grant
// a newly chosen password access to the previous installation's business data.
// Only migration metadata may exist before this first initialization.
func checkSetupDatabaseEmpty(ctx context.Context, store *Store) error {
	var populated bool
	err := store.DB().QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM channels UNION ALL SELECT 1 FROM credentials
		UNION ALL SELECT 1 FROM settings UNION ALL SELECT 1 FROM api_keys
		UNION ALL SELECT 1 FROM profile_usage UNION ALL SELECT 1 FROM tags
		UNION ALL SELECT 1 FROM request_logs UNION ALL SELECT 1 FROM attempts
		UNION ALL SELECT 1 FROM events UNION ALL SELECT 1 FROM gateway_accounts
		UNION ALL SELECT 1 FROM gateway_state UNION ALL SELECT 1 FROM channel_rate_limits
		UNION ALL SELECT 1 FROM credential_balance_jobs
	)`).Scan(&populated)
	if err != nil {
		return err
	}
	if populated {
		return errSetupDatabasePopulated
	}
	return nil
}
