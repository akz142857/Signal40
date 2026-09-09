ALTER TABLE "ingestion_runs" ADD COLUMN "cost_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "cost_micros_per_request" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "estimated_requests_per_run" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "monthly_budget_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "budget_soft_limit_percent" integer DEFAULT 80 NOT NULL;