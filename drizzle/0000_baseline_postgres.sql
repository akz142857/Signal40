CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"decision" text NOT NULL,
	"subject_hash" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"note" text NOT NULL,
	"created_at" text NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "article_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"article_id" text NOT NULL,
	"revision" integer NOT NULL,
	"content_json" text NOT NULL,
	"content_hash" text NOT NULL,
	"raw_object_key" text,
	"observed_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "articles" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_type" text NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"published_at" text NOT NULL,
	"metrics_json" text DEFAULT '{}' NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"upload_id" text NOT NULL,
	"object_key" text NOT NULL,
	"filename" text NOT NULL,
	"media_type" text NOT NULL,
	"rights_status" text NOT NULL,
	"rights_note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"object_key" text NOT NULL,
	"media_type" text NOT NULL,
	"asset_role" text DEFAULT 'input' NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"rights_status" text NOT NULL,
	"rights_note" text DEFAULT '' NOT NULL,
	"usage_scope" text DEFAULT 'current-project-and-configured-channels' NOT NULL,
	"provenance_json" text DEFAULT '{}' NOT NULL,
	"retention_until" text,
	"crop_json" text,
	"derived_from_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"actor_id" text NOT NULL,
	"actor_role" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_hash" text,
	"after_hash" text,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text NOT NULL,
	"created_at" text NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calibration_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"algorithm_version" text NOT NULL,
	"dataset_label" text NOT NULL,
	"case_count" integer NOT NULL,
	"metrics_json" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"created_by" text NOT NULL,
	"approved_by" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caption_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"voice_track_id" text,
	"format" text NOT NULL,
	"content" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"logical_id" text NOT NULL,
	"text" text NOT NULL,
	"kind" text NOT NULL,
	"quantity_json" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"publish_job_id" text,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"reason" text NOT NULL,
	"resolution" text,
	"actor_id" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"owner_id" text NOT NULL,
	"brand" text DEFAULT 'Signal 40' NOT NULL,
	"locale" text DEFAULT 'zh-CN' NOT NULL,
	"project_json" text NOT NULL,
	"immutable_hash" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_links" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"article_id" text,
	"article_revision_id" text,
	"source_url" text NOT NULL,
	"stance" text NOT NULL,
	"excerpt" text NOT NULL,
	"locator_json" text DEFAULT '{"type":"url","value":""}' NOT NULL,
	"source_hash" text NOT NULL,
	"observed_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"variants_json" text NOT NULL,
	"allocation_bps_json" text NOT NULL,
	"primary_metric" text NOT NULL,
	"guardrails_json" text DEFAULT '[]' NOT NULL,
	"created_by" text NOT NULL,
	"starts_at" text,
	"ends_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_json" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"job_id" text,
	"status" text NOT NULL,
	"checkpoint_before" text,
	"checkpoint_after" text,
	"fetched_count" integer DEFAULT 0 NOT NULL,
	"accepted_count" integer DEFAULT 0 NOT NULL,
	"rejected_count" integer DEFAULT 0 NOT NULL,
	"error_json" text,
	"started_at" text,
	"finished_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project_id" text,
	"payload_json" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"timeout_seconds" integer DEFAULT 900 NOT NULL,
	"estimated_cost_micros" integer DEFAULT 0 NOT NULL,
	"available_at" text NOT NULL,
	"lease_owner" text,
	"lease_expires_at" text,
	"result_json" text,
	"output_object_key" text,
	"log_object_key" text,
	"duration_ms" integer,
	"last_error" text,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"publish_job_id" text,
	"idempotency_key" text NOT NULL,
	"captured_at" text NOT NULL,
	"metrics_json" text NOT NULL,
	"attribution_json" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"article_count" integer NOT NULL,
	"topic_count" integer NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_experiment_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"experiment_id" text NOT NULL,
	"variant" text NOT NULL,
	"assignment_hash" text NOT NULL,
	"assigned_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publish_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"channel" text NOT NULL,
	"logical_key" text NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" text,
	"account_id" text,
	"title" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"tags_json" text DEFAULT '[]' NOT NULL,
	"cover_asset_id" text,
	"external_id" text,
	"package_object_key" text,
	"final_url" text,
	"platform_response_json" text,
	"correction_of_id" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qc_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"render_job_id" text,
	"status" text NOT NULL,
	"checks_json" text NOT NULL,
	"created_at" text NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"snapshot_json" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"template_version" text NOT NULL,
	"template_id" text DEFAULT 'signal40-editorial' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"snapshot_json" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"approved_by" text,
	"approved_at" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"script_json" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"adapter" text NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"rights_status" text NOT NULL,
	"rate_limit_per_minute" integer DEFAULT 30 NOT NULL,
	"retention_mode" text DEFAULT 'metadata' NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"schedule_cron" text,
	"checkpoint" text,
	"last_success_at" text,
	"last_error" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storyboard_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"storyboard_json" text NOT NULL,
	"content_hash" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"user_id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_articles" (
	"topic_id" text NOT NULL,
	"article_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"keywords_json" text DEFAULT '[]' NOT NULL,
	"run_id" text,
	"score" integer NOT NULL,
	"heat_change" integer DEFAULT 0 NOT NULL,
	"score_breakdown_json" text NOT NULL,
	"source_count" integer NOT NULL,
	"status" text NOT NULL,
	"gate_json" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_events" (
	"id" text PRIMARY KEY NOT NULL,
	"topic_id" text NOT NULL,
	"status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" text NOT NULL,
	"seq" bigserial NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"script_version" integer NOT NULL,
	"provider" text NOT NULL,
	"voice" text NOT NULL,
	"object_key" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"speed_milli" integer DEFAULT 1000 NOT NULL,
	"pronunciation_json" text DEFAULT '{}' NOT NULL,
	"audio_sha256" text,
	"fallback_provider" text,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"alignment_json" text DEFAULT '[]' NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"signature_hash" text NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"occurred_at" text,
	"payload_json" text NOT NULL,
	"received_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_approvals_project_kind_created" ON "approvals" USING btree ("project_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_article_revisions_article_revision" ON "article_revisions" USING btree ("article_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_article_revisions_hash" ON "article_revisions" USING btree ("article_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_articles_content_hash" ON "articles" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "idx_articles_published_at" ON "articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "idx_articles_source_type_published_at" ON "articles" USING btree ("source_type","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_asset_upload_sessions_upload" ON "asset_upload_sessions" USING btree ("upload_id");--> statement-breakpoint
CREATE INDEX "idx_asset_upload_sessions_project_status" ON "asset_upload_sessions" USING btree ("project_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_assets_object_key" ON "assets" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "idx_assets_project_rights" ON "assets" USING btree ("project_id","rights_status");--> statement-breakpoint
CREATE INDEX "idx_audit_events_project_created" ON "audit_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_entity" ON "audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_calibration_runs_status_created" ON "calibration_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_caption_tracks_project_created" ON "caption_tracks" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_claims_project_logical_id" ON "claims" USING btree ("project_id","logical_id");--> statement-breakpoint
CREATE INDEX "idx_claims_project_status" ON "claims" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_content_incidents_status_created" ON "content_incidents" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_content_projects_topic" ON "content_projects" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "idx_content_projects_state_updated" ON "content_projects" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "idx_evidence_claim_stance" ON "evidence_links" USING btree ("claim_id","stance");--> statement-breakpoint
CREATE INDEX "idx_experiments_status_created" ON "experiments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_idempotency_expires" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_ingestion_runs_source_created" ON "ingestion_runs" USING btree ("source_config_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_jobs_idempotency" ON "jobs" USING btree ("kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_jobs_poll" ON "jobs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_kind_status_available" ON "jobs" USING btree ("kind","status","available_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_project_kind" ON "jobs" USING btree ("project_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_metric_snapshots_project_captured" ON "metric_snapshots" USING btree ("project_id","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_metric_snapshots_idempotency" ON "metric_snapshots" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_pipeline_runs_created_at" ON "pipeline_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_experiment_unique" ON "project_experiment_assignments" USING btree ("project_id","experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_publish_jobs_logical_key" ON "publish_jobs" USING btree ("channel","logical_key");--> statement-breakpoint
CREATE INDEX "idx_publish_jobs_project_status" ON "publish_jobs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_qc_reports_project_created" ON "qc_reports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_render_snapshots_hash" ON "render_snapshots" USING btree ("project_id","snapshot_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_research_snapshots_project_version" ON "research_snapshots" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_research_snapshots_project_hash" ON "research_snapshots" USING btree ("project_id","snapshot_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_script_versions_project_version" ON "script_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE INDEX "idx_source_configs_enabled" ON "source_configs" USING btree ("enabled","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_storyboard_versions_project_version" ON "storyboard_versions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_team_members_email" ON "team_members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_team_members_status_role" ON "team_members" USING btree ("status","role");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_topic_articles_pair" ON "topic_articles" USING btree ("topic_id","article_id");--> statement-breakpoint
CREATE INDEX "idx_topic_articles_article" ON "topic_articles" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "idx_topics_score_updated_at" ON "topics" USING btree ("score","updated_at");--> statement-breakpoint
CREATE INDEX "idx_topics_status_score" ON "topics" USING btree ("status","score");--> statement-breakpoint
CREATE INDEX "idx_topics_run_score" ON "topics" USING btree ("run_id","score","source_count");--> statement-breakpoint
CREATE INDEX "idx_verification_topic_created" ON "verification_events" USING btree ("topic_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_voice_tracks_project_created" ON "voice_tracks" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_webhook_events_provider_external" ON "webhook_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_events_received" ON "webhook_events" USING btree ("received_at");