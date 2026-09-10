import type { SqlDatabase } from '../lib/sql.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueIngestionRun, enqueueJob, finishJob, leaseNextJob, renewJobLease, transitionContentProject } from '../lib/control-plane.ts';
import type { ContentState } from '../lib/workflow.ts';
import { WorkflowError } from '../lib/workflow.ts';
import { createMemoryPg } from './pg-memory.ts';

const actor = { id: 'producer-1', email: 'producer@signal40.test', role: 'producer' as const };
const baseTime = new Date('2026-09-08T02:00:00.000Z');

function at(offsetSeconds: number) {
  return new Date(baseTime.valueOf() + offsetSeconds * 1000);
}

type MemoryPg = Awaited<ReturnType<typeof createMemoryPg>>;

async function seedProject(db: MemoryPg, id: string, state: ContentState) {
  const now = baseTime.toISOString();
  await db.client.query(
    "INSERT INTO topics (id, title, keywords_json, score, heat_change, score_breakdown_json, source_count, status, gate_json, updated_at) VALUES ('topic_test', '测试话题', '[]', 10, 0, '{}', 2, 'ready', '{}', $1) ON CONFLICT DO NOTHING",
    [now],
  );
  await db.client.query(
    'INSERT INTO content_projects (id, topic_id, title, state, version, owner_id, brand, locale, project_json, immutable_hash, created_at, updated_at) VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, $9, $10, $11)',
    [id, 'topic_test', '测试项目', state, actor.id, 'Signal 40', 'zh-CN', '{}', 'sha256:seed', now, now],
  );
}

async function jobRow(db: MemoryPg, id: string) {
  const result = await db.client.query('SELECT status, attempt, lease_owner, lease_expires_at, last_error FROM jobs WHERE id = $1', [id]);
  return result.rows[0] as {
    status: string;
    attempt: number;
    lease_owner: string | null;
    lease_expires_at: string | null;
    last_error: string | null;
  };
}

async function projectState(db: MemoryPg, id: string) {
  const result = await db.client.query('SELECT state FROM content_projects WHERE id = $1', [id]);
  return (result.rows[0] as { state: string }).state;
}

void test('同一幂等键的重复入队返回第一次的作业', async () => {
  const db = await createMemoryPg();
  const first = await enqueueJob(db, { kind: 'metrics', payload: { a: 1 }, idempotencyKey: 'key-1', actor }, baseTime);
  const second = await enqueueJob(db, { kind: 'metrics', payload: { a: 1 }, idempotencyKey: 'key-1', actor }, at(1));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  const counted = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE idempotency_key = 'key-1'");
  assert.equal(Number((counted.rows[0] as { total: number }).total), 1);
});

void test('补采作业使用独立 checkpoint scope，不携带 live 水位', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, config_hash, rights_status, enabled, lifecycle_status, version, checkpoint,
       checkpoint_json, backfill_checkpoint_json, created_at, updated_at)
    VALUES ('source-backfill', 'Backfill', 'rss', '{}', 'hash-backfill', 'approved', 1, 'enabled', 2,
      '2026-09-08T00:00:00Z', '{"watermark":"live"}', '{"cursor":"older"}', $1, $1)
  `, [baseTime.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ('rights-backfill', 'source-backfill', 'admin', 'rss',
      '["title","summary","url","publishedAt","author"]',
      'finance-editorial-ingestion', 'normalized-metadata', 'confirmation', 'v1',
      'admin', $1, $1, 2, 'hash-backfill', $1)
  `, [baseTime.toISOString()]);
  const job = await enqueueIngestionRun(db, {
    sourceConfigId: 'source-backfill', idempotencyKey: 'backfill-1', actor,
    runTrigger: 'backfill', checkpointJson: { mode: 'backfill', cursor: 'page-2' },
  }, baseTime);
  const run = await db.client.query('SELECT checkpoint_before, checkpoint_before_json, checkpoint_scope, trigger, rights_grant_id FROM ingestion_runs WHERE id = $1', [job.ingestionRunId]);
  assert.deepEqual(run.rows[0], {
    checkpoint_before: null,
    checkpoint_before_json: { mode: 'backfill', cursor: 'page-2' },
    checkpoint_scope: 'backfill',
    trigger: 'backfill',
    rights_grant_id: 'rights-backfill',
  });
  const queued = await db.client.query('SELECT payload_json FROM jobs WHERE id = $1', [job.id]);
  const queuedPayload = (queued.rows[0] as { payload_json: { checkpointScope: string; rightsGrantId: string } }).payload_json;
  assert.equal(queuedPayload.checkpointScope, 'backfill');
  assert.equal(queuedPayload.rightsGrantId, 'rights-backfill');
});

void test('采集 429 尊重 Retry-After，并投影结构化限流状态', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, platform, config_json, rights_status, enabled,
       lifecycle_status, health_status, config_hash, version, created_at, updated_at)
    VALUES ('source-rate-limit', 'Rate limited API', 'http', 'http_json',
      '{"sourceType":"media","url":"https://api.example.com/news"}',
      'approved', 1, 'enabled', 'healthy', 'hash-rate-limit', 1, $1, $1)
  `, [baseTime.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ('rights-rate-limit', 'source-rate-limit', 'admin', 'http_json',
      '["title","summary","url","publishedAt","author"]',
      'finance-editorial-ingestion', 'normalized-metadata', 'confirmation', 'v1',
      'admin', $1, $1, 1, 'hash-rate-limit', $1)
  `, [baseTime.toISOString()]);
  const job = await enqueueIngestionRun(db, {
    sourceConfigId: 'source-rate-limit', idempotencyKey: 'rate-limit-1', actor,
  }, baseTime);
  const leased = await leaseNextJob(db, {
    workerId: 'source-worker', kinds: ['ingestion'], capabilities: ['source:http-json'], capabilityProtocolVersions: { 'source:http-json': 2 }, maxPayloadSchemaVersion: 2, leaseSeconds: 300,
  }, at(1));
  assert.equal((leased as unknown as { id: string }).id, job.id);

  const result = await finishJob(db, {
    id: job.id,
    workerId: 'source-worker',
    leaseEpoch: Number((leased as unknown as { lease_epoch: number }).lease_epoch),
    succeeded: false,
    error: '来源请求受限：HTTP 429，120 秒后重试。',
    errorCode: 'RATE_LIMITED',
    retryDelaySeconds: 120,
  }, at(2));
  assert.equal((result as { status: string }).status, 'retrying');

  const source = await db.client.query('SELECT health_status, last_error_code, retry_after, backoff_until FROM source_configs WHERE id = $1', ['source-rate-limit']);
  assert.deepEqual(source.rows[0], {
    health_status: 'degraded',
    last_error_code: 'RATE_LIMITED',
    retry_after: at(122).toISOString(),
    backoff_until: at(122).toISOString(),
  });
  const run = await db.client.query('SELECT status, error_code, retryable, retry_after, error_json FROM ingestion_runs WHERE id = $1', [job.ingestionRunId]);
  const runRow = run.rows[0] as { status: string; error_code: string; retryable: number; retry_after: string; error_json: string };
  assert.equal(runRow.status, 'queued');
  assert.equal(runRow.error_code, 'RATE_LIMITED');
  assert.equal(runRow.retryable, 1);
  assert.equal(runRow.retry_after, at(122).toISOString());
  assert.equal((JSON.parse(runRow.error_json) as { code: string }).code, 'RATE_LIMITED');
});

void test('采集入队拒绝缺失或与当前配置不匹配的授权', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, config_hash, rights_status, enabled,
       lifecycle_status, created_at, updated_at)
    VALUES ('source-stale-rights', 'Stale rights', 'rss', '{}', 'config-current',
      'approved', 1, 'enabled', $1, $1)
  `, [baseTime.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ('rights-stale', 'source-stale-rights', 'admin', 'rss',
      '["title","url","publishedAt"]', 'finance-editorial-ingestion',
      'normalized-metadata', 'confirmation', 'v1', 'admin', $1, $1, 1,
      'config-old', $1)
  `, [baseTime.toISOString()]);
  await assert.rejects(
    enqueueIngestionRun(db, {
      sourceConfigId: 'source-stale-rights', idempotencyKey: 'stale-rights', actor,
    }, baseTime),
    /没有当前有效的财经编辑采集授权/,
  );
  assert.equal(Number(((await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE idempotency_key = 'stale-rights'")).rows[0] as { total: number }).total), 0);
});

void test('采集租约在授权被撤销后 fail closed', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, config_hash, rights_status, enabled,
       lifecycle_status, created_at, updated_at)
    VALUES ('source-lease-rights', 'Lease rights', 'rss', '{}', 'config-lease',
      'approved', 1, 'enabled', $1, $1)
  `, [baseTime.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ('rights-lease', 'source-lease-rights', 'admin', 'rss',
      '["title","url","publishedAt"]', 'finance-editorial-ingestion',
      'normalized-metadata', 'confirmation', 'v1', 'admin', $1, $1, 1,
      'config-lease', $1)
  `, [baseTime.toISOString()]);
  const job = await enqueueIngestionRun(db, {
    sourceConfigId: 'source-lease-rights', idempotencyKey: 'lease-rights', actor,
  }, baseTime);
  await db.client.query("UPDATE source_rights_grants SET revoked_at = $1 WHERE id = 'rights-lease'", [at(1).toISOString()]);
  assert.equal(await leaseNextJob(db, {
    workerId: 'source-worker', kinds: ['ingestion'], capabilities: ['source:rss'], maxPayloadSchemaVersion: 2,
  }, at(2)), null);
  assert.equal(((await db.client.query('SELECT status FROM jobs WHERE id = $1', [job.id])).rows[0] as { status: string }).status, 'queued');
});

void test('同键并发入队由唯一索引裁决，落败方回读既有作业而不是报错', async () => {
  const db = await createMemoryPg();
  // 另一个请求已经用同一个幂等键抢先入队。
  await db.client.query(
    "INSERT INTO jobs (id, kind, payload_json, status, idempotency_key, available_at, created_at, updated_at) VALUES ('job_winner', 'metrics', '{\"a\":1}', 'queued', 'key-race', $1, $1, $1)",
    [baseTime.toISOString()],
  );

  const result = await enqueueJob(db, { kind: 'metrics', payload: { a: 1 }, idempotencyKey: 'key-race', actor }, baseTime);
  assert.deepEqual(result, { id: 'job_winner', status: 'queued', created: false });

  const counted = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE idempotency_key = 'key-race'");
  assert.equal(Number((counted.rows[0] as { total: number }).total), 1, '不该产生第二条作业');
});

void test('同一作业幂等键不能复用于不同 payload', async () => {
  const db = await createMemoryPg();
  await enqueueJob(db, { kind: 'metrics', payload: { a: 1 }, idempotencyKey: 'key-conflict', actor }, baseTime);
  await assert.rejects(
    enqueueJob(db, { kind: 'metrics', payload: { a: 2 }, idempotencyKey: 'key-conflict', actor }, at(1)),
    /IDEMPOTENCY_CONFLICT/,
  );
});

void test('渲染作业按项目状态领取，租约未过期时不会被第二个 Worker 重复领取', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'ASSETS_READY');
  const job = await enqueueJob(db, { kind: 'render', projectId: 'project_1', payload: {}, idempotencyKey: 'render-1', actor }, baseTime);
  assert.equal(await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'] }, at(1)), null);

  await db.client.query("UPDATE content_projects SET state = 'RENDER_QUEUED' WHERE id = 'project_1'");
  const leased = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(2));
  assert.equal((leased as unknown as { id: string }).id, job.id);
  assert.equal(await projectState(db, 'project_1'), 'RENDERING');
  assert.equal((await jobRow(db, job.id)).attempt, 1);

  assert.equal(await leaseNextJob(db, { workerId: 'worker-b', kinds: ['render'] }, at(3)), null);
  // 租约到期后依然领不走：项目已经是 RENDERING，渲染作业的状态守卫要求 RENDER_QUEUED。
  assert.equal(await leaseNextJob(db, { workerId: 'worker-b', kinds: ['render'], leaseSeconds: 300 }, at(400)), null);
  assert.equal((await jobRow(db, job.id)).lease_owner, 'worker-a');
});

void test('租约过期的作业会被另一个 Worker 重新领取并累加 attempt', async () => {
  const db = await createMemoryPg();
  const job = await enqueueJob(db, { kind: 'metrics', payload: {}, idempotencyKey: 'metrics-1', actor }, baseTime);
  const first = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['metrics'], leaseSeconds: 300 }, at(1));
  assert.equal(Number((first as unknown as { lease_epoch: number }).lease_epoch), 1);
  assert.equal(await leaseNextJob(db, { workerId: 'worker-b', kinds: ['metrics'], leaseSeconds: 300 }, at(2)), null);

  const stolen = await leaseNextJob(db, { workerId: 'worker-b', kinds: ['metrics'], leaseSeconds: 300 }, at(400));
  assert.equal((stolen as unknown as { id: string }).id, job.id);
  assert.equal(Number((stolen as unknown as { lease_epoch: number }).lease_epoch), 2);
  assert.equal((await jobRow(db, job.id)).lease_owner, 'worker-b');
  assert.equal((await jobRow(db, job.id)).attempt, 2);
});

void test('采集 Worker 在 run 进入 running 后崩溃，过期租约可由新 Worker 以新 epoch 接管', async () => {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, platform, source_type, config_json, config_hash,
       rights_status, enabled, lifecycle_status, health_status, version,
       checkpoint_json, created_at, updated_at)
    VALUES ('source-ingestion-takeover', 'Takeover source', 'http', 'http_json', 'media',
      '{"sourceType":"media","url":"https://api.example.com/feed"}', 'hash-takeover',
      'approved', 1, 'enabled', 'healthy', 1, '{"cursor":"0"}', $1, $1)
  `, [baseTime.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ('rights-ingestion-takeover', 'source-ingestion-takeover', 'admin', 'http_json',
      '["title","url","publishedAt"]', 'finance-editorial-ingestion',
      'normalized-metadata', 'confirmation', 'v1', 'admin', $1, $1, 1,
      'hash-takeover', $1)
  `, [baseTime.toISOString()]);
  const job = await enqueueIngestionRun(db, {
    sourceConfigId: 'source-ingestion-takeover',
    idempotencyKey: 'ingestion-takeover',
    actor,
  }, baseTime);

  const first = await leaseNextJob(db, {
    workerId: 'source-worker-a',
    kinds: ['ingestion'],
    capabilities: ['source:http-json'],
    capabilityProtocolVersions: { 'source:http-json': 2 },
    maxPayloadSchemaVersion: 2,
    leaseSeconds: 30,
  }, at(1));
  assert.equal((first as unknown as { id: string }).id, job.id);
  assert.equal(((await db.client.query('SELECT status FROM ingestion_runs WHERE id = $1', [job.ingestionRunId])).rows[0] as { status: string }).status, 'running');

  const second = await leaseNextJob(db, {
    workerId: 'source-worker-b',
    kinds: ['ingestion'],
    capabilities: ['source:http-json'],
    capabilityProtocolVersions: { 'source:http-json': 2 },
    maxPayloadSchemaVersion: 2,
    leaseSeconds: 300,
  }, at(40));
  assert.equal((second as unknown as { id: string }).id, job.id);
  assert.equal(Number((second as unknown as { lease_epoch: number }).lease_epoch), 2);

  const staleFinish = await finishJob(db, {
    id: job.id,
    workerId: 'source-worker-a',
    leaseEpoch: 1,
    succeeded: true,
  }, at(41));
  assert.equal('error' in staleFinish, true);
  assert.equal(((await db.client.query('SELECT status FROM ingestion_runs WHERE id = $1', [job.ingestionRunId])).rows[0] as { status: string }).status, 'running');
});

void test('能力名相同但协议版本过旧的 Worker 不能领取新版作业', async () => {
  const db = await createMemoryPg();
  const job = await enqueueJob(
    db,
    {
      kind: 'metrics',
      payload: {},
      idempotencyKey: 'capability-protocol-v2',
      requiredCapability: 'source:http-json',
      requiredCapabilityProtocolVersion: 2,
      actor,
    },
    baseTime,
  );
  await db.client.query(
    "UPDATE jobs SET minimum_worker_version = 'never-match-this-product-version' WHERE id = $1",
    [job.id],
  );

  const legacy = await leaseNextJob(
    db,
    {
      workerId: 'legacy-worker',
      kinds: ['metrics'],
      capabilities: ['source:http-json'],
      capabilityProtocolVersions: { 'source:http-json': 1 },
    },
    at(1),
  );
  assert.equal(legacy, null);

  const compatible = await leaseNextJob(
    db,
    {
      workerId: 'page-worker',
      kinds: ['metrics'],
      capabilities: ['source:http-json'],
      capabilityProtocolVersions: { 'source:http-json': 2 },
    },
    at(2),
  );
  assert.equal((compatible as unknown as { id: string }).id, job.id);
});

void test('同名 Worker 重新领取后，旧 leaseEpoch 不能续约或完成新租约', async () => {
  const db = await createMemoryPg();
  const job = await enqueueJob(db, { kind: 'metrics', payload: {}, idempotencyKey: 'metrics-epoch', actor }, baseTime);
  const first = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['metrics'], leaseSeconds: 30 }, at(1));
  const firstEpoch = Number((first as unknown as { lease_epoch: number }).lease_epoch);
  const second = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['metrics'], leaseSeconds: 300 }, at(40));
  const secondEpoch = Number((second as unknown as { lease_epoch: number }).lease_epoch);
  assert.equal(secondEpoch, firstEpoch + 1);

  const staleHeartbeat = await renewJobLease(db, {
    id: job.id,
    workerId: 'worker-a',
    leaseEpoch: firstEpoch,
    leaseSeconds: 300,
  }, at(41));
  assert.equal('error' in staleHeartbeat, true);
  const staleFinish = await finishJob(db, {
    id: job.id,
    workerId: 'worker-a',
    leaseEpoch: firstEpoch,
    succeeded: true,
  }, at(42));
  assert.equal('error' in staleFinish, true);

  const currentFinish = await finishJob(db, {
    id: job.id,
    workerId: 'worker-a',
    leaseEpoch: secondEpoch,
    succeeded: true,
  }, at(43));
  assert.equal((currentFinish as { status: string }).status, 'succeeded');
});

void test('逐页运行已经终结但响应丢失时，失败回报不会倒写运行与来源健康', async () => {
  const db = await createMemoryPg();
  const timestamp = at(1).toISOString();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, config_hash, rights_status, enabled,
       lifecycle_status, health_status, active_run_id, created_at, updated_at)
    VALUES ('source-page-replay', 'Page replay', 'http', '{}', 'hash-page',
      'approved', 1, 'enabled', 'healthy', NULL, $1, $1)
  `, [timestamp]);
  await db.client.query(`
    INSERT INTO jobs
      (id, kind, payload_json, status, idempotency_key, attempt, lease_owner,
       lease_epoch, lease_expires_at, available_at, created_at, updated_at)
    VALUES ('job-page-replay', 'ingestion',
      '{"ingestionRunId":"run-page-replay","sourceConfigId":"source-page-replay"}',
      'leased', 'page-replay', 1, 'source-worker', 3, $1, $2, $2, $2)
  `, [at(300).toISOString(), timestamp]);
  await db.client.query(`
    INSERT INTO ingestion_runs
      (id, source_config_id, job_id, status, result_json, created_at, finished_at)
    VALUES ('run-page-replay', 'source-page-replay', 'job-page-replay',
      'succeeded', '{"protocol":"page-v1-complete"}', $1, $1)
  `, [timestamp]);

  const reported = await finishJob(db, {
    id: 'job-page-replay',
    workerId: 'source-worker',
    leaseEpoch: 3,
    succeeded: false,
    error: 'complete response lost',
  }, at(2));
  assert.equal((reported as { status: string }).status, 'retrying');
  assert.equal(((await db.client.query("SELECT status FROM ingestion_runs WHERE id = 'run-page-replay'")).rows[0] as { status: string }).status, 'succeeded');
  assert.deepEqual((await db.client.query("SELECT health_status, last_error_code FROM source_configs WHERE id = 'source-page-replay'")).rows[0], {
    health_status: 'healthy',
    last_error_code: null,
  });
});

void test('续约把租约推后，过期时刻的第二个 Worker 领不走作业', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'RENDER_QUEUED');
  const job = await enqueueJob(db, { kind: 'render', projectId: 'project_1', payload: {}, idempotencyKey: 'render-1', actor }, baseTime);
  const leased = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(1));
  const leaseEpoch = Number((leased as unknown as { lease_epoch: number }).lease_epoch);

  const renewed = await renewJobLease(db, { id: job.id, workerId: 'worker-a', leaseEpoch, leaseSeconds: 300 }, at(200));
  assert.equal('error' in renewed, false);
  assert.equal(await leaseNextJob(db, { workerId: 'worker-b', kinds: ['render'], leaseSeconds: 300 }, at(400)), null);

  const wrongOwner = await renewJobLease(db, { id: job.id, workerId: 'worker-b', leaseEpoch, leaseSeconds: 300 }, at(210));
  assert.equal('error' in wrongOwner, true);
});

void test('租约不属于该 Worker 时 finishJob 返回 409，成功完成把项目推进到 QC_PENDING', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'RENDER_QUEUED');
  const job = await enqueueJob(db, { kind: 'render', projectId: 'project_1', payload: {}, idempotencyKey: 'render-1', actor }, baseTime);
  const leased = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(1));
  const leaseEpoch = Number((leased as unknown as { lease_epoch: number }).lease_epoch);

  const foreign = await finishJob(db, { id: job.id, workerId: 'worker-b', leaseEpoch, succeeded: true }, at(2));
  assert.deepEqual('status' in foreign ? foreign.status : null, 409);

  const finished = await finishJob(db, { id: job.id, workerId: 'worker-a', leaseEpoch, succeeded: true, result: { durationMs: 1200 } }, at(3));
  assert.equal((finished as { status: string }).status, 'succeeded');
  assert.equal(await projectState(db, 'project_1'), 'QC_PENDING');

  const replayed = await finishJob(db, { id: job.id, workerId: 'worker-a', leaseEpoch, succeeded: true }, at(4));
  assert.deepEqual('status' in replayed ? replayed.status : null, 409);
});

void test('普通失败进入重试，terminal 失败直接进死信并把项目标记为 FAILED', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'RENDER_QUEUED');
  const job = await enqueueJob(db, { kind: 'render', projectId: 'project_1', payload: {}, idempotencyKey: 'render-1', actor }, baseTime);

  const firstLease = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(1));
  const retried = await finishJob(db, { id: job.id, workerId: 'worker-a', leaseEpoch: Number((firstLease as unknown as { lease_epoch: number }).lease_epoch), succeeded: false, error: 'ffmpeg 崩溃' }, at(2));
  assert.equal((retried as { status: string }).status, 'retrying');
  assert.equal(await projectState(db, 'project_1'), 'RENDER_QUEUED');

  const secondLease = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(600));
  const terminal = await finishJob(db, { id: job.id, workerId: 'worker-a', leaseEpoch: Number((secondLease as unknown as { lease_epoch: number }).lease_epoch), succeeded: false, error: '自动 QC 未通过：duration', terminal: true }, at(601));
  assert.equal((terminal as { status: string }).status, 'dead_letter');
  assert.equal(await projectState(db, 'project_1'), 'FAILED');
  assert.equal((await jobRow(db, job.id)).attempt, 2, 'terminal 失败不应该等到 max_attempts 才停');
});

void test('payload_json 是 jsonb，非法 JSON 在写入层就被拒绝', async () => {
  const db = await createMemoryPg();
  const job = await enqueueJob(db, { kind: 'metrics', payload: {}, idempotencyKey: 'broken', actor }, baseTime);
  await assert.rejects(
    () => db.client.query("UPDATE jobs SET payload_json = '{不是 JSON' WHERE id = $1", [job.id]),
    '非法 JSON 不该能写进 jsonb 列——这正是把它从 text 改成 jsonb 的理由',
  );
});

void test('payload 不是对象时作业被隔离到死信队列，租约接口继续可用', async () => {
  const db = await createMemoryPg();
  const broken = await enqueueJob(db, { kind: 'metrics', payload: {}, idempotencyKey: 'broken', actor }, baseTime);
  const healthy = await enqueueJob(db, { kind: 'metrics', payload: { ok: true }, idempotencyKey: 'healthy', actor }, at(1));
  // jsonb 挡得住语法错误，但挡不住合法的 JSON 标量——payload 必须是对象。
  await db.client.query("UPDATE jobs SET payload_json = 'null'::jsonb WHERE id = $1", [broken.id]);

  assert.equal(await leaseNextJob(db, { workerId: 'worker-a', kinds: ['metrics'] }, at(2)), null);
  assert.equal((await jobRow(db, broken.id)).status, 'dead_letter');

  const next = await leaseNextJob(db, { workerId: 'worker-a', kinds: ['metrics'], leaseSeconds: 300 }, at(3));
  assert.equal((next as unknown as { id: string }).id, healthy.id);
});

void test('过期版本的状态转换以 VERSION_CONFLICT 失败', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'DRAFT');
  const moved = await transitionContentProject(db, { projectId: 'project_1', expectedVersion: 1, to: 'RESEARCHING', gates: [], note: '开始研究', actor }, at(1));
  assert.equal('project' in moved ? moved.project?.version : 0, 2);

  const stale = await transitionContentProject(db, { projectId: 'project_1', expectedVersion: 1, to: 'RESEARCHING', gates: [], note: '重复提交', actor }, at(2));
  assert.equal('status' in stale ? stale.status : null, 409);

  const bumpVersion = () => db.client.query("UPDATE content_projects SET version = version + 1 WHERE id = 'project_1'");
  // 模拟读取版本之后、写入之前被其他人改掉：更新匹配不到行。
  const conflicting = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: unknown[]) => {
      await bumpVersion();
      return db.batch(statements as never);
    },
    transaction: (run: (tx: unknown) => Promise<unknown>) => db.transaction(async (tx) => {
      await bumpVersion();
      return run(tx);
    }),
  } as unknown as SqlDatabase;
  await assert.rejects(
    () => transitionContentProject(conflicting, { projectId: 'project_1', expectedVersion: 2, to: 'CHANGES_REQUESTED', gates: [], note: '并发写入', actor: { ...actor, role: 'editor' } }, at(3)),
    (error: unknown) => error instanceof WorkflowError && error.code === 'VERSION_CONFLICT',
  );
});

void test('外层项目事务中的内层失败使用 savepoint，不会污染后续写入', async () => {
  const db = await createMemoryPg();
  const timestamp = baseTime.toISOString();
  await db.transaction(async (tx) => {
    await tx.prepare("INSERT INTO team_members (user_id, email, role, status, created_at, updated_at) VALUES ('nested-a', 'a@test', 'admin', 'active', ?, ?)").bind(timestamp, timestamp).run();
    await assert.rejects(() => tx.batch([
      tx.prepare("INSERT INTO team_members (user_id, email, role, status, created_at, updated_at) VALUES ('nested-a', 'duplicate@test', 'admin', 'active', ?, ?)").bind(timestamp, timestamp),
    ]));
    await tx.prepare("INSERT INTO team_members (user_id, email, role, status, created_at, updated_at) VALUES ('nested-b', 'b@test', 'admin', 'active', ?, ?)").bind(timestamp, timestamp).run();
  });
  const rows = await db.client.query("SELECT user_id FROM team_members WHERE user_id LIKE 'nested-%' ORDER BY user_id");
  assert.deepEqual(rows.rows.map((row) => (row as { user_id: string }).user_id), ['nested-a', 'nested-b']);
});
