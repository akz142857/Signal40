import assert from 'node:assert/strict';
import test from 'node:test';
import { decideCheckpointCutover, requestCheckpointCutover } from '../lib/source-checkpoint-cutover.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T02:30:00.000Z');
const requester = { id: 'admin-requester', email: 'requester@signal40.test', role: 'admin' as const };
const approver = { id: 'admin-approver', email: 'approver@signal40.test', role: 'admin' as const };

async function seedSource() {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, rights_status, version, checkpoint,
       checkpoint_json, checkpoint_version, created_at, updated_at)
    VALUES ('source-cutover', 'Cutover source', 'rss', '{}', 'approved', 3,
      '2026-09-08T00:00:00.000Z', '{"schemaVersion":1,"watermark":"2026-09-08T00:00:00.000Z"}',
      4, $1, $1)
  `, [now.toISOString()]);
  return db;
}

void test('checkpoint cutover 保存旧快照并要求第二位管理员批准', async () => {
  const db = await seedSource();
  const requested = await requestCheckpointCutover(db, {
    sourceConfigId: 'source-cutover', scope: 'live', expectedSourceVersion: 3,
    checkpointAfter: { schemaVersion: 1, watermark: '2026-09-07T00:00:00.000Z' },
    reason: '供应商确认需从前一天重新采集', idempotencyKey: 'cutover-request-1', actor: requester,
  }, now);
  assert.equal('error' in requested, false);
  if ('error' in requested) return;
  assert.equal(requested.cutoverStatus, 'pending');
  const replay = await requestCheckpointCutover(db, {
    sourceConfigId: 'source-cutover', scope: 'live', expectedSourceVersion: 3,
    checkpointAfter: { ignored: true }, reason: 'HTTP replay',
    idempotencyKey: 'cutover-request-1', actor: requester,
  }, now);
  assert.equal('error' in replay, false);
  if ('error' in replay) return;
  assert.equal(replay.replayed, true);
  assert.deepEqual(await decideCheckpointCutover(db, {
    sourceConfigId: 'source-cutover', cutoverId: requested.cutoverId,
    decision: 'approve', note: 'self approval', actor: requester,
  }, new Date(now.valueOf() + 1_000)), {
    status: 409, error: '申请人不能批准或拒绝自己的 checkpoint cutover。',
  });
  const applied = await decideCheckpointCutover(db, {
    sourceConfigId: 'source-cutover', cutoverId: requested.cutoverId,
    decision: 'approve', note: '核对供应商事件记录，同意回退', actor: approver,
  }, new Date(now.valueOf() + 2_000));
  assert.deepEqual(applied, {
    status: 200, cutoverId: requested.cutoverId, cutoverStatus: 'applied', checkpointVersion: 5, sourceVersion: 4,
  });
  const source = await db.client.query("SELECT version, checkpoint, checkpoint_json, checkpoint_version FROM source_configs WHERE id = 'source-cutover'");
  assert.deepEqual(source.rows[0], {
    version: 4,
    checkpoint: '2026-09-07T00:00:00.000Z',
    checkpoint_json: { schemaVersion: 1, watermark: '2026-09-07T00:00:00.000Z' },
    checkpoint_version: 5,
  });
  const stored = await db.client.query('SELECT status, checkpoint_version_before, checkpoint_before_json, approved_by FROM source_checkpoint_cutovers WHERE id = $1', [requested.cutoverId]);
  assert.deepEqual(stored.rows[0], {
    status: 'applied', checkpoint_version_before: 4,
    checkpoint_before_json: { schemaVersion: 1, watermark: '2026-09-08T00:00:00.000Z' },
    approved_by: approver.id,
  });
});

void test('checkpoint 在审批前推进时 cutover fail closed', async () => {
  const db = await seedSource();
  const requested = await requestCheckpointCutover(db, {
    sourceConfigId: 'source-cutover', scope: 'live', expectedSourceVersion: 3,
    checkpointAfter: { watermark: '2026-09-07T00:00:00.000Z' },
    reason: '测试并发保护', idempotencyKey: 'cutover-race', actor: requester,
  }, now);
  if ('error' in requested) assert.fail(requested.error);
  await db.client.query("UPDATE source_configs SET checkpoint_version = 5 WHERE id = 'source-cutover'");
  const result = await decideCheckpointCutover(db, {
    sourceConfigId: 'source-cutover', cutoverId: requested.cutoverId,
    decision: 'approve', note: '审批', actor: approver,
  }, new Date(now.valueOf() + 1_000));
  assert.deepEqual(result, { status: 409, error: 'checkpoint 在申请后已推进，请重新创建 cutover。' });
});
