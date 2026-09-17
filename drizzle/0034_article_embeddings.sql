ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "embedding_json" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "embedding_model" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "embedding_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "embedded_at" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_articles_embedding_model_published_at" ON "articles" ("embedding_model","published_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "topic_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"description_hash" text NOT NULL,
	"centroid_json" text DEFAULT '' NOT NULL,
	"centroid_source_hash" text DEFAULT '' NOT NULL,
	"centroid_model" text DEFAULT '' NOT NULL,
	"centroid_version" integer DEFAULT 0 NOT NULL,
	"relevance_threshold" text DEFAULT '0.3' NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_topic_domains_name" ON "topic_domains" ("name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_topic_domains_enabled" ON "topic_domains" ("enabled");--> statement-breakpoint
ALTER TABLE "topic_domains" DROP CONSTRAINT IF EXISTS "topic_domains_enabled_check";--> statement-breakpoint
ALTER TABLE "topic_domains" ADD CONSTRAINT "topic_domains_enabled_check" CHECK ("enabled" IN ('true', 'false'));
