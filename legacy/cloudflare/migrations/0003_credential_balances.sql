CREATE TABLE IF NOT EXISTS credential_balances (
  credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  balance TEXT,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS credential_balances_due ON credential_balances(next_refresh_at, lease_until);
