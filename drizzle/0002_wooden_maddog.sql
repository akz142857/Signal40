CREATE TABLE "automation_control" (
	"id" text PRIMARY KEY NOT NULL,
	"paused" integer DEFAULT 0 NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"updated_by" text,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "automation_policy_id" text;--> statement-breakpoint
CREATE INDEX "idx_jobs_automation_policy_created" ON "jobs" USING btree ("automation_policy_id","created_at");
--> statement-breakpoint
INSERT INTO "automation_control" ("id", "paused", "reason", "updated_at")
VALUES ('global', 0, '', '1970-01-01T00:00:00.000Z');
