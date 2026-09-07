import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const articles = sqliteTable('articles', {
  id: text('id').primaryKey(), source: text('source').notNull(),
  sourceType: text('source_type', { enum: ['social', 'media', 'market', 'filing', 'company'] }).notNull(),
  author: text('author').notNull().default(''), title: text('title').notNull(),
  summary: text('summary').notNull().default(''), url: text('url').notNull(),
  publishedAt: text('published_at').notNull(), metricsJson: text('metrics_json').notNull().default('{}'),
  contentHash: text('content_hash').notNull(), createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_articles_content_hash').on(table.contentHash),
  index('idx_articles_published_at').on(table.publishedAt),
  index('idx_articles_source_type_published_at').on(table.sourceType, table.publishedAt),
]);

export const topics = sqliteTable('topics', {
  id: text('id').primaryKey(), title: text('title').notNull(), keywordsJson: text('keywords_json').notNull().default('[]'),
  score: integer('score').notNull(), heatChange: integer('heat_change').notNull().default(0),
  scoreBreakdownJson: text('score_breakdown_json').notNull(), sourceCount: integer('source_count').notNull(),
  status: text('status', { enum: ['ready', 'needs_primary_source', 'needs_corroboration'] }).notNull(),
  gateJson: text('gate_json').notNull(), updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_topics_score_updated_at').on(table.score, table.updatedAt),
  index('idx_topics_status_score').on(table.status, table.score),
]);

export const topicArticles = sqliteTable('topic_articles', {
  topicId: text('topic_id').notNull().references(() => topics.id, { onDelete: 'cascade' }),
  articleId: text('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
}, (table) => [uniqueIndex('idx_topic_articles_pair').on(table.topicId, table.articleId), index('idx_topic_articles_article').on(table.articleId)]);

export const verificationEvents = sqliteTable('verification_events', {
  id: text('id').primaryKey(), topicId: text('topic_id').notNull().references(() => topics.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['unreviewed', 'verified', 'rejected'] }).notNull(),
  note: text('note').notNull().default(''), createdAt: text('created_at').notNull(),
}, (table) => [index('idx_verification_topic_created').on(table.topicId, table.createdAt)]);
