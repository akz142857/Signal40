ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "scoring_version" integer DEFAULT 1 NOT NULL;
