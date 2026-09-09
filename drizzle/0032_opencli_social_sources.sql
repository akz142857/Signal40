ALTER TABLE "source_proposals" ADD COLUMN IF NOT EXISTS "discovery_mode" text;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD COLUMN IF NOT EXISTS "account_name" text;--> statement-breakpoint
ALTER TABLE "source_proposals" ADD COLUMN IF NOT EXISTS "search_limit" integer;--> statement-breakpoint
ALTER TABLE "source_proposals" DROP CONSTRAINT IF EXISTS "source_proposals_adapter_check";--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_adapter_check" CHECK ("adapter" IN ('rss', 'http', 'web', 'social'));--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_discovery_mode_check" CHECK ("discovery_mode" IS NULL OR "discovery_mode" IN ('opencli', 'rss'));--> statement-breakpoint
ALTER TABLE "source_proposals" ADD CONSTRAINT "source_proposals_search_limit_check" CHECK ("search_limit" IS NULL OR "search_limit" BETWEEN 1 AND 50);--> statement-breakpoint
UPDATE "source_configs" SET "enabled" = 0, "lifecycle_status" = 'archived',
  "health_status" = 'paused', "last_error_code" = 'CONNECTOR_UNAVAILABLE',
  "last_error" = '旧版社交 Feed 配置已由真实 OpenCLI/RSS 双策略连接器替代，请重新登记。',
  "archived_at" = COALESCE("archived_at", '2026-09-09T00:00:00.000Z'),
  "updated_at" = '2026-09-09T00:00:00.000Z'
WHERE "platform" IN ('wechat', 'xiaohongshu') AND "adapter" = 'rss';--> statement-breakpoint
DELETE FROM "source_connector_releases"
WHERE "connector_id" IN ('wechat-feed-v1', 'xiaohongshu-feed-v1');--> statement-breakpoint
INSERT INTO "source_connector_releases"
  ("id", "connector_id", "connector_version", "rollout_mode", "reason", "version", "updated_by", "created_at", "updated_at")
VALUES
  ('wechat-monitor-v1@1', 'wechat-monitor-v1', '1', 'enabled', 'OpenCLI 账号搜索或获准第三方 RSS，由 Signal40 调度与去重。', 1, 'migration:0032', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
  ('xiaohongshu-monitor-v1@1', 'xiaohongshu-monitor-v1', '1', 'enabled', 'OpenCLI 账号搜索或获准第三方 RSS，由 Signal40 调度与去重。', 1, 'migration:0032', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')
ON CONFLICT ("connector_id", "connector_version") DO UPDATE SET
  "rollout_mode" = excluded."rollout_mode", "reason" = excluded."reason",
  "version" = "source_connector_releases"."version" + 1,
  "updated_by" = excluded."updated_by", "updated_at" = excluded."updated_at";
