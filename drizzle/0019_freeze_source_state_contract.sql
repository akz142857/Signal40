UPDATE "source_configs"
SET "health_status" = CASE
  WHEN "health_status" IN ('disabled') THEN 'paused'
  WHEN "health_status" IN ('rate_limited', 'schema_changed') THEN 'degraded'
  WHEN "health_status" IN ('unknown', 'healthy', 'degraded', 'auth_required', 'paused', 'waiting_capacity') THEN "health_status"
  ELSE 'unknown'
END;--> statement-breakpoint
UPDATE "source_configs"
SET "rights_status" = CASE
  WHEN "rights_status" = 'restricted' THEN 'expired'
  WHEN "rights_status" = 'blocked' THEN 'revoked'
  WHEN "rights_status" IN ('pending', 'approved', 'revoked', 'expired') THEN "rights_status"
  ELSE 'pending'
END;--> statement-breakpoint
ALTER TABLE "source_configs" DROP CONSTRAINT IF EXISTS "source_configs_lifecycle_status_check";--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_lifecycle_status_check"
  CHECK ("lifecycle_status" IN ('draft', 'connecting', 'tested', 'enabled', 'degraded', 'auth_required', 'paused', 'archived'));--> statement-breakpoint
ALTER TABLE "source_configs" DROP CONSTRAINT IF EXISTS "source_configs_health_status_check";--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_health_status_check"
  CHECK ("health_status" IN ('unknown', 'healthy', 'degraded', 'auth_required', 'paused', 'waiting_capacity'));--> statement-breakpoint
ALTER TABLE "source_configs" DROP CONSTRAINT IF EXISTS "source_configs_rights_status_check";--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_rights_status_check"
  CHECK ("rights_status" IN ('pending', 'approved', 'revoked', 'expired'));--> statement-breakpoint
ALTER TABLE "ingestion_runs" DROP CONSTRAINT IF EXISTS "ingestion_runs_status_check";--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_status_check"
  CHECK ("status" IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'rights_blocked'));--> statement-breakpoint
ALTER TABLE "ingestion_runs" DROP CONSTRAINT IF EXISTS "ingestion_runs_quarantine_status_check";--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD CONSTRAINT "ingestion_runs_quarantine_status_check"
  CHECK ("quarantine_status" IN ('none', 'held', 'released', 'discarded'));--> statement-breakpoint
ALTER TABLE "source_connector_releases" DROP CONSTRAINT IF EXISTS "source_connector_releases_rollout_mode_check";--> statement-breakpoint
ALTER TABLE "source_connector_releases" ADD CONSTRAINT "source_connector_releases_rollout_mode_check"
  CHECK ("rollout_mode" IN ('disabled', 'shadow', 'enabled'));
