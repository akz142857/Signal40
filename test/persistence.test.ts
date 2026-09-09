import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from '../lib/domain.ts';
import {
  loadLatestTopics,
  loadRecentArticles,
  loadTopic,
  persistArticlesWithRevisions,
  persistPipeline,
  recordVerification,
} from '../lib/persistence.ts';
import { sampleArticles } from './fixtures/sample-articles.ts';
import { createMemoryPg } from './pg-memory.ts';

/**
 * `lib/persistence.ts` 的 SQL 是全仓库最复杂的：分片批量插入、`ON CONFLICT` 去重、
 * 以及一段带 `ROW_NUMBER()` 的派生表。这些在真 PG 上跑通才算数——
 * SQLite 允许派生表不写别名，PG 不允许，这类差异只有实跑才暴露。
 */

const now = new Date('2026-09-08T02:00:00.000Z');

void test('选题流水线在 PostgreSQL 上完整落库并读回', async () => {
  const db = await createMemoryPg();
  const articles = sampleArticles(now);
  const topics = runPipeline(articles, now);
  assert.ok(topics.length > 0, '样例数据应产出话题');

  const run = await persistPipeline(db, topics, 'sample', articles.length, now);
  assert.ok(run);

  const loaded = await loadLatestTopics(db);
  assert.equal(loaded.run?.mode, 'sample');
  assert.equal(loaded.topics.length, topics.length);
  assert.deepEqual(
    loaded.topics.map((topic) => topic.id).sort(),
    topics.map((topic) => topic.id).sort(),
  );
  assert.ok(loaded.topics.every((topic) => topic.articles.length > 0), '话题应带回关联文章');

  const single = await loadTopic(db, topics[0].id);
  assert.equal(single?.id, topics[0].id);
});

void test('重复跑同一批话题不会因为 topic_articles 主键冲突而失败', async () => {
  const db = await createMemoryPg();
  const articles = sampleArticles(now);
  const topics = runPipeline(articles, now);

  await persistPipeline(db, topics, 'sample', articles.length, now);
  await persistPipeline(db, topics, 'sample', articles.length, new Date(now.valueOf() + 60_000));

  const counted = await db.client.query('SELECT COUNT(*) AS total FROM topic_articles');
  const links = new Set(topics.flatMap((topic) => topic.articles.map((article) => `${topic.id}:${article.id}`)));
  assert.equal(Number((counted.rows[0] as { total: number }).total), links.size, 'ON CONFLICT DO NOTHING 应挡住重复关联');
});

void test('文章修订按内容哈希增量记录', async () => {
  const db = await createMemoryPg();
  const articles = sampleArticles(now);
  const topics = runPipeline(articles, now);
  const stored = topics.flatMap((topic) => topic.articles).slice(0, 3);

  await persistArticlesWithRevisions(db, stored, now);
  const first = await db.client.query('SELECT COUNT(*) AS total FROM article_revisions');
  assert.equal(Number((first.rows[0] as { total: number }).total), stored.length);

  // 同样的内容再写一遍不该产生新修订。
  await persistArticlesWithRevisions(db, stored, new Date(now.valueOf() + 1_000));
  const second = await db.client.query('SELECT COUNT(*) AS total FROM article_revisions');
  assert.equal(Number((second.rows[0] as { total: number }).total), stored.length);

  // 内容变了（标题连同 contentHash 一起变）则记一条新修订。
  await persistArticlesWithRevisions(
    db,
    [{ ...stored[0], title: `${stored[0].title}（更新）`, contentHash: `${stored[0].contentHash}v2` }],
    new Date(now.valueOf() + 2_000),
  );
  const third = await db.client.query('SELECT COUNT(*) AS total FROM article_revisions');
  assert.equal(Number((third.rows[0] as { total: number }).total), stored.length + 1);

  const recent = await loadRecentArticles(db, new Date(now.valueOf() - 86_400_000), 50);
  assert.ok(recent.length > 0);
});

void test('滚动语料注入 evidence family/所有权集团并排除已撤回的唯一 origin', async () => {
  const db = await createMemoryPg();
  const article = runPipeline(sampleArticles(now), now).flatMap((topic) => topic.articles)[0];
  await persistArticlesWithRevisions(db, [article], now);
  await db.client.query(`
    INSERT INTO publisher_entities
      (id, legal_name, ownership_group, entity_type, created_at, updated_at)
    VALUES ('publisher-test', 'Publisher Test', 'group-test', 'company', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_item_origins
      (id, source_config_id, namespace, platform_item_id, article_id,
       ingestion_run_id, canonical_url_hash, fingerprint_version,
       content_fingerprint, relationship, evidence_family_id,
       publisher_entity_id, confidence, first_seen_at, last_seen_at)
    VALUES ('origin-test', 'source-test', 'rss', 'item-test', $1, 'run-test',
      'url-hash', 'content-v1', $2, 'original', 'family-test',
      'publisher-test', 100, $3, $3)
  `, [article.id, article.contentHash, now.toISOString()]);
  const active = await loadRecentArticles(db, new Date(now.valueOf() - 3 * 86_400_000));
  assert.equal(active[0].evidenceFamilyId, 'family-test');
  assert.equal(active[0].publisherOwnershipGroup, 'group-test');

  await db.client.query("UPDATE source_item_origins SET deleted_at = $1 WHERE id = 'origin-test'", [now.toISOString()]);
  const withdrawn = await loadRecentArticles(db, new Date(now.valueOf() - 3 * 86_400_000));
  assert.equal(withdrawn.some((item) => item.id === article.id), false);
});

void test('取最新一条审核事件走 ROW_NUMBER 派生表，同秒写入靠 seq 定序', async () => {
  const db = await createMemoryPg();
  const articles = sampleArticles(now);
  const topics = runPipeline(articles, now);
  await persistPipeline(db, topics, 'sample', articles.length, now);

  const topicId = topics[0].id;
  // 两条事件刻意用同一个 created_at：PG 没有隐式 rowid，只能靠 seq 分出先后。
  await recordVerification(db, topicId, 'verified', '先通过', now);
  await recordVerification(db, topicId, 'rejected', '后驳回', now);

  const loaded = await loadTopic(db, topicId);
  assert.equal(loaded?.verificationStatus, 'rejected', '应取到 seq 更大的那条');
});
