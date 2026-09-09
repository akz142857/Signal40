CREATE TABLE "source_slo_exclusions" (
  "id" text PRIMARY KEY NOT NULL,
  "source_config_id" text NOT NULL,
  "kind" text NOT NULL,
  "starts_at" text NOT NULL,
  "ends_at" text,
  "reason" text NOT NULL,
  "created_by" text NOT NULL,
  "closed_by" text,
  "cancelled_by" text,
  "created_at" text NOT NULL,
  "closed_at" text,
  "cancelled_at" text,
  CONSTRAINT "source_slo_exclusions_kind_check"
    CHECK ("kind" IN ('manual_pause', 'planned_maintenance')),
  CONSTRAINT "source_slo_exclusions_time_check"
    CHECK ("ends_at" IS NULL OR "ends_at" > "starts_at"),
  CONSTRAINT "source_slo_exclusions_planned_end_check"
    CHECK ("kind" <> 'planned_maintenance' OR "ends_at" IS NOT NULL)
);--> statement-breakpoint
CREATE INDEX "idx_source_slo_exclusions_source_time"
  ON "source_slo_exclusions" ("source_config_id", "starts_at", "ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_slo_exclusions_identity"
  ON "source_slo_exclusions" ("source_config_id", "kind", "starts_at", "ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_slo_exclusions_open_manual"
  ON "source_slo_exclusions" ("source_config_id")
  WHERE "kind" = 'manual_pause' AND "ends_at" IS NULL;
