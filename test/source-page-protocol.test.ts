import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pageReplayDecision,
  validateCompletionManifest,
  validateNextCommittedPage,
  type CommittedPageManifestRow,
} from '../lib/source-page-protocol.ts';
import { createMemoryPg } from './pg-memory.ts';

function page(
  ordinal: number,
  overrides: Partial<CommittedPageManifestRow> = {},
): CommittedPageManifestRow {
  return {
    page_key: `page-${ordinal}`,
    page_ordinal: ordinal,
    content_hash: `sha256:${String(ordinal).padStart(64, '0')}`,
    lease_epoch: ordinal + 1,
    final_page: ordinal === 1 ? 1 : 0,
    status: 'committed',
    checkpoint_after_json: { cursor: `cursor-${ordinal}` },
    fetched_count: 2,
    accepted_count: 1,
    rejected_count: 1,
    duplicate_count: 0,
    request_count: 1,
    byte_count: 100,
    ...overrides,
  };
}

void test('page key 只允许同内容且同 lease epoch 重放', () => {
  assert.equal(pageReplayDecision(null, { contentHash: 'sha256:a', leaseEpoch: 1 }), 'accept');
  assert.equal(pageReplayDecision(
    { contentHash: 'sha256:a', leaseEpoch: 1 },
    { contentHash: 'sha256:a', leaseEpoch: 1 },
  ), 'replay');
  assert.equal(pageReplayDecision(
    { contentHash: 'sha256:a', leaseEpoch: 1 },
    { contentHash: 'sha256:b', leaseEpoch: 1 },
  ), 'conflict');
  assert.equal(pageReplayDecision(
    { contentHash: 'sha256:a', leaseEpoch: 1 },
    { contentHash: 'sha256:a', leaseEpoch: 2 },
  ), 'conflict');
});

void test('下一页必须连续、前置 checkpoint 一致且 final 后不可追加', () => {
  assert.equal(validateNextCommittedPage({
    previous: null,
    proposedOrdinal: 0,
    currentCheckpointJson: { cursor: null, watermark: 'a' },
    checkpointBeforeJson: { watermark: 'a', cursor: null },
  }), null);
  assert.match(validateNextCommittedPage({
    previous: { pageOrdinal: 0, finalPage: false },
    proposedOrdinal: 2,
    currentCheckpointJson: {},
    checkpointBeforeJson: {},
  }) ?? '', /期待 1/);
  assert.match(validateNextCommittedPage({
    previous: { pageOrdinal: 0, finalPage: false },
    proposedOrdinal: 1,
    currentCheckpointJson: { cursor: 'server' },
    checkpointBeforeJson: { cursor: 'worker' },
  }) ?? '', /checkpointBeforeJson/);
  assert.match(validateNextCommittedPage({
    previous: { pageOrdinal: 0, finalPage: true },
    proposedOrdinal: 1,
    currentCheckpointJson: {},
    checkpointBeforeJson: {},
  }) ?? '', /final page/);
});

void test('完成 manifest 接受跨重试 lease epoch，但拒绝断页、错误 final 与伪造累计数', () => {
  const pages = [page(0), page(1)];
  const expected = {
    pageCount: 2,
    lastPageKey: 'page-1',
    totals: {
      fetchedCount: 4,
      acceptedCount: 2,
      rejectedCount: 2,
      duplicateCount: 0,
      requestCount: 2,
      byteCount: 200,
    },
  };
  const valid = validateCompletionManifest(pages, expected);
  assert.equal('error' in valid, false);
  assert.match((validateCompletionManifest([page(0), page(2)], expected) as { error: string }).error, /ordinal 1/);
  assert.match((validateCompletionManifest([page(0), page(1, { final_page: 0 })], expected) as { error: string }).error, /final/);
  assert.match((validateCompletionManifest(pages, {
    ...expected,
    totals: { ...expected.totals, acceptedCount: 3 },
  }) as { error: string }).error, /acceptedCount/);
});

void test('数据库同时约束 run/pageKey 和 run/pageOrdinal 唯一', async () => {
  const db = await createMemoryPg();
  const now = new Date('2026-09-09T04:00:00.000Z').toISOString();
  await db.client.query(`
    INSERT INTO ingestion_pages
      (id, ingestion_run_id, page_key, page_ordinal, content_hash, lease_epoch,
       final_page, status, created_at)
    VALUES ('page-a', 'run-a', 'key-a', 0, 'sha256:a', 1, 0, 'committed', $1)
  `, [now]);
  await assert.rejects(db.client.query(`
    INSERT INTO ingestion_pages
      (id, ingestion_run_id, page_key, page_ordinal, content_hash, lease_epoch,
       final_page, status, created_at)
    VALUES ('page-b', 'run-a', 'key-a', 1, 'sha256:b', 1, 1, 'committed', $1)
  `, [now]));
  await assert.rejects(db.client.query(`
    INSERT INTO ingestion_pages
      (id, ingestion_run_id, page_key, page_ordinal, content_hash, lease_epoch,
       final_page, status, created_at)
    VALUES ('page-c', 'run-a', 'key-c', 0, 'sha256:c', 1, 1, 'committed', $1)
  `, [now]));
});
