ALTER TABLE "ingestion_runs" ADD COLUMN "rights_grant_id" text;--> statement-breakpoint
ALTER TABLE "source_rights_grants" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_rights_grants" ADD COLUMN "supersedes_grant_id" text;--> statement-breakpoint
ALTER TABLE "source_rights_grants" ADD COLUMN "source_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_rights_grants" ADD COLUMN "config_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "source_rights_grants" AS grant_row
SET "source_version" = source_row."version",
    "config_hash" = source_row."config_hash"
FROM "source_configs" AS source_row
WHERE source_row."id" = grant_row."source_config_id";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_rights_current" ON "source_rights_grants" USING btree ("source_config_id") WHERE "source_rights_grants"."revoked_at" IS NULL;
