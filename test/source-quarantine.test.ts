import assert from 'node:assert/strict';
import test from 'node:test';
import { changeIngestionQuarantine } from '../lib/source-quarantine.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T02:20:00.000Z');
const actor = { id: 'admin-quarantine', email: 'admin@signal40.test', role: 'admin' as const };

async function seedRun() {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, config_hash, rights_status, created_at, updated_at)
    VALUES ('source-quarantine', 'Quarantine source', 'rss', '{}', 'hash-quarantine',
      'approved', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, purpose, usage_scope, evidence_ref,
       terms_version, verified_by, granted_at, verified_at, source_version,
       config_hash, created_at)
    VALUES ('rights-quarantine', 'source-quarantine', 'admin', 'rss',
      'finance-editorial-ingestion', 'normalized-metadata', 'confirmation', 'v1',
      'admin', $1, $1, 1, 'hash-quarantine', $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO ingestion_runs (id, source_config_id, status, quarantine_status, created_at)
    VALUES ('run-quarantine', 'source-quarantine', 'succeeded', 'none', $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_item_origins
      (id, source_config_id, namespace, platform_item_id, article_id,
       ingestion_run_id, canonical_url_hash, fingerprint_version,
       content_fingerprint, first_seen_at, last_seen_at)
    VALUES ('origin-quarantine', 'source-quarantine', 'rss', 'item-1', 'article-1',
      'run-quarantine', 'url-hash', 'v1', 'content-hash', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO raw_payload_uploads
      (id, team_id, source_config_id, ingestion_run_id, state, object_key, sha256,
       byte_size, created_at, updated_at, expires_at, committed_at, delete_after)
    VALUES ('raw-quarantine', 'default', 'source-quarantine', 'run-quarantine',
      'committed', 'raw.bin', 'sha', 10, $1, $1, $2, $1, $2)
  `, [now.toISOString(), new Date(now.valueOf() + 86_400_000).toISOString()]);
  return db;
}

void test('已提交 ingestion batch 可挂起、释放并幂等触发主题重算', async () => {
  const db = await seedRun();
  const held = await changeIngestionQuarantine(db, {
    ingestionRunId: 'run-quarantine', action: 'hold', note: '发现来源映射异常',
    idempotencyKey: 'quarantine-hold', actor,
  }, now);
  assert.equal('error' in held, false);
  assert.equal(((await db.client.query("SELECT quarantine_status FROM ingestion_runs WHERE id = 'run-quarantine'")).rows[0] as { quarantine_status: string }).quarantine_status, 'held');
  assert.equal(((await db.client.query("SELECT deleted_at FROM source_item_origins WHERE id = 'origin-quarantine'")).rows[0] as { deleted_at: string }).deleted_at, now.toISOString());

  const released = await changeIngestionQuarantine(db, {
    ingestionRunId: 'run-quarantine', action: 'release', note: '复核后确认可恢复',
    idempotencyKey: 'quarantine-release', actor,
  }, new Date(now.valueOf() + 1_000));
  assert.equal('error' in released, false);
  assert.equal(((await db.client.query("SELECT quarantine_status FROM ingestion_runs WHERE id = 'run-quarantine'")).rows[0] as { quarantine_status: string }).quarantine_status, 'released');
  assert.equal(((await db.client.query("SELECT deleted_at FROM source_item_origins WHERE id = 'origin-quarantine'")).rows[0] as { deleted_at: string | null }).deleted_at, null);
  const replay = await changeIngestionQuarantine(db, {
    ingestionRunId: 'run-quarantine', action: 'release', note: 'HTTP 重放',
    idempotencyKey: 'quarantine-release', actor,
  }, new Date(now.valueOf() + 2_000));
  assert.equal('error' in replay, false);
  if ('error' in replay) return;
  assert.equal(replay.replayed, true);
  assert.equal(Number(((await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE required_capability = 'source:pipeline'")).rows[0] as { total: number }).total), 2);
});

void test('discard tombstone 不可逆并把 raw 立即放入删除队列', async () => {
  const db = await seedRun();
  const discarded = await changeIngestionQuarantine(db, {
    ingestionRunId: 'run-quarantine', action: 'discard', note: '确认该批次不可使用',
    idempotencyKey: 'quarantine-discard', actor,
  }, now);
  assert.equal('error' in discarded, false);
  assert.equal(((await db.client.query("SELECT state FROM raw_payload_uploads WHERE id = 'raw-quarantine'")).rows[0] as { state: string }).state, 'expired');
  const release = await changeIngestionQuarantine(db, {
    ingestionRunId: 'run-quarantine', action: 'release', note: '不允许恢复',
    idempotencyKey: 'quarantine-release-after-discard', actor,
  }, new Date(now.valueOf() + 1_000));
  assert.deepEqual(release, { status: 409, error: '已丢弃的采集批次不能恢复或重新挂起。' });
});
