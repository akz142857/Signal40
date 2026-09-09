DROP TABLE IF EXISTS "source_credentials";--> statement-breakpoint
DROP TABLE IF EXISTS "source_connection_sessions";--> statement-breakpoint
DROP TABLE IF EXISTS "source_connection_events";--> statement-breakpoint
ALTER TABLE "source_proposals" DROP CONSTRAINT IF EXISTS "source_proposals_adapter_check";--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_adapter_check" CHECK ("adapter" IN ('rss', 'http', 'web'));--> statement-breakpoint
ALTER TABLE "source_proposals" DROP CONSTRAINT IF EXISTS "source_proposals_platform_check";--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_platform_check" CHECK ("platform" IN ('rss', 'http_json', 'web_page', 'wechat', 'xiaohongshu'));--> statement-breakpoint
UPDATE "source_configs" SET "lifecycle_status" = 'degraded' WHERE "lifecycle_status" = 'auth_required';--> statement-breakpoint
UPDATE "source_configs" SET "health_status" = 'degraded' WHERE "health_status" = 'auth_required';--> statement-breakpoint
ALTER TABLE "source_configs" DROP CONSTRAINT IF EXISTS "source_configs_lifecycle_status_check";--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_lifecycle_status_check" CHECK ("lifecycle_status" IN ('draft', 'connecting', 'tested', 'enabled', 'degraded', 'paused', 'archived'));--> statement-breakpoint
ALTER TABLE "source_configs" DROP CONSTRAINT IF EXISTS "source_configs_health_status_check";--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_health_status_check" CHECK ("health_status" IN ('unknown', 'healthy', 'degraded', 'paused', 'waiting_capacity'));--> statement-breakpoint
ALTER TABLE "source_configs" DROP COLUMN IF EXISTS "credential_ref";--> statement-breakpoint
ALTER TABLE "source_configs" DROP COLUMN IF EXISTS "credential_version";--> statement-breakpoint
ALTER TABLE "source_configs" DROP COLUMN IF EXISTS "credential_steward_id";--> statement-breakpoint
ALTER TABLE "source_configs" DROP COLUMN IF EXISTS "backup_admin_id";--> statement-breakpoint
ALTER TABLE "ingestion_runs" DROP COLUMN IF EXISTS "credential_ref";--> statement-breakpoint
ALTER TABLE "ingestion_runs" DROP COLUMN IF EXISTS "credential_version";--> statement-breakpoint
UPDATE "source_configs" SET "enabled" = 0, "lifecycle_status" = 'archived',
  "health_status" = 'paused', "archived_at" = COALESCE("archived_at", '2026-09-09T00:00:00.000Z'),
  "updated_at" = '2026-09-09T00:00:00.000Z'
WHERE "adapter" = 'opencli';--> statement-breakpoint
DELETE FROM "source_connector_releases"
WHERE "connector_id" IN ('wechat-v1', 'xiaohongshu-v1');--> statement-breakpoint
UPDATE "source_connector_releases" SET "rollout_mode" = 'enabled',
  "reason" = '公开 HTML/JSON-LD 轻量连接器。', "version" = "version" + 1,
  "updated_by" = 'migration:0031', "updated_at" = '2026-09-09T00:00:00.000Z'
WHERE "connector_id" = 'web-page-v1' AND "connector_version" = '1';--> statement-breakpoint
INSERT INTO "source_connector_releases"
  ("id", "connector_id", "connector_version", "rollout_mode", "reason", "version", "updated_by", "created_at", "updated_at")
VALUES
  ('wechat-feed-v1@1', 'wechat-feed-v1', '1', 'enabled', '使用已获允许的公开 RSS/Atom Feed。', 1, 'migration:0031', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
  ('xiaohongshu-feed-v1@1', 'xiaohongshu-feed-v1', '1', 'enabled', '使用已获允许的公开 RSS/Atom Feed。', 1, 'migration:0031', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')
ON CONFLICT ("connector_id", "connector_version") DO UPDATE SET
  "rollout_mode" = excluded."rollout_mode", "reason" = excluded."reason",
  "version" = "source_connector_releases"."version" + 1,
  "updated_by" = excluded."updated_by", "updated_at" = excluded."updated_at";
