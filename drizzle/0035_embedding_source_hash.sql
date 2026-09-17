-- 向量新鲜度凭据独立于 content_hash。
--
-- content_hash 是 shortHash(url|title)，不含摘要；而嵌入输入是标题 + 摘要。
-- 用 content_hash 当「这个向量还代表当前文本吗」的凭据，会漏掉「同 URL 同标题、
-- 只改写摘要」这类改动——向量永远不会被判为过期，也永远不会被重算。
ALTER TABLE "articles" ADD COLUMN IF NOT EXISTS "embedding_source_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- 已有向量都是按旧口径算的，没有对应的来源哈希；清空让调度器按新口径重算。
UPDATE "articles" SET "embedding_json" = '', "embedding_model" = '', "embedding_version" = 0, "embedded_at" = ''
  WHERE "embedding_json" <> '' AND "embedding_source_hash" = '';--> statement-breakpoint
-- 0034 建的索引对「哪些文章还没算向量」那条查询用不上：前导列上是 <> 且位于 OR 中，
-- 规划器走不了。改成按来源哈希为空这个可用等值前缀。
DROP INDEX IF EXISTS "idx_articles_embedding_model_published_at";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_articles_embedding_source_hash_published_at" ON "articles" ("embedding_source_hash","published_at");--> statement-breakpoint
-- 口径版本换代后，按旧口径算出来的选题质量与打分都不能直接沿用。
-- 清空 quality_json 让编排引擎重算；scoring_version 归零让重算路径覆盖它们。
UPDATE "topics" SET "quality_json" = '{}' WHERE "quality_json" <> '{}';
