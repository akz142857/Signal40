CREATE TABLE `calibration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`algorithm_version` text NOT NULL,
	`dataset_label` text NOT NULL,
	`case_count` integer NOT NULL,
	`metrics_json` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`created_by` text NOT NULL,
	`approved_by` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_calibration_runs_status_created` ON `calibration_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hypothesis` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`variants_json` text NOT NULL,
	`allocation_bps_json` text NOT NULL,
	`primary_metric` text NOT NULL,
	`guardrails_json` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`starts_at` text,
	`ends_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_experiments_status_created` ON `experiments` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `project_experiment_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`experiment_id` text NOT NULL,
	`variant` text NOT NULL,
	`assignment_hash` text NOT NULL,
	`assigned_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_experiment_unique` ON `project_experiment_assignments` (`project_id`,`experiment_id`);