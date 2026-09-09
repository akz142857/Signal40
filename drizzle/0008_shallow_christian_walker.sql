CREATE TABLE "source_connector_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"connector_id" text NOT NULL,
	"connector_version" text NOT NULL,
	"rollout_mode" text DEFAULT 'disabled' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "connector_id" text DEFAULT 'rss-v1' NOT NULL;--> statement-breakpoint
UPDATE "ingestion_runs"
SET "connector_id" = CASE
  WHEN "required_capability" = 'source:http-json' THEN 'http-json-v1'
  WHEN "required_capability" = 'source:browser' THEN 'web-page-v1'
  WHEN "required_capability" = 'source:wechat' THEN 'wechat-v1'
  WHEN "required_capability" = 'source:xiaohongshu' THEN 'xiaohongshu-v1'
  ELSE 'rss-v1'
END;--> statement-breakpoint
INSERT INTO "source_connector_releases"
  ("id", "connector_id", "connector_version", "rollout_mode", "reason", "version", "updated_by", "created_at", "updated_at")
VALUES
  ('rss-v1@1', 'rss-v1', '1', 'enabled', 'Foundation 本地默认连接器。', 1, 'migration:0008', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
  ('http-json-v1@1', 'http-json-v1', '1', 'enabled', 'Foundation 本地默认连接器。', 1, 'migration:0008', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
  ('web-page-v1@1', 'web-page-v1', '1', 'disabled', '外部 Spike 与隔离验收未完成。', 1, 'migration:0008', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
  ('wechat-v1@1', 'wechat-v1', '1', 'disabled', '外部 Spike 与授权路径未完成。', 1, 'migration:0008', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'),
  ('xiaohongshu-v1@1', 'xiaohongshu-v1', '1', 'disabled', '外部 Spike 与授权路径未完成。', 1, 'migration:0008', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_connector_release" ON "source_connector_releases" USING btree ("connector_id","connector_version");--> statement-breakpoint
CREATE INDEX "idx_source_connector_rollout" ON "source_connector_releases" USING btree ("rollout_mode","updated_at");
