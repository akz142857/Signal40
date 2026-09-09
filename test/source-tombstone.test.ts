import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { normalizeArticles } from '../lib/domain.ts';
import {
  materializeIngestionPayload,
  type StagedIngestionPayload,
} from '../lib/source-ingestion-materialization.ts';
import {
  normalizedUpsertToArticle,
  parseNormalizedSourceItems,
  type NormalizedSourceItem,
  type NormalizedSourceUpsert,
} from '../lib/source-normalized-item.ts';
import { loadRecentArticles } from '../lib/persistence.ts';
import { createMemoryPg } from './pg-memory.ts';

const observedAt = new Date('2026-09-09T15:00:00.000Z');

function upsert(eventAt: string, title = 'Original'): NormalizedSourceUpsert {
  return {
    kind: 'upsert',
    namespace: 'http_json',
    platformItemId: 'item-1',
    title,
    url: 'https://example.com/item-1',
    publishedAt: '2026-09-09T09:00:00.000Z',
    updatedAt: eventAt,
    provenance: { connectorId: 'http-json-v2', connectorVersion: '2', observedAt: eventAt },
    identityStrategy: 'platform_id',
    identityConfidence: 'high',
    canonicalUrlVersion: 'url-v1',
    contentFingerprintVersion: 'content-v1',
  };
}

function tombstone(platformItemId: string, deletedAt: string): NormalizedSourceItem {
  return {
    kind: 'tombstone',
    namespace: 'http_json',
    platformItemId,
    deletedAt,
    provenance: { connectorId: 'http-json-v2', connectorVersion: '2', observedAt: deletedAt },
    identityStrategy: 'platform_id',
    identityConfidence: 'high',
  };
}

function payload(items: NormalizedSourceItem[]): StagedIngestionPayload {
  return {
    items,
    articles: normalizeArticles(items.flatMap((item) => item.kind === 'upsert'
      ? [normalizedUpsertToArticle(item, { name: 'Source', sourceType: 'media' })]
      : [])),
    origins: [],
    rejections: [],
    skippedCount: 0,
  };
}

async function materialize(db: Awaited<ReturnType<typeof createMemoryPg>>, runId: string, items: NormalizedSourceItem[]) {
  return db.transaction((tx) => materializeIngestionPayload(tx, {
    sourceConfigId: 'source-1',
    ingestionRunId: runId,
    platform: 'http_json',
    publisherEntityId: 'publisher-1',
    payload: payload(items),
    observedAt,
  }));
}

void test('normalized source item parser rejects tombstones that smuggle article content', () => {
  const candidate = { ...tombstone('item-1', '2026-09-09T12:00:00.000Z'), title: 'fabricated' };
  const result = parseNormalizedSourceItems([candidate]);
  assert.equal(result.items.length, 0);
  assert.match(result.issues[0]?.issue ?? '', /不接受正文/);
});

void test('tombstone state is idempotent, blocks stale replay, and only newer upsert restores', async () => {
  const db = await createMemoryPg();
  const first = await materialize(db, 'run-upsert', [upsert('2026-09-09T10:00:00.000Z')]);
  assert.equal(first.changedCount, 1);
  assert.equal((await loadRecentArticles(db, new Date('2026-09-09T00:00:00.000Z'))).length, 1);

  const unknown = await materialize(db, 'run-unknown-delete', [tombstone('unknown-item', '2026-09-09T11:00:00.000Z')]);
  assert.equal(unknown.changedCount, 0);
  const unknownOrigins = (await db.client.query("SELECT COUNT(*) AS total FROM source_item_origins WHERE platform_item_id = 'unknown-item'")).rows[0] as { total: number };
  const unknownStates = (await db.client.query("SELECT COUNT(*) AS total FROM source_item_event_states WHERE platform_item_id = 'unknown-item' AND latest_kind = 'tombstone'")).rows[0] as { total: number };
  assert.equal(Number(unknownOrigins.total), 0);
  assert.equal(Number(unknownStates.total), 1);

  const deleted = await materialize(db, 'run-delete', [tombstone('item-1', '2026-09-09T12:00:00.000Z')]);
  assert.equal(deleted.changedCount, 1);
  assert.equal((await loadRecentArticles(db, new Date('2026-09-09T00:00:00.000Z'))).length, 0);

  const replay = await materialize(db, 'run-delete-replay', [tombstone('item-1', '2026-09-09T12:00:00.000Z')]);
  assert.equal(replay.changedCount, 0);
  assert.equal(replay.duplicateCount, 1);

  const stale = await materialize(db, 'run-stale-upsert', [upsert('2026-09-09T11:30:00.000Z', 'Stale')]);
  assert.equal(stale.changedCount, 0);
  assert.equal((await loadRecentArticles(db, new Date('2026-09-09T00:00:00.000Z'))).length, 0);

  const equal = await materialize(db, 'run-equal-upsert', [upsert('2026-09-09T12:00:00.000Z', 'Equal')]);
  assert.equal(equal.changedCount, 0);
  assert.equal((await loadRecentArticles(db, new Date('2026-09-09T00:00:00.000Z'))).length, 0);

  const restored = await materialize(db, 'run-new-upsert', [upsert('2026-09-09T13:00:00.000Z', 'Restored')]);
  assert.equal(restored.changedCount, 1);
  const visible = await loadRecentArticles(db, new Date('2026-09-09T00:00:00.000Z'));
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.title, 'Restored');
  const origin = (await db.client.query("SELECT deleted_at FROM source_item_origins WHERE platform_item_id = 'item-1'")).rows[0] as { deleted_at: string | null };
  assert.equal(origin.deleted_at, null);
});

void test('run and page completion enqueue recomputation only for a materialized change', async () => {
  const commitRoute = await readFile(new URL('../app/api/v1/ingestion-runs/[id]/commit/route.ts', import.meta.url), 'utf8');
  const completeRoute = await readFile(new URL('../app/api/v1/ingestion-runs/[id]/complete/route.ts', import.meta.url), 'utf8');
  assert.match(commitRoute, /materialized\?\.changedCount \?\? acceptedCount/);
  assert.match(completeRoute, /changedCount \+= materialized\.changedCount/);
  assert.match(completeRoute, /if \(changedCount > 0\) await tx\.prepare/);
});
