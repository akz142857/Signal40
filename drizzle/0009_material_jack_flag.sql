CREATE TABLE `content_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`publish_job_id` text,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reason` text NOT NULL,
	`resolution` text,
	`actor_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publish_job_id`) REFERENCES `publish_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_content_incidents_status_created` ON `content_incidents` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`external_event_id` text NOT NULL,
	`signature_hash` text NOT NULL,
	`payload_hash` text NOT NULL,
	`status` text NOT NULL,
	`occurred_at` text,
	`payload_json` text NOT NULL,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_webhook_events_provider_external` ON `webhook_events` (`provider`,`external_event_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_events_received` ON `webhook_events` (`received_at`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `cost_micros` integer DEFAULT 0 NOT NULL;