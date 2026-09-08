CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`decision` text NOT NULL,
	`subject_hash` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_approvals_project_kind_created` ON `approvals` (`project_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `article_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`observed_at` text NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_revisions_article_revision` ON `article_revisions` (`article_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_article_revisions_hash` ON `article_revisions` (`article_id`,`content_hash`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`object_key` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`rights_status` text NOT NULL,
	`rights_note` text DEFAULT '' NOT NULL,
	`derived_from_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_assets_object_key` ON `assets` (`object_key`);--> statement-breakpoint
CREATE INDEX `idx_assets_project_rights` ON `assets` (`project_id`,`rights_status`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`actor_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before_hash` text,
	`after_hash` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_audit_events_project_created` ON `audit_events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_entity` ON `audit_events` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `caption_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`voice_track_id` text,
	`format` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`voice_track_id`) REFERENCES `voice_tracks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_caption_tracks_project_created` ON `caption_tracks` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_claims_project_status` ON `claims` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `content_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`topic_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text DEFAULT 'DRAFT' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`owner_id` text NOT NULL,
	`brand` text DEFAULT 'Signal 40' NOT NULL,
	`locale` text DEFAULT 'zh-CN' NOT NULL,
	`project_json` text NOT NULL,
	`immutable_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_content_projects_topic` ON `content_projects` (`topic_id`);--> statement-breakpoint
CREATE INDEX `idx_content_projects_state_updated` ON `content_projects` (`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `evidence_links` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`article_id` text,
	`source_url` text NOT NULL,
	`stance` text NOT NULL,
	`excerpt` text NOT NULL,
	`source_hash` text NOT NULL,
	`observed_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_evidence_claim_stance` ON `evidence_links` (`claim_id`,`stance`);--> statement-breakpoint
CREATE TABLE `idempotency_records` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_idempotency_expires` ON `idempotency_records` (`expires_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`project_id` text,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`idempotency_key` text NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`available_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`result_json` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_jobs_idempotency` ON `jobs` (`kind`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_jobs_poll` ON `jobs` (`status`,`available_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_project_kind` ON `jobs` (`project_id`,`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`publish_job_id` text,
	`captured_at` text NOT NULL,
	`metrics_json` text NOT NULL,
	`attribution_json` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`publish_job_id`) REFERENCES `publish_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_metric_snapshots_project_captured` ON `metric_snapshots` (`project_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `publish_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`channel` text NOT NULL,
	`logical_key` text NOT NULL,
	`status` text NOT NULL,
	`scheduled_at` text,
	`external_id` text,
	`package_object_key` text,
	`correction_of_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_publish_jobs_logical_key` ON `publish_jobs` (`channel`,`logical_key`);--> statement-breakpoint
CREATE INDEX `idx_publish_jobs_project_status` ON `publish_jobs` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `qc_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`render_job_id` text,
	`status` text NOT NULL,
	`checks_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`render_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_qc_reports_project_created` ON `qc_reports` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `render_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`template_version` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_render_snapshots_hash` ON `render_snapshots` (`project_id`,`snapshot_hash`);--> statement-breakpoint
CREATE TABLE `research_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`snapshot_hash` text NOT NULL,
	`approved_by` text,
	`approved_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_snapshots_project_version` ON `research_snapshots` (`project_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_snapshots_project_hash` ON `research_snapshots` (`project_id`,`snapshot_hash`);--> statement-breakpoint
CREATE TABLE `script_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`script_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_script_versions_project_version` ON `script_versions` (`project_id`,`version`);--> statement-breakpoint
CREATE TABLE `source_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter` text NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`rights_status` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`checkpoint` text,
	`last_success_at` text,
	`last_error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_source_configs_enabled` ON `source_configs` (`enabled`,`updated_at`);--> statement-breakpoint
CREATE TABLE `storyboard_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`storyboard_json` text NOT NULL,
	`content_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_storyboard_versions_project_version` ON `storyboard_versions` (`project_id`,`version`);--> statement-breakpoint
CREATE TABLE `voice_tracks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`script_version` integer NOT NULL,
	`provider` text NOT NULL,
	`voice` text NOT NULL,
	`object_key` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`alignment_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `content_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_voice_tracks_project_created` ON `voice_tracks` (`project_id`,`created_at`);