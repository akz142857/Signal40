CREATE TABLE "source_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"platform" text NOT NULL,
	"source_type" text NOT NULL,
	"url" text NOT NULL,
	"schedule_cron" text,
	"status" text DEFAULT 'proposal_pending' NOT NULL,
	"requested_by" text NOT NULL,
	"request_note" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"decided_by" text,
	"decision_note" text,
	"decision_idempotency_key" text,
	"source_config_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"decided_at" text,
	CONSTRAINT "source_proposals_adapter_check" CHECK ("adapter" IN ('rss', 'http')),
	CONSTRAINT "source_proposals_platform_check" CHECK ("platform" IN ('rss', 'http_json')),
	CONSTRAINT "source_proposals_status_check" CHECK ("status" IN ('proposal_pending', 'proposal_approved', 'proposal_rejected'))
);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_proposals_idempotency" ON "source_proposals" USING btree ("team_id","requested_by","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_proposals_decision_idempotency" ON "source_proposals" USING btree ("decision_idempotency_key") WHERE "decision_idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_source_proposals_status_created" ON "source_proposals" USING btree ("status","created_at");
