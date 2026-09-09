import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  materializeIngestionPayload,
  parseStagedIngestionPayload,
  type StagedIngestionPayload,
} from '../lib/source-ingestion-materialization.ts';
import { loadRecentArticles } from '../lib/persistence.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T11:00:00.000Z');

function payload(title: string, contentHash: string): StagedIngestionPayload {
  return {
    articles: [{
      id: 'article-staged',
      source: 'Staged source',
      sourceType: 'media',
      author: 'Author',
      title,
      summary: 'Summary',
      url: 'https://example.com/staged',
      publishedAt: '2026-09-09T10:00:00.000Z',
      metrics: {},
      contentHash,
    }],
    origins: [{ namespace: 'rss', platformItemId: 'item-1', url: 'https://example.com/staged' }],
    rejections: [],
    skippedCount: 0,
  };
}

void test('page payload stays invisible and cannot mutate a visible article before completion', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO articles
      (id, source, source_type, author, title, summary, url, published_at, metrics_json, content_hash, created_at)
    VALUES ('article-visible', 'Old source', 'media', '', 'Old title', '',
      'https://example.com/staged', '2026-09-09T09:00:00.000Z', '{}', 'old-hash', $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_item_origins
      (id, source_config_id, namespace, platform_item_id, article_id, ingestion_run_id,
       canonical_url_hash, fingerprint_version, content_fingerprint, evidence_family_id,
       publisher_entity_id, first_seen_at, last_seen_at)
    VALUES ('origin-visible', 'source-old', 'rss', 'old-item', 'article-visible', 'run-old',
      'url-hash', 'content-v1', 'old-hash', 'family-old', 'publisher-old', $1, $1)
  `, [now.toISOString()]);
  const staged = payload('New title', 'new-hash');
  await db.client.query(`
    INSERT INTO ingestion_pages
      (id, ingestion_run_id, page_key, page_ordinal, content_hash, lease_epoch,
       final_page, status, staged_payload_json, created_at)
    VALUES ('page-staged', 'run-staged', 'page-0', 0, 'sha256:staged', 1,
      1, 'committed', $1, $2)
  `, [JSON.stringify(staged), now.toISOString()]);

  const before = await db.client.query("SELECT title, content_hash FROM articles WHERE id = 'article-visible'");
  assert.deepEqual(before.rows[0], { title: 'Old title', content_hash: 'old-hash' });
  assert.equal((await loadRecentArticles(db, new Date('2026-09-09T00:00:00.000Z')))[0]?.title, 'Old title');
  const stagedOrigins = (await db.client.query("SELECT COUNT(*) AS total FROM source_item_origins WHERE ingestion_run_id = 'run-staged'")).rows[0] as { total: number };
  assert.equal(Number(stagedOrigins.total), 0);

  const row = (await db.client.query("SELECT staged_payload_json FROM ingestion_pages WHERE id = 'page-staged'")).rows[0] as { staged_payload_json: unknown };
  const parsed = parseStagedIngestionPayload(row.staged_payload_json);
  assert.ok(parsed);
  await db.transaction((tx) => materializeIngestionPayload(tx, {
    sourceConfigId: 'source-staged',
    ingestionRunId: 'run-staged',
    platform: 'rss',
    publisherEntityId: 'publisher-staged',
    payload: parsed,
    observedAt: now,
  }));

  const after = await db.client.query("SELECT title, content_hash FROM articles WHERE id = 'article-visible'");
  assert.deepEqual(after.rows[0], { title: 'New title', content_hash: 'new-hash' });
  const visibleOrigins = (await db.client.query("SELECT COUNT(*) AS total FROM source_item_origins WHERE ingestion_run_id = 'run-staged'")).rows[0] as { total: number };
  assert.equal(Number(visibleOrigins.total), 1);
});

void test('page route stages payload while completion owns publication, checkpoint promotion, and recompute', async () => {
  const commitRoute = await readFile(new URL('../app/api/v1/ingestion-runs/[id]/commit/route.ts', import.meta.url), 'utf8');
  const completeRoute = await readFile(new URL('../app/api/v1/ingestion-runs/[id]/complete/route.ts', import.meta.url), 'utf8');
  assert.match(commitRoute, /staged_payload_json/);
  assert.match(commitRoute, /materialized = pageMode\s*\? null/);
  assert.doesNotMatch(commitRoute, /sourcePageCheckpointUpdate/);
  assert.match(completeRoute, /parseStagedIngestionPayload/);
  assert.match(completeRoute, /stableHash\(run\.checkpoint_after_json/);
  assert.match(completeRoute, /stableHash\(run\.checkpoint_before_json/);
  assert.match(completeRoute, /checkpoint_version = checkpoint_version \+ 1/);
  assert.match(completeRoute, /ON CONFLICT \(kind, idempotency_key\) DO NOTHING/);
});
