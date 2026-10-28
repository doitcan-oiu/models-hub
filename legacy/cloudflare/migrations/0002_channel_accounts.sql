CREATE TABLE IF NOT EXISTS channel_accounts (
  channel_id TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  credentials TEXT NOT NULL,
  auth_secret TEXT,
  balance TEXT,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1
);
