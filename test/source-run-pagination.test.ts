import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeSourceRunCursor,
  encodeSourceRunCursor,
  getSourceRun,
  listSourceRunPage,
  sourceRunPageLimit,
} from '../lib/source-run-pagination.ts';
import { createMemoryPg } from './pg-memory.ts';

void test('source run cursor round-trips a stable created_at/id boundary', () => {
  const cursor = {
    createdAt: '2026-09-09T01:02:03.000Z',
    id: 'ingestion_same_timestamp_b',
  };
  const encoded = encodeSourceRunCursor(cursor);
  assert.deepEqual(decodeSourceRunCursor(encoded), { cursor });
  assert.equal(encoded.includes(cursor.id), false, 'cursor 应保持不透明');
});

void test('source run pagination rejects malformed cursors and unsafe limits', () => {
  assert.deepEqual(decodeSourceRunCursor(null), { cursor: null });
  assert.equal('error' in decodeSourceRunCursor('not-json'), true);
  assert.equal(
    'error' in
      decodeSourceRunCursor(
        Buffer.from(JSON.stringify({ createdAt: 'bad', id: 'x' })).toString(
          'base64url',
        ),
      ),
    true,
  );
  assert.deepEqual(sourceRunPageLimit(null), { limit: 50 });
  assert.deepEqual(sourceRunPageLimit('100'), { limit: 100 });
  assert.equal('error' in sourceRunPageLimit('0'), true);
  assert.equal('error' in sourceRunPageLimit('101'), true);
  assert.equal('error' in sourceRunPageLimit('2.5'), true);
});

void test('source run pages do not skip or duplicate equal-timestamp rows', async () => {
  const db = await createMemoryPg();
  for (const [id, createdAt] of [
    ['run_c', '2026-09-09T02:00:00.000Z'],
    ['run_b', '2026-09-09T02:00:00.000Z'],
    ['run_a', '2026-09-09T01:00:00.000Z'],
  ]) {
    await db.client.query(
      `INSERT INTO ingestion_runs (id, source_config_id, status, created_at)
       VALUES ($1, 'source-page', 'succeeded', $2)`,
      [id, createdAt],
    );
  }

  const first = await listSourceRunPage(db, {
    sourceConfigId: 'source-page',
    limit: 1,
    cursor: null,
  });
  assert.deepEqual(first.runs.map((run) => run.id), ['run_c']);
  assert.ok(first.nextCursor);
  const decoded = decodeSourceRunCursor(first.nextCursor);
  assert.equal('error' in decoded, false);
  if ('error' in decoded) return;

  const second = await listSourceRunPage(db, {
    sourceConfigId: 'source-page',
    limit: 2,
    cursor: decoded.cursor,
  });
  assert.deepEqual(second.runs.map((run) => run.id), ['run_b', 'run_a']);
  assert.equal(second.nextCursor, null);
});

void test('source run detail is browser-safe and cannot cross source boundaries', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO ingestion_runs
      (id, source_config_id, status, trigger, accepted_count, rejected_count,
       duplicate_count, error_code, error_json, created_at)
    VALUES ('run-detail', 'source-detail', 'failed', 'manual', 2, 1, 3,
      'NETWORK', '{"secret":"must-not-leak"}', '2026-09-09T02:00:00.000Z')
  `);
  assert.deepEqual(await getSourceRun(db, {
    sourceConfigId: 'source-detail', runId: 'run-detail',
  }), {
    id: 'run-detail',
    status: 'failed',
    quarantineStatus: 'none',
    trigger: 'manual',
    acceptedCount: 2,
    rejectedCount: 1,
    duplicateCount: 3,
    createdAt: '2026-09-09T02:00:00.000Z',
    finishedAt: null,
    errorCode: 'NETWORK',
    errorMessage: '来源网络暂时不可用。',
  });
  assert.equal(await getSourceRun(db, {
    sourceConfigId: 'another-source', runId: 'run-detail',
  }), null);
});
