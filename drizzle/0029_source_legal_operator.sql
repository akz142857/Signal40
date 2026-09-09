ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS can_manage_source_legal INTEGER NOT NULL DEFAULT 0;

ALTER TABLE team_members
  ADD CONSTRAINT team_members_source_legal_capability_check
  CHECK (can_manage_source_legal IN (0, 1) AND (can_manage_source_legal = 0 OR role = 'admin'));

CREATE INDEX IF NOT EXISTS idx_team_members_source_legal_operator
  ON team_members (status, role, can_manage_source_legal);
