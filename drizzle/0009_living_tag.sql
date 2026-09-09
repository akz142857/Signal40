CREATE TABLE "source_checkpoint_cutovers" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_version" integer NOT NULL,
	"checkpoint_version_before" integer NOT NULL,
	"checkpoint_before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checkpoint_after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"approved_by" text,
	"reason" text NOT NULL,
	"decision_note" text,
	"created_at" text NOT NULL,
	"decided_at" text,
	"applied_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_checkpoint_cutover_idempotency" ON "source_checkpoint_cutovers" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_source_checkpoint_cutover_pending" ON "source_checkpoint_cutovers" USING btree ("source_config_id","status","created_at");