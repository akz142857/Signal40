CREATE TABLE "raw_payload_uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text DEFAULT 'default' NOT NULL,
	"source_config_id" text NOT NULL,
	"ingestion_run_id" text NOT NULL,
	"state" text DEFAULT 'initiated' NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"committed_at" text,
	"delete_after" text NOT NULL,
	"deleted_at" text,
	"delete_attempts" integer DEFAULT 0 NOT NULL,
	"delete_lease_expires_at" text,
	"last_error_redacted" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_raw_payload_uploads_run" ON "raw_payload_uploads" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_raw_payload_uploads_object" ON "raw_payload_uploads" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "idx_raw_payload_uploads_expiry" ON "raw_payload_uploads" USING btree ("state","expires_at");--> statement-breakpoint
CREATE INDEX "idx_raw_payload_uploads_delete_after" ON "raw_payload_uploads" USING btree ("state","delete_after");--> statement-breakpoint
CREATE INDEX "idx_raw_payload_uploads_source" ON "raw_payload_uploads" USING btree ("source_config_id","created_at");