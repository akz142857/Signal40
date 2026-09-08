CREATE TABLE `asset_upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`upload_id` text NOT NULL,
	`object_key` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`rights_status` text NOT NULL,
	`rights_note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`expires_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_asset_upload_sessions_upload` ON `asset_upload_sessions` (`upload_id`);--> statement-breakpoint
CREATE INDEX `idx_asset_upload_sessions_project_status` ON `asset_upload_sessions` (`project_id`,`status`,`created_at`);