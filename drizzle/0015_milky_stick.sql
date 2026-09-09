ALTER TABLE "attention_items" ADD COLUMN "source_config_id" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "owner_team_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "business_owner_id" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "credential_steward_id" text;--> statement-breakpoint
ALTER TABLE "source_configs" ADD COLUMN "backup_admin_id" text;--> statement-breakpoint
UPDATE "source_configs" SET "owner_team_id" = "team_id";--> statement-breakpoint
UPDATE "source_configs" source SET "business_owner_id" = COALESCE(
	(SELECT audit."actor_id" FROM "audit_events" audit
	 JOIN "team_members" member ON member."user_id" = audit."actor_id"
	 WHERE audit."entity_type" = 'source_config' AND audit."entity_id" = source."id"
	   AND audit."action" = 'source.created' AND member."status" = 'active'
	   AND member."role" <> 'auditor' ORDER BY audit."created_at" ASC LIMIT 1),
	(SELECT member."user_id" FROM "team_members" member
	 WHERE member."status" = 'active' AND member."role" <> 'auditor'
	 ORDER BY CASE WHEN member."role" = 'admin' THEN 0 ELSE 1 END, member."user_id" LIMIT 1)
) WHERE source."business_owner_id" IS NULL;--> statement-breakpoint
UPDATE "source_configs" source SET "credential_steward_id" = COALESCE(
	(SELECT audit."actor_id" FROM "audit_events" audit
	 JOIN "team_members" member ON member."user_id" = audit."actor_id"
	 WHERE audit."entity_type" = 'source_config' AND audit."entity_id" = source."id"
	   AND audit."action" = 'source.created' AND member."status" = 'active'
	   AND member."role" = 'admin' ORDER BY audit."created_at" ASC LIMIT 1),
	(SELECT member."user_id" FROM "team_members" member
	 WHERE member."status" = 'active' AND member."role" = 'admin'
	 ORDER BY member."user_id" LIMIT 1)
) WHERE source."credential_steward_id" IS NULL;--> statement-breakpoint
UPDATE "source_configs" source SET "backup_admin_id" = (
	SELECT member."user_id" FROM "team_members" member
	WHERE member."status" = 'active' AND member."role" = 'admin'
	  AND member."user_id" <> source."credential_steward_id"
	ORDER BY member."user_id" LIMIT 1
) WHERE source."backup_admin_id" IS NULL;--> statement-breakpoint
UPDATE "attention_items" SET "source_config_id" = COALESCE(
	"detail_json"::jsonb ->> 'sourceConfigId',
	"detail_json"::jsonb ->> 'sourceId'
) WHERE "source_config_id" IS NULL AND "kind" IN
	('source_rights', 'source_connector', 'source_slo', 'source_budget');--> statement-breakpoint
CREATE INDEX "idx_attention_items_source" ON "attention_items" USING btree ("source_config_id","status");--> statement-breakpoint
CREATE INDEX "idx_source_configs_business_owner" ON "source_configs" USING btree ("business_owner_id");--> statement-breakpoint
CREATE INDEX "idx_source_configs_credential_steward" ON "source_configs" USING btree ("credential_steward_id");--> statement-breakpoint
CREATE INDEX "idx_source_configs_backup_admin" ON "source_configs" USING btree ("backup_admin_id");
