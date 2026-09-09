ALTER TABLE "ingestion_pages" ADD COLUMN "page_ordinal" integer;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "lease_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "final_page" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "fetched_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "accepted_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "rejected_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "duplicate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "request_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_pages" ADD COLUMN "byte_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_ingestion_pages_run_ordinal" ON "ingestion_pages" USING btree ("ingestion_run_id","page_ordinal");