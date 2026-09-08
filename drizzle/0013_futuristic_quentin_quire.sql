ALTER TABLE `article_revisions` ADD `raw_object_key` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `usage_scope` text DEFAULT 'current-project-and-configured-channels' NOT NULL;--> statement-breakpoint
ALTER TABLE `assets` ADD `provenance_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `assets` ADD `retention_until` text;--> statement-breakpoint
ALTER TABLE `assets` ADD `crop_json` text;--> statement-breakpoint
ALTER TABLE `claims` ADD `quantity_json` text;--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `article_revision_id` text REFERENCES article_revisions(id);--> statement-breakpoint
ALTER TABLE `evidence_links` ADD `locator_json` text DEFAULT '{"type":"url","value":""}' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `output_object_key` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `log_object_key` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `publish_jobs` ADD `account_id` text;--> statement-breakpoint
ALTER TABLE `publish_jobs` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `publish_jobs` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `publish_jobs` ADD `tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `publish_jobs` ADD `cover_asset_id` text;--> statement-breakpoint
ALTER TABLE `publish_jobs` ADD `final_url` text;--> statement-breakpoint
ALTER TABLE `publish_jobs` ADD `platform_response_json` text;--> statement-breakpoint
ALTER TABLE `render_snapshots` ADD `template_id` text DEFAULT 'signal40-editorial' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_configs` ADD `rate_limit_per_minute` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `source_configs` ADD `retention_mode` text DEFAULT 'metadata' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_configs` ADD `retention_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `voice_tracks` ADD `speed_milli` integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE `voice_tracks` ADD `pronunciation_json` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `voice_tracks` ADD `audio_sha256` text;--> statement-breakpoint
ALTER TABLE `voice_tracks` ADD `fallback_provider` text;--> statement-breakpoint
ALTER TABLE `voice_tracks` ADD `cost_micros` integer DEFAULT 0 NOT NULL;