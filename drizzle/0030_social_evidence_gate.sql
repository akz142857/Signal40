ALTER TABLE "calibration_runs" ADD COLUMN IF NOT EXISTS "calibration_kind" text DEFAULT 'score' NOT NULL;--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD COLUMN IF NOT EXISTS "dataset_ref" text;--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD COLUMN IF NOT EXISTS "dataset_sha256" text;--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD COLUMN IF NOT EXISTS "policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_origin_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"origin_id" text NOT NULL,
	"relationship" text NOT NULL,
	"evidence_family_id" text NOT NULL,
	"publisher_entity_id" text NOT NULL,
	"confidence" integer NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"supersedes_correction_id" text,
	"created_at" text NOT NULL,
	CONSTRAINT "source_origin_corrections_relationship_check" CHECK ("relationship" IN ('original', 'repost', 'quote', 'syndicated', 'unknown')),
	CONSTRAINT "source_origin_corrections_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 100)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_source_origin_corrections_current" ON "source_origin_corrections" USING btree ("origin_id") WHERE "supersedes_correction_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_source_origin_corrections_history" ON "source_origin_corrections" USING btree ("origin_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_calibration_runs_kind_status" ON "calibration_runs" USING btree ("calibration_kind", "status", "created_at");--> statement-breakpoint
ALTER TABLE "calibration_runs" DROP CONSTRAINT IF EXISTS "calibration_runs_social_evidence_check";--> statement-breakpoint
ALTER TABLE "calibration_runs" ADD CONSTRAINT "calibration_runs_social_evidence_check" CHECK (
	"calibration_kind" <> 'social_evidence' OR (
		"case_count" >= 100 AND "dataset_ref" IS NOT NULL AND length("dataset_ref") BETWEEN 1 AND 1000
		AND "dataset_sha256" ~ '^[a-f0-9]{64}$' AND jsonb_typeof("policy_json") = 'object'
	)
);
