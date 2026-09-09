ALTER TABLE "source_configs" ADD COLUMN "schedule_priority" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "auto_throttle_enabled" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "effective_schedule_multiplier" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "schedule_throttle_reason" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "schedule_throttle_recovery_at" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_schedule_priority_check"
  CHECK ("schedule_priority" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_auto_throttle_check"
  CHECK ("auto_throttle_enabled" IN (0, 1));--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_schedule_multiplier_check"
  CHECK ("effective_schedule_multiplier" IN (1, 2, 4));--> statement-breakpoint

CREATE TABLE "source_schedule_throttles" (
  "id" text PRIMARY KEY NOT NULL,
  "source_config_id" text NOT NULL,
  "scheduled_for" text NOT NULL,
  "policy_version" text NOT NULL,
  "schedule_priority" integer NOT NULL,
  "cadence_multiplier" integer NOT NULL,
  "month_spent_micros" bigint NOT NULL,
  "monthly_budget_micros" bigint NOT NULL,
  "soft_limit_percent" integer NOT NULL,
  "reason_code" text NOT NULL,
  "recovery_at" text NOT NULL,
  "created_at" text NOT NULL,
  CONSTRAINT "source_schedule_throttles_priority_check"
    CHECK ("schedule_priority" BETWEEN 0 AND 100),
  CONSTRAINT "source_schedule_throttles_multiplier_check"
    CHECK ("cadence_multiplier" IN (2, 4)),
  CONSTRAINT "source_schedule_throttles_cost_check"
    CHECK ("month_spent_micros" >= 0 AND "monthly_budget_micros" > 0),
  CONSTRAINT "source_schedule_throttles_soft_limit_check"
    CHECK ("soft_limit_percent" BETWEEN 1 AND 99),
  CONSTRAINT "source_schedule_throttles_reason_check"
    CHECK ("reason_code" = 'budget_soft_limit')
);--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_schedule_throttles_occurrence"
  ON "source_schedule_throttles" ("source_config_id", "scheduled_for");--> statement-breakpoint
CREATE INDEX "idx_source_schedule_throttles_time"
  ON "source_schedule_throttles" ("scheduled_for", "source_config_id");
