CREATE TABLE `articles` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_type` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`published_at` text NOT NULL,
	`metrics_json` text DEFAULT '{}' NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_articles_content_hash` ON `articles` (`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_articles_published_at` ON `articles` (`published_at`);--> statement-breakpoint
CREATE INDEX `idx_articles_source_type_published_at` ON `articles` (`source_type`,`published_at`);--> statement-breakpoint
CREATE TABLE `topic_articles` (
	`topic_id` text NOT NULL,
	`article_id` text NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_topic_articles_pair` ON `topic_articles` (`topic_id`,`article_id`);--> statement-breakpoint
CREATE INDEX `idx_topic_articles_article` ON `topic_articles` (`article_id`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`keywords_json` text DEFAULT '[]' NOT NULL,
	`score` integer NOT NULL,
	`heat_change` integer DEFAULT 0 NOT NULL,
	`score_breakdown_json` text NOT NULL,
	`source_count` integer NOT NULL,
	`status` text NOT NULL,
	`gate_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_topics_score_updated_at` ON `topics` (`score`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_topics_status_score` ON `topics` (`status`,`score`);--> statement-breakpoint
CREATE TABLE `verification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`status` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_verification_topic_created` ON `verification_events` (`topic_id`,`created_at`);