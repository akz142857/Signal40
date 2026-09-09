ALTER TABLE "jobs" ADD COLUMN "required_capability_protocol_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capability_protocol_versions_json" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN "minimum_worker_version";