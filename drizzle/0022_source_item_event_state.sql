CREATE TABLE IF NOT EXISTS source_item_event_states (
  id TEXT PRIMARY KEY,
  source_config_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  platform_item_id TEXT NOT NULL,
  latest_kind TEXT NOT NULL CHECK (latest_kind IN ('upsert', 'tombstone')),
  latest_event_at TEXT NOT NULL,
  latest_ingestion_run_id TEXT NOT NULL,
  identity_strategy TEXT NOT NULL CHECK (identity_strategy IN ('platform_id', 'guid', 'canonical_url', 'content_fingerprint')),
  identity_confidence TEXT NOT NULL CHECK (identity_confidence IN ('high', 'medium', 'low')),
  provenance_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_config_id, namespace, platform_item_id)
);

CREATE INDEX IF NOT EXISTS idx_source_item_event_states_latest
  ON source_item_event_states (source_config_id, latest_kind, latest_event_at);
