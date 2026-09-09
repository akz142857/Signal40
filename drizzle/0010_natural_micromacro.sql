CREATE TABLE "source_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text DEFAULT 'default' NOT NULL,
	"source_config_id" text NOT NULL,
	"connector_id" text NOT NULL,
	"provider" text NOT NULL,
	"secret_alias" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer NOT NULL,
	"supersedes_credential_id" text,
	"target_origins_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"header_name" text NOT NULL,
	"expires_at" text,
	"revoked_at" text,
	"created_by" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "credential_ref" text;--> statement-breakpoint
ALTER TABLE "ingestion_runs" ADD COLUMN "credential_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_source_credentials_source" ON "source_credentials" USING btree ("source_config_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_credentials_current" ON "source_credentials" USING btree ("source_config_id") WHERE "source_credentials"."revoked_at" IS NULL;