CREATE TABLE `pipeline_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`article_count` integer NOT NULL,
	`topic_count` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_runs_created_at` ON `pipeline_runs` (`created_at`);--> statement-breakpoint
ALTER TABLE `topics` ADD `run_id` text REFERENCES pipeline_runs(id);--> statement-breakpoint
CREATE INDEX `idx_topics_run_score` ON `topics` (`run_id`,`score`);