ALTER TABLE `jobs` ADD `priority` integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `timeout_seconds` integer DEFAULT 900 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `estimated_cost_micros` integer DEFAULT 0 NOT NULL;