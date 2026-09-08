CREATE TABLE `team_members` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_members_email` ON `team_members` (`email`);--> statement-breakpoint
CREATE INDEX `idx_team_members_status_role` ON `team_members` (`status`,`role`);