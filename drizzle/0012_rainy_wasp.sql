ALTER TABLE `claims` ADD `logical_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `claims`
SET `logical_id` = CASE
  WHEN `id` LIKE `project_id` || '_%' THEN substr(`id`, length(`project_id`) + 2)
  ELSE `id`
END;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_claims_project_logical_id` ON `claims` (`project_id`,`logical_id`);
