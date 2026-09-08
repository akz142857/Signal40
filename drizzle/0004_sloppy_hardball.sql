CREATE TABLE `ingestion_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_config_id` text NOT NULL,
	`job_id` text,
	`status` text NOT NULL,
	`checkpoint_before` text,
	`checkpoint_after` text,
	`fetched_count` integer DEFAULT 0 NOT NULL,
	`accepted_count` integer DEFAULT 0 NOT NULL,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`error_json` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_config_id`) REFERENCES `source_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_ingestion_runs_source_created` ON `ingestion_runs` (`source_config_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `source_configs` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `source_configs` ADD `schedule_cron` text;