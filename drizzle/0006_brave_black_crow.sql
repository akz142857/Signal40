PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`publish_job_id` text,
	`idempotency_key` text NOT NULL,
	`captured_at` text NOT NULL,
	`metrics_json` text NOT NULL,
	`attribution_json` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publish_job_id`) REFERENCES `publish_jobs`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_metric_snapshots` (`id`, `project_id`, `publish_job_id`, `idempotency_key`, `captured_at`, `metrics_json`, `attribution_json`) SELECT `id`, `project_id`, `publish_job_id`, `id`, `captured_at`, `metrics_json`, `attribution_json` FROM `metric_snapshots`;--> statement-breakpoint
DROP TABLE `metric_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_metric_snapshots` RENAME TO `metric_snapshots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_metric_snapshots_project_captured` ON `metric_snapshots` (`project_id`,`captured_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_metric_snapshots_idempotency` ON `metric_snapshots` (`project_id`,`idempotency_key`);
