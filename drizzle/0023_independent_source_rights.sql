ALTER TABLE source_configs
  ADD COLUMN IF NOT EXISTS rights_config_hash TEXT NOT NULL DEFAULT '';

UPDATE source_configs
SET rights_config_hash = config_hash
WHERE rights_config_hash = '';

ALTER TABLE source_rights_grants
  ADD COLUMN IF NOT EXISTS evidence_sha256 TEXT NOT NULL DEFAULT '';

ALTER TABLE source_rights_grants
  ADD COLUMN IF NOT EXISTS terms_snapshot_sha256 TEXT NOT NULL DEFAULT '';

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS can_approve_source_rights INTEGER NOT NULL DEFAULT 0;

ALTER TABLE team_members
  ADD CONSTRAINT team_members_source_rights_capability_check
  CHECK (can_approve_source_rights IN (0, 1) AND (can_approve_source_rights = 0 OR role = 'admin'));

CREATE INDEX IF NOT EXISTS idx_team_members_source_rights_approver
  ON team_members (status, role, can_approve_source_rights);

CREATE TABLE source_rights_requests (
  id TEXT PRIMARY KEY,
  source_config_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  assertion_ref TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  rights_config_hash TEXT NOT NULL,
  decision TEXT CHECK (decision IS NULL OR decision IN ('approve', 'reject')),
  decision_note TEXT,
  dossier_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  dossier_hash TEXT,
  decided_by TEXT,
  request_idempotency_key TEXT NOT NULL,
  decision_idempotency_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE UNIQUE INDEX idx_source_rights_request_key
  ON source_rights_requests (source_config_id, request_idempotency_key);

CREATE UNIQUE INDEX idx_source_rights_decision_key
  ON source_rights_requests (decision_idempotency_key)
  WHERE decision_idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX idx_source_rights_pending
  ON source_rights_requests (source_config_id)
  WHERE status = 'pending';

CREATE INDEX idx_source_rights_requests_status
  ON source_rights_requests (status, created_at);
