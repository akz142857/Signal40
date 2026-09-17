import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryPg } from './pg-memory.ts';
import { deleteUningestedSource, sourceHardDeleteBlock } from '../lib/source-lifecycle.ts';
import { SOURCE_ACTION_ROLES } from '../lib/source-authorization.ts';

const actor = { id: 'ziy', role: 'admin' as const, email: 'ziy@local.test' };
const now = new Date('2026-09-14T12:00:00.000Z');

async function insertSource(db: Awaited<ReturnType<typeof createMemoryPg>>, id: string, enabled = 0) {
  await db.prepare(`
    INSERT INTO source_configs
      (id, name, adapter, platform, source_type, config_json, config_hash, rights_status,
       lifecycle_status, enabled, rate_limit_per_minute, version, created_at, updated_at)
    VALUES (?, ?, 'rss', 'rss', 'media', '{}', 'sha256:x', 'pending', 'tested', ?, 30, 1, ?, ?)
  `).bind(id, `来源 ${id}`, enabled, now.toISOString(), now.toISOString()).run();
}

void test('删除来源是管理员动作，并且与依法删除分开授权', () => {
  assert.deepEqual(SOURCE_ACTION_ROLES['source.delete'], ['admin']);
  assert.notEqual(SOURCE_ACTION_ROLES['source.delete'], SOURCE_ACTION_ROLES['source.legal-delete']);
});

void test('没有任何采集内容的来源可以直接删掉，附属行一起清干净', async () => {
  const db = await createMemoryPg();
  try {
    await insertSource(db, 'source_1');
    await db.prepare(`
      INSERT INTO source_connection_tests
        (id, source_config_id, job_id, config_hash, status, preview_json, capabilities_json,
         created_by, expires_at, created_at)
      VALUES ('test_1', 'source_1', 'job_1', 'sha256:x', 'succeeded', '[]', '{}', 'ziy', ?, ?)
    `).bind(now.toISOString(), now.toISOString()).run();
    await db.prepare(`
      INSERT INTO source_rights_requests
        (id, source_config_id, requested_by, status, assertion_ref, source_version,
         rights_config_hash, request_idempotency_key, created_at, updated_at)
      VALUES ('rights_1', 'source_1', 'ziy', 'pending', 'provisional:sha256:x', 1, 'sha256:x', 'k1', ?, ?)
    `).bind(now.toISOString(), now.toISOString()).run();

    assert.equal(await sourceHardDeleteBlock(db, 'source_1'), null);
    const result = await deleteUningestedSource(db, {
      sourceId: 'source_1',
      expectedVersion: 1,
      reason: '粘错网址',
      actor,
    }, now);
    assert.equal(result.status, 200);

    const remaining = await db.prepare('SELECT COUNT(*) AS total FROM source_configs WHERE id = ?')
      .bind('source_1').first<{ total: number | string }>();
    assert.equal(Number(remaining?.total), 0);
    for (const table of ['source_connection_tests', 'source_rights_requests']) {
      const row = await db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE source_config_id = ?`)
        .bind('source_1').first<{ total: number | string }>();
      assert.equal(Number(row?.total), 0, table);
    }
    // 配置行没了，谁删的、为什么删仍然查得到。
    const audit = await db.prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'source.deleted' AND entity_id = ?")
      .bind('source_1').first<{ total: number | string }>();
    assert.equal(Number(audit?.total), 1);
  } finally {
    await db.client.close();
  }
});

void test('有过采集运行的来源不能硬删，必须走归档或依法删除', async () => {
  const db = await createMemoryPg();
  try {
    await insertSource(db, 'source_2');
    await db.prepare(`
      INSERT INTO ingestion_runs
        (id, source_config_id, status, trigger, required_capability, connector_id, connector_version,
         payload_schema_version, source_version, checkpoint_scope, created_at)
      VALUES ('run_1', 'source_2', 'succeeded', 'manual', 'source:rss', 'rss', 1, 1, 1, 'default', ?)
    `).bind(now.toISOString()).run();

    const block = await sourceHardDeleteBlock(db, 'source_2');
    assert.ok(block);
    assert.match(block.reason, /采集运行记录/);
    const result = await deleteUningestedSource(db, {
      sourceId: 'source_2', expectedVersion: 1, reason: '想删', actor,
    }, now);
    assert.equal(result.status, 409);
    const remaining = await db.prepare('SELECT COUNT(*) AS total FROM source_configs WHERE id = ?')
      .bind('source_2').first<{ total: number | string }>();
    assert.equal(Number(remaining?.total), 1);
  } finally {
    await db.client.close();
  }
});

void test('未解除的法律保全会挡住删除', async () => {
  const db = await createMemoryPg();
  try {
    await insertSource(db, 'source_3');
    await db.prepare(`
      INSERT INTO source_legal_holds
        (id, source_config_id, hold_epoch, status, reason, authority_ref, created_by, created_at)
      VALUES ('hold_1', 'source_3', 1, 'active', '诉讼保全', 'CASE-1', 'legal', ?)
    `).bind(now.toISOString()).run();
    const block = await sourceHardDeleteBlock(db, 'source_3');
    assert.match(block!.reason, /法律保全/);
  } finally {
    await db.client.close();
  }
});

void test('启用中的来源要先停用；版本不对时拒绝', async () => {
  const db = await createMemoryPg();
  try {
    await insertSource(db, 'source_4', 1);
    const enabled = await deleteUningestedSource(db, {
      sourceId: 'source_4', expectedVersion: 1, reason: '删', actor,
    }, now);
    assert.equal(enabled.status, 409);
    assert.match(enabled.status === 409 ? enabled.error : '', /先停用/);

    await insertSource(db, 'source_5');
    const stale = await deleteUningestedSource(db, {
      sourceId: 'source_5', expectedVersion: 7, reason: '删', actor,
    }, now);
    assert.equal(stale.status, 409);
    assert.match(stale.status === 409 ? stale.error : '', /版本冲突/);
  } finally {
    await db.client.close();
  }
});

void test('来源不存在时返回 404', async () => {
  const db = await createMemoryPg();
  try {
    const result = await deleteUningestedSource(db, {
      sourceId: 'source_missing', expectedVersion: 1, reason: '删', actor,
    }, now);
    assert.equal(result.status, 404);
  } finally {
    await db.client.close();
  }
});
