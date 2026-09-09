import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ingestionRightsBlockReason,
  expireDueSourceRights,
  quarantineRightsBlockedIngestion,
  type IngestionRightsSnapshot,
} from '../lib/source-rights.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T01:00:00.000Z');
const base: IngestionRightsSnapshot = {
  sourceEnabled: 1,
  sourceLifecycleStatus: 'enabled',
  sourceRightsStatus: 'approved',
  sourceRetentionMode: 'metadata',
  sourceConfigHash: 'config-v1',
  runSourceVersion: 4,
  runRightsGrantId: 'grant-v2',
  grantId: 'grant-v2',
  grantRevokedAt: null,
  grantExpiresAt: '2026-09-10T01:00:00.000Z',
  grantPurpose: 'finance-editorial-ingestion',
  grantUsageScope: 'normalized-metadata',
  grantPermittedFields: ['title', 'summary', 'url', 'publishedAt', 'author'],
  grantSourceVersion: 3,
  grantConfigHash: 'config-v1',
};

function reason(overrides: Partial<IngestionRightsSnapshot> = {}, hasRawPayload = false) {
  return ingestionRightsBlockReason({ ...base, ...overrides }, {
    now,
    requiredFields: ['title', 'url', 'publishedAt', 'summary'],
    hasRawPayload,
  });
}

void test('提交时有效且与配置绑定的授权可以接纳规范化结果', () => {
  assert.equal(reason(), null);
});

void test('提交时撤销、过期、停用或配置漂移均 fail closed', () => {
  assert.match(reason({ grantRevokedAt: now.toISOString() }) ?? '', /撤销或过期/);
  assert.match(reason({ grantExpiresAt: now.toISOString() }) ?? '', /撤销或过期/);
  assert.match(reason({ sourceEnabled: 0, sourceLifecycleStatus: 'paused' }) ?? '', /停用/);
  assert.match(reason({ grantConfigHash: 'stale-config' }) ?? '', /当前来源配置不匹配/);
  assert.match(reason({ grantSourceVersion: 5 }) ?? '', /授权版本/);
});

void test('字段和 raw 保留范围都由授权与来源策略共同限制', () => {
  assert.match(reason({ grantPermittedFields: ['title', 'url', 'publishedAt'] }) ?? '', /未允许的字段/);
  assert.match(reason({}, true) ?? '', /保留策略/);
  assert.equal(reason({
    sourceRetentionMode: 'raw',
    grantUsageScope: 'normalized-and-authorized-raw',
  }, true), null);
});

void test('提交失权会原子隔离 run、停用来源并把未提交 raw 放入删除队列', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, rights_status, enabled, lifecycle_status,
       health_status, active_run_id, created_at, updated_at)
    VALUES ('source-rights', 'Rights source', 'rss', '{}', 'approved', 1,
      'enabled', 'healthy', 'run-rights', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO ingestion_runs
      (id, source_config_id, status, rights_grant_id, created_at)
    VALUES ('run-rights', 'source-rights', 'running', 'grant-rights', $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO raw_payload_uploads
      (id, team_id, source_config_id, ingestion_run_id, state, object_key,
       sha256, byte_size, created_at, updated_at, expires_at, delete_after)
    VALUES ('raw-rights', 'default', 'source-rights', 'run-rights', 'uploaded',
      'sources/source-rights/raw/run-rights/payload.bin', 'sha', 10, $1, $1, $2, $2)
  `, [now.toISOString(), new Date(now.valueOf() + 3_600_000).toISOString()]);

  await db.transaction((tx) => quarantineRightsBlockedIngestion(tx, {
    sourceConfigId: 'source-rights',
    ingestionRunId: 'run-rights',
    rightsGrantId: 'grant-rights',
    reason: '授权已撤销。',
  }, now));

  const run = await db.client.query("SELECT status, quarantine_status, error_code, finished_at FROM ingestion_runs WHERE id = 'run-rights'");
  assert.deepEqual(run.rows[0], {
    status: 'rights_blocked', quarantine_status: 'held', error_code: 'RIGHTS_BLOCKED', finished_at: now.toISOString(),
  });
  const source = await db.client.query("SELECT enabled, lifecycle_status, health_status, active_run_id FROM source_configs WHERE id = 'source-rights'");
  assert.deepEqual(source.rows[0], { enabled: 0, lifecycle_status: 'paused', health_status: 'paused', active_run_id: null });
  const raw = await db.client.query("SELECT state, expires_at, delete_after FROM raw_payload_uploads WHERE id = 'raw-rights'");
  assert.deepEqual(raw.rows[0], { state: 'expired', expires_at: now.toISOString(), delete_after: now.toISOString() });
  const attention = await db.client.query("SELECT kind, dedupe_key FROM attention_items WHERE dedupe_key = 'source_rights:source-rights'");
  assert.deepEqual(attention.rows[0], { kind: 'source_rights', dedupe_key: 'source_rights:source-rights' });
});

void test('调度 tick 会投影到期授权并取消尚未领取的采集', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, config_hash, rights_status, enabled,
       lifecycle_status, health_status, active_run_id, created_at, updated_at)
    VALUES ('source-expired', 'Expired source', 'rss', '{}', 'config-expired',
      'approved', 1, 'enabled', 'healthy', 'run-expired', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       expires_at, source_version, config_hash, created_at)
    VALUES ('grant-expired', 'source-expired', 'admin', 'rss',
      '["title","url","publishedAt"]', 'finance-editorial-ingestion',
      'normalized-metadata', 'confirmation', 'v1', 'admin', $1, $1, $2, 1,
      'config-expired', $1)
  `, [new Date(now.valueOf() - 86_400_000).toISOString(), new Date(now.valueOf() - 1_000).toISOString()]);
  await db.client.query(`
    INSERT INTO jobs
      (id, kind, payload_json, status, idempotency_key, available_at, created_at, updated_at)
    VALUES ('job-expired', 'ingestion', '{"sourceConfigId":"source-expired","ingestionRunId":"run-expired"}',
      'queued', 'expired-rights', $1, $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO ingestion_runs
      (id, source_config_id, job_id, status, rights_grant_id, created_at)
    VALUES ('run-expired', 'source-expired', 'job-expired', 'queued', 'grant-expired', $1)
  `, [now.toISOString()]);

  assert.deepEqual(await expireDueSourceRights(db, { id: 'automation-admin', role: 'admin' }, now), [
    { sourceConfigId: 'source-expired', grantId: 'grant-expired', cancelledRuns: 1 },
  ]);
  const source = await db.client.query("SELECT enabled, lifecycle_status, rights_status, active_run_id FROM source_configs WHERE id = 'source-expired'");
  assert.deepEqual(source.rows[0], { enabled: 0, lifecycle_status: 'paused', rights_status: 'expired', active_run_id: null });
  assert.equal(((await db.client.query("SELECT status FROM jobs WHERE id = 'job-expired'")).rows[0] as { status: string }).status, 'cancelled');
  assert.equal(((await db.client.query("SELECT status FROM ingestion_runs WHERE id = 'run-expired'")).rows[0] as { status: string }).status, 'cancelled');
  assert.equal(Number(((await db.client.query("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'source.rights_expired'")).rows[0] as { total: number }).total), 1);
  assert.deepEqual(await expireDueSourceRights(db, { id: 'automation-admin', role: 'admin' }, now), []);
});
