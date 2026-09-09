CREATE TABLE "ingestion_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"ingestion_run_id" text NOT NULL,
	"page_key" text NOT NULL,
	"checkpoint_before_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checkpoint_after_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"result_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"committed_at" text
);
--> statement-breakpoint
CREATE TABLE "publisher_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"ownership_group" text NOT NULL,
	"entity_type" text NOT NULL,
	"identifiers_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connection_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"session_id" text,
	"kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"credential_version" integer DEFAULT 0 NOT NULL,
	"detail_redacted" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connection_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"initiated_by" text NOT NULL,
	"connector" text NOT NULL,
	"status" text NOT NULL,
	"state_hash" text NOT NULL,
	"pkce_challenge" text,
	"credential_ref" text,
	"credential_version" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_detail_redacted" text,
	"expires_at" text NOT NULL,
	"completed_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connection_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"job_id" text,
	"config_hash" text NOT NULL,
	"status" text NOT NULL,
	"preview_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_detail_redacted" text,
	"expires_at" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"finished_at" text
);
--> statement-breakpoint
CREATE TABLE "source_item_origins" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"namespace" text NOT NULL,
	"platform_item_id" text NOT NULL,
	"article_id" text NOT NULL,
	"article_revision_id" text,
	"ingestion_run_id" text NOT NULL,
	"canonical_url_hash" text NOT NULL,
	"fingerprint_version" text NOT NULL,
	"content_fingerprint" text NOT NULL,
	"relationship" text DEFAULT 'unknown' NOT NULL,
	"evidence_family_id" text,
	"publisher_entity_id" text,
	"confidence" integer DEFAULT 0 NOT NULL,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "source_item_rejections" (
	"id" text PRIMARY KEY NOT NULL,
	"ingestion_run_id" text NOT NULL,
	"platform_item_id" text,
	"item_index" integer NOT NULL,
	"error_code" text NOT NULL,
	"detail_redacted" text NOT NULL,
	"payload_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_rights_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"principal" text NOT NULL,
	"provider" text NOT NULL,
	"permitted_fields_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"purpose" text NOT NULL,
	"usage_scope" text NOT NULL,
	"territory" text DEFAULT 'global' NOT NULL,
	"evidence_ref" text NOT NULL,
	"terms_version" text NOT NULL,
	"verified_by" text NOT NULL,
	"granted_at" text NOT NULL,
	"verified_at" text NOT NULL,
	"expires_at" text,
	"revoked_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_configs" ALTER COLUMN "enabled" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "checkpoint_before_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "checkpoint_after_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "source_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "scheduled_for" text;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "trigger" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "required_capability" text DEFAULT 'source:rss' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "connector_version" text DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "payload_schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "duplicate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "byte_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "retryable" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "retry_after" text;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "result_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "fetch_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "queue_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "commit_duration_ms" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "shadow" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "quarantine_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "required_capability" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "payload_schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "minimum_worker_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "team_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "locator_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "locator_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "collection_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "capabilities_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "platform" text DEFAULT 'rss' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "lifecycle_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "config_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "last_tested_config_hash" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "publisher_entity_id" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "credential_ref" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "credential_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "checkpoint_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "checkpoint_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "next_run_at" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "backoff_until" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "retry_after" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "last_attempt_at" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "last_healthy_at" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "last_tested_at" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "last_error_detail_redacted" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "health_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "active_run_id" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "archived_at" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "capabilities_json" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
-- Expand migration backfill: preserve already-running sources while moving new writes to draft/test/enable.
UPDATE "source_configs" SET
	"platform" = CASE "adapter" WHEN 'http' THEN 'http_json' WHEN 'opencli' THEN 'wechat' ELSE 'rss' END,
	"locator_json" = jsonb_build_object('kind', 'url', 'url', COALESCE("config_json"::jsonb ->> 'url', '')),
	"locator_hash" = md5(CASE "adapter" WHEN 'http' THEN 'http_json' WHEN 'opencli' THEN 'wechat' ELSE 'rss' END || ':' || COALESCE("config_json"::jsonb ->> 'url', "id")),
	"config_hash" = md5("adapter" || ':' || "config_json"),
	"last_tested_config_hash" = CASE WHEN "enabled" = 1 THEN md5("adapter" || ':' || "config_json") ELSE NULL END,
	"lifecycle_status" = CASE WHEN "enabled" = 1 THEN 'enabled' ELSE 'paused' END,
	"health_status" = CASE WHEN "enabled" = 1 AND "last_error" IS NULL THEN 'healthy' WHEN "enabled" = 1 THEN 'degraded' ELSE 'disabled' END,
	"source_type" = "config_json"::jsonb ->> 'sourceType',
	"checkpoint_json" = CASE WHEN "checkpoint" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('schemaVersion', 1, 'watermark', "checkpoint") END,
	"collection_policy_json" = jsonb_build_object('scheduleCron', "schedule_cron", 'mode', 'standard', 'maxItems', 100),
	"capabilities_json" = CASE "adapter" WHEN 'rss' THEN '{"test":true,"backfill":true,"pagination":false}'::jsonb WHEN 'http' THEN '{"test":true,"backfill":true,"pagination":true}'::jsonb ELSE '{}'::jsonb END,
	"next_run_at" = CASE WHEN "enabled" = 1 AND "schedule_cron" IS NOT NULL THEN CURRENT_TIMESTAMP::text ELSE NULL END,
	"last_healthy_at" = CASE WHEN "last_error" IS NULL THEN "last_success_at" ELSE NULL END;--> statement-breakpoint
INSERT INTO "source_rights_grants"
	("id", "source_config_id", "principal", "provider", "permitted_fields_json", "purpose", "usage_scope", "territory", "evidence_ref", "terms_version", "verified_by", "granted_at", "verified_at", "created_at")
SELECT 'rights_migrated_' || "id", "id", 'migration', "platform", '["title","summary","url","publishedAt","author"]'::jsonb,
	'finance-editorial-ingestion', CASE WHEN "retention_mode" = 'raw' THEN 'normalized-and-authorized-raw' ELSE 'normalized-metadata' END,
	'global', 'legacy-config-migration', 'legacy-v1', 'migration', "created_at", "created_at", CURRENT_TIMESTAMP::text
FROM "source_configs" WHERE "rights_status" = 'approved';--> statement-breakpoint
UPDATE "jobs" j SET "required_capability" = CASE sc."adapter"
	WHEN 'rss' THEN 'source:rss' WHEN 'http' THEN 'source:http-json' ELSE 'source:' || sc."adapter" END
FROM "ingestion_runs" ir JOIN "source_configs" sc ON sc."id" = ir."source_config_id"
WHERE j."id" = ir."job_id" AND j."kind" = 'ingestion';--> statement-breakpoint
UPDATE "ingestion_runs" ir SET
	"source_version" = sc."version",
	"checkpoint_before_json" = sc."checkpoint_json",
	"required_capability" = CASE sc."adapter" WHEN 'rss' THEN 'source:rss' WHEN 'http' THEN 'source:http-json' ELSE 'source:' || sc."adapter" END
FROM "source_configs" sc WHERE sc."id" = ir."source_config_id";--> statement-breakpoint
UPDATE "source_configs" sc SET "active_run_id" = active."id"
FROM (
	SELECT DISTINCT ON ("source_config_id") "source_config_id", "id"
	FROM "ingestion_runs" WHERE "status" IN ('queued', 'running')
	ORDER BY "source_config_id", "created_at" DESC, "id" DESC
) active WHERE active."source_config_id" = sc."id";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ingestion_pages_run_key" ON "ingestion_pages" USING btree ("ingestion_run_id","page_key");--> statement-breakpoint
CREATE INDEX "idx_publisher_entities_group" ON "publisher_entities" USING btree ("ownership_group");--> statement-breakpoint
CREATE INDEX "idx_source_connection_events_source" ON "source_connection_events" USING btree ("source_config_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_source_connection_sessions_source" ON "source_connection_sessions" USING btree ("source_config_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_source_connection_tests_source" ON "source_connection_tests" USING btree ("source_config_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_item_origins_platform_item" ON "source_item_origins" USING btree ("source_config_id","namespace","platform_item_id");--> statement-breakpoint
CREATE INDEX "idx_source_item_origins_article" ON "source_item_origins" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_source_item_origins_family" ON "source_item_origins" USING btree ("evidence_family_id","publisher_entity_id");--> statement-breakpoint
CREATE INDEX "idx_source_item_rejections_run" ON "source_item_rejections" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE INDEX "idx_source_rights_active" ON "source_rights_grants" USING btree ("source_config_id","expires_at","revoked_at");--> statement-breakpoint
CREATE INDEX "idx_ingestion_runs_source_status" ON "ingestion_runs" USING btree ("source_config_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ingestion_runs_schedule_occurrence" ON "ingestion_runs" USING btree ("source_config_id","scheduled_for","trigger");--> statement-breakpoint
CREATE INDEX "idx_jobs_capability_status_available" ON "jobs" USING btree ("required_capability","status","available_at");--> statement-breakpoint
CREATE INDEX "idx_source_configs_schedule" ON "source_configs" USING btree ("lifecycle_status","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_source_configs_health" ON "source_configs" USING btree ("health_status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_configs_locator" ON "source_configs" USING btree ("team_id","platform","locator_hash");
