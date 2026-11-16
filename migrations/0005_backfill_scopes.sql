CREATE TABLE IF NOT EXISTS d1_backfill_scopes (
  feature TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (feature, scope_key)
);
