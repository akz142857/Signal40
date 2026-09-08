CREATE TABLE "attention_items" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'warning' NOT NULL,
	"project_id" text,
	"topic_id" text,
	"policy_id" text,
	"dedupe_key" text NOT NULL,
	"reason" text NOT NULL,
	"detail_json" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notified_at" text,
	"notify_error" text,
	"resolved_by" text,
	"resolved_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope_json" text DEFAULT '{}' NOT NULL,
	"stages_json" text DEFAULT '{}' NOT NULL,
	"auto_approvals_json" text DEFAULT '{}' NOT NULL,
	"research_authorized_by" text,
	"publish_authorized_by" text,
	"guardrails_json" text DEFAULT '{}' NOT NULL,
	"authorized_at" text,
	"expires_at" text,
	"enabled" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" text NOT NULL,
	"finished_at" text,
	"duration_ms" integer,
	"project_count" integer DEFAULT 0 NOT NULL,
	"actions_json" text DEFAULT '[]' NOT NULL,
	"breakers_json" text DEFAULT '{}' NOT NULL,
	"errors_json" text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"kinds_json" text DEFAULT '[]' NOT NULL,
	"version" text DEFAULT '' NOT NULL,
	"last_heartbeat_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_projects" ADD COLUMN "automation_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_projects" ADD COLUMN "automation_paused_reason" text;--> statement-breakpoint
ALTER TABLE "content_projects" ADD COLUMN "automation_policy_id" text;--> statement-breakpoint
ALTER TABLE "topics" ADD COLUMN "quality_json" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_attention_items_dedupe" ON "attention_items" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_attention_items_status_created" ON "attention_items" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_attention_items_project" ON "attention_items" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_policies_name" ON "automation_policies" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_automation_policies_enabled" ON "automation_policies" USING btree ("enabled","updated_at");--> statement-breakpoint
CREATE INDEX "idx_automation_runs_started" ON "automation_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_workers_heartbeat" ON "workers" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_content_projects_automation" ON "content_projects" USING btree ("automation_mode","state");