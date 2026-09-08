import type { SqlDatabase } from '../lib/sql.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueJob, finishJob, leaseNextJob, renewJobLease, transitionContentProject } from '../lib/control-plane.ts';
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

void test('同键并发入队由唯一索引裁决，落败方回读既有作业而不是报错', async () => {
  const db = await createMemoryPg();
  // 另一个请求已经用同一个幂等键抢先入队。
  await db.client.query(
    "INSERT INTO jobs (id, kind, payload_json, status, idempotency_key, available_at, created_at, updated_at) VALUES ('job_winner', 'metrics', '{}', 'queued', 'key-race', $1, $1, $1)",
    [baseTime.toISOString()],
  );

  const result = await enqueueJob(db, { kind: 'metrics', payload: { a: 1 }, idempotencyKey: 'key-race', actor }, baseTime);
  assert.deepEqual(result, { id: 'job_winner', status: 'queued', created: false });

  const counted = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE idempotency_key = 'key-race'");
  assert.equal(Number((counted.rows[0] as { total: number }).total), 1, '不该产生第二条作业');
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
  await leaseNextJob(db, { workerId: 'worker-a', kinds: ['metrics'], leaseSeconds: 300 }, at(1));
  assert.equal(await leaseNextJob(db, { workerId: 'worker-b', kinds: ['metrics'], leaseSeconds: 300 }, at(2)), null);

  const stolen = await leaseNextJob(db, { workerId: 'worker-b', kinds: ['metrics'], leaseSeconds: 300 }, at(400));
  assert.equal((stolen as unknown as { id: string }).id, job.id);
  assert.equal((await jobRow(db, job.id)).lease_owner, 'worker-b');
  assert.equal((await jobRow(db, job.id)).attempt, 2);
});

void test('续约把租约推后，过期时刻的第二个 Worker 领不走作业', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'RENDER_QUEUED');
  const job = await enqueueJob(db, { kind: 'render', projectId: 'project_1', payload: {}, idempotencyKey: 'render-1', actor }, baseTime);
  await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(1));

  const renewed = await renewJobLease(db, { id: job.id, workerId: 'worker-a', leaseSeconds: 300 }, at(200));
  assert.equal('error' in renewed, false);
  assert.equal(await leaseNextJob(db, { workerId: 'worker-b', kinds: ['render'], leaseSeconds: 300 }, at(400)), null);

  const wrongOwner = await renewJobLease(db, { id: job.id, workerId: 'worker-b', leaseSeconds: 300 }, at(210));
  assert.equal('error' in wrongOwner, true);
});

void test('租约不属于该 Worker 时 finishJob 返回 409，成功完成把项目推进到 QC_PENDING', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'RENDER_QUEUED');
  const job = await enqueueJob(db, { kind: 'render', projectId: 'project_1', payload: {}, idempotencyKey: 'render-1', actor }, baseTime);
  await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(1));

  const foreign = await finishJob(db, { id: job.id, workerId: 'worker-b', succeeded: true }, at(2));
  assert.deepEqual('status' in foreign ? foreign.status : null, 409);

  const finished = await finishJob(db, { id: job.id, workerId: 'worker-a', succeeded: true, result: { durationMs: 1200 } }, at(3));
  assert.equal((finished as { status: string }).status, 'succeeded');
  assert.equal(await projectState(db, 'project_1'), 'QC_PENDING');

  const replayed = await finishJob(db, { id: job.id, workerId: 'worker-a', succeeded: true }, at(4));
  assert.deepEqual('status' in replayed ? replayed.status : null, 409);
});

void test('普通失败进入重试，terminal 失败直接进死信并把项目标记为 FAILED', async () => {
  const db = await createMemoryPg();
  await seedProject(db, 'project_1', 'RENDER_QUEUED');
  const job = await enqueueJob(db, { kind: 'render', projectId: 'project_1', payload: {}, idempotencyKey: 'render-1', actor }, baseTime);

  await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(1));
  const retried = await finishJob(db, { id: job.id, workerId: 'worker-a', succeeded: false, error: 'ffmpeg 崩溃' }, at(2));
  assert.equal((retried as { status: string }).status, 'retrying');
  assert.equal(await projectState(db, 'project_1'), 'RENDER_QUEUED');

  await leaseNextJob(db, { workerId: 'worker-a', kinds: ['render'], leaseSeconds: 300 }, at(600));
  const terminal = await finishJob(db, { id: job.id, workerId: 'worker-a', succeeded: false, error: '自动 QC 未通过：duration', terminal: true }, at(601));
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
