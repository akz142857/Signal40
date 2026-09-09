CREATE TABLE "source_deletion_items" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_ref" text NOT NULL,
	"object_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"receipt_hash" text,
	"receipt_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error_redacted" text,
	"lease_expires_at" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "source_deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"source_version" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"requested_by" text NOT NULL,
	"legal_hold_id" text,
	"summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt_hash" text,
	"lease_owner" text,
	"lease_expires_at" text,
	"last_error_redacted" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "source_legal_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"source_config_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text NOT NULL,
	"authority_ref" text NOT NULL,
	"created_by" text NOT NULL,
	"released_by" text,
	"created_at" text NOT NULL,
	"released_at" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_deletion_item_target" ON "source_deletion_items" USING btree ("request_id","kind","target_ref");--> statement-breakpoint
CREATE INDEX "idx_source_deletion_item_status" ON "source_deletion_items" USING btree ("request_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_deletion_idempotency" ON "source_deletion_requests" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_source_deletion_status" ON "source_deletion_requests" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_source_deletion_source" ON "source_deletion_requests" USING btree ("source_config_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_source_legal_holds_source" ON "source_legal_holds" USING btree ("source_config_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_source_legal_hold_active" ON "source_legal_holds" USING btree ("source_config_id") WHERE "source_legal_holds"."status" = 'active';