ALTER TABLE "ingestion_runs" ADD COLUMN "checkpoint_scope" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "backfill_checkpoint_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "backfill_checkpoint_version" integer DEFAULT 0 NOT NULL;