ALTER TABLE "source_configs" ADD COLUMN "legal_hold_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_legal_hold_epoch_check"
  CHECK ("legal_hold_epoch" >= 0);--> statement-breakpoint

ALTER TABLE "source_legal_holds" ADD COLUMN "hold_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked_holds AS (
  SELECT id,
    ROW_NUMBER() OVER (PARTITION BY source_config_id ORDER BY created_at, id)::integer AS hold_epoch
  FROM source_legal_holds
)
UPDATE source_legal_holds AS hold
SET hold_epoch = ranked_holds.hold_epoch
FROM ranked_holds
WHERE hold.id = ranked_holds.id;--> statement-breakpoint
UPDATE source_configs AS source
SET legal_hold_epoch = hold_counts.total
FROM (
  SELECT source_config_id, COUNT(*)::integer AS total
  FROM source_legal_holds
  GROUP BY source_config_id
) AS hold_counts
WHERE source.id = hold_counts.source_config_id;--> statement-breakpoint
ALTER TABLE "source_legal_holds" ADD CONSTRAINT "source_legal_holds_epoch_check"
  CHECK ("hold_epoch" > 0);--> statement-breakpoint
ALTER TABLE "source_legal_holds" ALTER COLUMN "hold_epoch" DROP DEFAULT;
