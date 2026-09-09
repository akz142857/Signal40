ALTER TABLE "source_connector_releases" ADD COLUMN "canary_enabled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD COLUMN "canary_percent" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD COLUMN "canary_failure_rate_bps" integer DEFAULT 2000 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD COLUMN "canary_min_runs" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD COLUMN "canary_started_at" text;--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD COLUMN "canary_stopped_at" text;--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD CONSTRAINT "source_connector_releases_canary_enabled_check"
  CHECK ("canary_enabled" IN (0, 1));--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD CONSTRAINT "source_connector_releases_canary_percent_check"
  CHECK ("canary_percent" BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD CONSTRAINT "source_connector_releases_canary_failure_rate_check"
  CHECK ("canary_failure_rate_bps" BETWEEN 1 AND 10000);--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD CONSTRAINT "source_connector_releases_canary_min_runs_check"
  CHECK ("canary_min_runs" BETWEEN 1 AND 10000);
