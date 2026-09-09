ALTER TABLE ingestion_pages
  ADD COLUMN IF NOT EXISTS staged_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb;
