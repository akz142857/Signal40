ALTER TABLE "ingestion_runs"
  ADD COLUMN "fetch_outcome" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs"
  ADD CONSTRAINT "ingestion_runs_fetch_outcome_check"
  CHECK ("fetch_outcome" IN ('unknown', 'modified', 'not_modified'));
