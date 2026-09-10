import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { enqueueJob, leaseNextJob } from '../lib/control-plane.ts';
import { runPipeline } from '../lib/domain.ts';
import { persistPipeline } from '../lib/persistence.ts';
import { createProjectV2, type VideoProjectV2 } from '../lib/project-v2.ts';
import type { MultipartUpload, ObjectPutBody, ObjectStorage } from '../lib/storage.ts';
import { stableHash, type Actor, type ContentState } from '../lib/workflow.ts';
import { sampleArticles } from './fixtures/sample-articles.ts';
import { createMemoryPg } from './pg-memory.ts';
import { setRouteTestContext } from './route-runtime.ts';

/**
 * 高风险 Handler → PostgreSQL 回归：覆盖 Worker 读取/回写的租约围栏，以及
 * 项目、作业、指标、实验四条曾经缺少请求哈希的幂等写路径。
 */
register('./route-alias-hook.mjs', import.meta.url);

const admin: Actor = { id: 'admin-critical', email: 'critical@example.com', role: 'admin' } as Actor;
const renderToken = 'render-worker-test-token';

class MemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();

  async get(key: string) {
    const data = this.objects.get(key);
    if (!data) return null;
    return { body: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }) };
  }

  async put(key: string, body: ObjectPutBody) {
    const data = typeof body === 'string'
      ? new TextEncoder().encode(body)
      : body instanceof ReadableStream
        ? new Uint8Array(await new Response(body).arrayBuffer())
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    this.objects.set(key, data.slice());
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list({ prefix }: { prefix: string }) {
    return { objects: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
  }

  async createMultipartUpload(): Promise<MultipartUpload> { throw new Error('本测试不使用分片上传。'); }
  resumeMultipartUpload(): MultipartUpload { throw new Error('本测试不使用分片上传。'); }
}

function requestJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function verifiedTopic(now: Date) {
  const topic = runPipeline(sampleArticles(now), now).find((candidate) => candidate.gate.passed);
  assert.ok(topic);
  return { ...topic, verificationStatus: 'verified' as const };
}

async function seedDirectProject(db: Awaited<ReturnType<typeof createMemoryPg>>, state: ContentState) {
  const now = new Date();
  const project = createProjectV2(verifiedTopic(now), now);
  await db.prepare(`
    INSERT INTO content_projects
      (id, topic_id, title, state, version, owner_id, brand, locale, project_json, immutable_hash, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
  `).bind(project.identity.projectId, project.identity.topicId, project.identity.title, state, admin.id, project.identity.brand, project.identity.locale, JSON.stringify(project), stableHash(project), now.toISOString(), now.toISOString()).run();
  return project;
}

async function leaseProjectJob(
  db: Awaited<ReturnType<typeof createMemoryPg>>,
  project: VideoProjectV2,
  kind: 'voice' | 'preview' | 'render' | 'publish',
  payload: Record<string, unknown>,
) {
  const now = new Date();
  const queued = await enqueueJob(db, {
    kind,
    projectId: project.identity.projectId,
    payload,
    idempotencyKey: `${kind}-${crypto.randomUUID()}`,
    actor: admin,
  }, now);
  const leased = await leaseNextJob(db, { workerId: 'render-worker-one', kinds: [kind], leaseSeconds: 300 }, new Date(now.valueOf() + 1));
  assert.ok(leased, `${kind} 作业应可领取`);
  const leasedJob = leased as unknown as Record<string, unknown> & { id: string; lease_epoch: number };
  assert.equal(leasedJob.id, queued.id);
  return leasedJob;
}

void test('Render Worker 只能用当前项目租约读取并写入配音资产与音轨', async () => {
  const db = await createMemoryPg();
  const storage = new MemoryStorage();
  setRouteTestContext({ db, actor: null, storage, config: { renderWorkerToken: renderToken } });
  const project = await seedDirectProject(db, 'SCRIPT_APPROVED');
  const lease = await leaseProjectJob(db, project, 'voice', {
    scriptHash: stableHash(project.script),
    scriptVersion: project.script.version,
  });
  const leaseQuery = new URLSearchParams({ jobId: lease.id, workerId: 'render-worker-one', leaseEpoch: String(lease.lease_epoch) });
  const { GET } = await import('../app/api/v1/projects/[id]/route.ts');

  const staleRead = await GET(new Request(`http://local/api/v1/projects/${project.identity.projectId}?${new URLSearchParams({ ...Object.fromEntries(leaseQuery), leaseEpoch: String(lease.lease_epoch + 1) })}`, { headers: { 'x-worker-token': renderToken } }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(staleRead.status, 409);
  const read = await GET(new Request(`http://local/api/v1/projects/${project.identity.projectId}?${leaseQuery}`, { headers: { 'x-worker-token': renderToken } }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(read.status, 200, await read.clone().text());

  const { POST: uploadAsset } = await import('../app/api/v1/projects/[id]/assets/route.ts');
  const assetHeaders = {
    'x-worker-token': renderToken,
    'content-type': 'audio/mpeg',
    'x-filename': 'voice.mp3',
    'x-rights-status': 'cleared',
    'x-asset-role': 'voice-output',
    'x-job-id': lease.id,
    'x-worker-id': 'render-worker-one',
    'x-lease-epoch': String(lease.lease_epoch),
  };
  const staleUpload = await uploadAsset(new Request(`http://local/api/v1/projects/${project.identity.projectId}/assets`, { method: 'POST', headers: { ...assetHeaders, 'x-lease-epoch': String(lease.lease_epoch + 1) }, body: new Uint8Array([1, 2, 3]) }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(staleUpload.status, 409);
  const upload = await uploadAsset(new Request(`http://local/api/v1/projects/${project.identity.projectId}/assets`, { method: 'POST', headers: assetHeaders, body: new Uint8Array([1, 2, 3]) }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(upload.status, 201, await upload.clone().text());
  const asset = (await upload.json() as { asset: { id: string } }).asset;
  const replayedUpload = await uploadAsset(new Request(`http://local/api/v1/projects/${project.identity.projectId}/assets`, { method: 'POST', headers: assetHeaders, body: new Uint8Array([1, 2, 3]) }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(replayedUpload.status, 201);
  assert.equal(replayedUpload.headers.get('idempotency-replayed'), 'true');

  const voiceBody = {
    jobId: lease.id,
    workerId: 'render-worker-one',
    leaseEpoch: lease.lease_epoch,
    assetId: asset.id,
    provider: 'test-provider',
    voice: 'test-voice',
    durationMs: 1_000,
    alignment: [],
    captions: [{ startMs: 0, endMs: 900, text: '测试字幕', lineId: 'line_hook', granularity: 'sentence', style: 'default', safeArea: { left: 10, right: 10, top: 10, bottom: 10 }, manuallyEdited: false }],
    scriptVersion: project.script.version,
    scriptHash: stableHash(project.script),
  };
  const { POST: commitVoice } = await import('../app/api/v1/projects/[id]/voice-tracks/route.ts');
  const staleVoice = await commitVoice(requestJson(`http://local/api/v1/projects/${project.identity.projectId}/voice-tracks`, { ...voiceBody, leaseEpoch: lease.lease_epoch + 1 }, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(staleVoice.status, 409);
  const voice = await commitVoice(requestJson(`http://local/api/v1/projects/${project.identity.projectId}/voice-tracks`, voiceBody, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(voice.status, 200, await voice.clone().text());
  const replayedVoice = await commitVoice(requestJson(`http://local/api/v1/projects/${project.identity.projectId}/voice-tracks`, voiceBody, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: project.identity.projectId }) });
  assert.equal(replayedVoice.status, 200);
  assert.equal(replayedVoice.headers.get('idempotency-replayed'), 'true');
  const trackCount = await db.prepare('SELECT COUNT(*)::int AS total FROM voice_tracks WHERE project_id = ?').bind(project.identity.projectId).first<{ total: number }>();
  assert.equal(Number(trackCount?.total), 1);
});

void test('QC 与发布完成都拒绝旧 epoch，只接受当前未过期租约', async () => {
  const qcDb = await createMemoryPg();
  setRouteTestContext({ db: qcDb, actor: null, storage: new MemoryStorage(), config: { renderWorkerToken: renderToken } });
  const renderProject = await seedDirectProject(qcDb, 'RENDER_QUEUED');
  const renderLease = await leaseProjectJob(qcDb, renderProject, 'render', { snapshotHash: renderProject.render.snapshotHash });
  const { POST: uploadRenderAsset } = await import('../app/api/v1/projects/[id]/assets/route.ts');
  for (const [filename, contentType] of [['render.mp4', 'video/mp4'], ['cover.jpg', 'image/jpeg']] as const) {
    const uploaded = await uploadRenderAsset(new Request('http://local/render-assets', {
      method: 'POST',
      headers: { 'x-worker-token': renderToken, 'content-type': contentType, 'x-filename': filename, 'x-rights-status': 'cleared', 'x-asset-role': 'render-output', 'x-job-id': renderLease.id, 'x-worker-id': 'render-worker-one', 'x-lease-epoch': String(renderLease.lease_epoch) },
      body: new Uint8Array([4, 5, 6]),
    }), { params: Promise.resolve({ id: renderProject.identity.projectId }) });
    assert.equal(uploaded.status, 201, `${filename}: ${await uploaded.clone().text()}`);
  }
  const { POST: commitQc } = await import('../app/api/v1/projects/[id]/qc-reports/route.ts');
  const qcRequest = { renderJobId: renderLease.id, workerId: 'render-worker-one', leaseEpoch: renderLease.lease_epoch, status: 'passed', checks: [{ id: 'duration', passed: true }] };
  const staleQc = await commitQc(requestJson('http://local/qc', { ...qcRequest, leaseEpoch: renderLease.lease_epoch + 1 }, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: renderProject.identity.projectId }) });
  assert.equal(staleQc.status, 409);
  const qc = await commitQc(requestJson('http://local/qc', qcRequest, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: renderProject.identity.projectId }) });
  assert.equal(qc.status, 201, await qc.clone().text());
  const replayedQc = await commitQc(requestJson('http://local/qc', qcRequest, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: renderProject.identity.projectId }) });
  assert.equal(replayedQc.status, 201);
  assert.equal(replayedQc.headers.get('idempotency-replayed'), 'true');
  const qcConflict = await commitQc(requestJson('http://local/qc', { ...qcRequest, status: 'failed' }, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: renderProject.identity.projectId }) });
  assert.equal(qcConflict.status, 409);

  const publishDb = await createMemoryPg();
  const publishStorage = new MemoryStorage();
  setRouteTestContext({ db: publishDb, actor: null, storage: publishStorage, config: { renderWorkerToken: renderToken } });
  const publishProject = await seedDirectProject(publishDb, 'PUBLISH_SCHEDULED');
  const timestamp = new Date().toISOString();
  await publishDb.prepare(`INSERT INTO publish_jobs (id, project_id, channel, logical_key, status, title, description, tags_json, created_at, updated_at) VALUES ('publish-critical', ?, 'package', 'critical-package', 'scheduled', '测试', '', '[]', ?, ?)`)
    .bind(publishProject.identity.projectId, timestamp, timestamp).run();
  const publishLease = await leaseProjectJob(publishDb, publishProject, 'publish', { publishJobId: 'publish-critical', channel: 'package' });
  const { POST: completePublish } = await import('../app/api/v1/publish-jobs/[id]/complete/route.ts');
  const publishRequest = { jobId: publishLease.id, workerId: 'render-worker-one', leaseEpoch: publishLease.lease_epoch, channel: 'package', manifest: { version: 1 } };
  const stalePublish = await completePublish(requestJson('http://local/publish', { ...publishRequest, leaseEpoch: publishLease.lease_epoch + 1 }, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: 'publish-critical' }) });
  assert.equal(stalePublish.status, 409);
  const published = await completePublish(requestJson('http://local/publish', publishRequest, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: 'publish-critical' }) });
  assert.equal(published.status, 200, await published.clone().text());
  const replayedPublish = await completePublish(requestJson('http://local/publish', publishRequest, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: 'publish-critical' }) });
  assert.equal(replayedPublish.status, 200);
  assert.equal(replayedPublish.headers.get('idempotency-replayed'), 'true');
  const publishConflict = await completePublish(requestJson('http://local/publish', { ...publishRequest, manifest: { version: 2 } }, { 'x-worker-token': renderToken }), { params: Promise.resolve({ id: 'publish-critical' }) });
  assert.equal(publishConflict.status, 409);
  const stored = await publishDb.prepare("SELECT status FROM publish_jobs WHERE id = 'publish-critical'").first<{ status: string }>();
  assert.equal(stored?.status, 'published');
});

void test('项目、实验、作业与指标统一实现同键同体重放、同键异体冲突', async () => {
  const projectDb = await createMemoryPg();
  const now = new Date();
  const articles = sampleArticles(now);
  await persistPipeline(projectDb, runPipeline(articles, now), 'sample', articles.length, now);
  const project = createProjectV2(verifiedTopic(now), now);
  setRouteTestContext({ db: projectDb, actor: admin });
  const { POST: createProject } = await import('../app/api/v1/projects/route.ts');
  const projectRequest = { project };
  const created = await createProject(requestJson('http://local/projects', projectRequest, { 'idempotency-key': 'project-critical' }));
  assert.equal(created.status, 201, await created.clone().text());
  const replayedProject = await createProject(requestJson('http://local/projects', projectRequest, { 'idempotency-key': 'project-critical' }));
  assert.equal(replayedProject.status, 201);
  assert.equal(replayedProject.headers.get('idempotency-replayed'), 'true');
  const changedProject = structuredClone(project);
  changedProject.distribution.description = `${changedProject.distribution.description}\n变更`;
  const projectConflict = await createProject(requestJson('http://local/projects', { project: changedProject }, { 'idempotency-key': 'project-critical' }));
  assert.equal(projectConflict.status, 409);

  const experimentDb = await createMemoryPg();
  setRouteTestContext({ db: experimentDb, actor: admin });
  const { POST: createExperiment } = await import('../app/api/v1/experiments/route.ts');
  const experiment = { name: '标题实验', hypothesis: '标题会改善完成率', variants: ['A', 'B'], allocationBps: [5000, 5000], primaryMetric: 'completion_rate' };
  assert.equal((await createExperiment(requestJson('http://local/experiments', experiment, { 'idempotency-key': 'experiment-critical' }))).status, 201);
  assert.equal((await createExperiment(requestJson('http://local/experiments', experiment, { 'idempotency-key': 'experiment-critical' }))).status, 201);
  assert.equal((await createExperiment(requestJson('http://local/experiments', { ...experiment, hypothesis: '不同假设' }, { 'idempotency-key': 'experiment-critical' }))).status, 409);

  const jobDb = await createMemoryPg();
  const jobProject = await seedDirectProject(jobDb, 'SCRIPT_APPROVED');
  setRouteTestContext({ db: jobDb, actor: admin });
  const { POST: createJob } = await import('../app/api/v1/jobs/route.ts');
  const job = { kind: 'voice', projectId: jobProject.identity.projectId, payload: { scriptHash: stableHash(jobProject.script), scriptVersion: jobProject.script.version }, maxAttempts: 3 };
  assert.equal((await createJob(requestJson('http://local/jobs', job, { 'idempotency-key': 'job-critical' }))).status, 202);
  assert.equal((await createJob(requestJson('http://local/jobs', job, { 'idempotency-key': 'job-critical' }))).status, 202);
  assert.equal((await createJob(requestJson('http://local/jobs', { ...job, maxAttempts: 4 }, { 'idempotency-key': 'job-critical' }))).status, 409);

  const metricDb = await createMemoryPg();
  const metricProject = await seedDirectProject(metricDb, 'PUBLISHED');
  const metricTimestamp = new Date().toISOString();
  await metricDb.prepare(`INSERT INTO publish_jobs (id, project_id, channel, logical_key, status, title, description, tags_json, created_at, updated_at) VALUES ('publish-metrics-critical', ?, 'package', 'metrics-critical', 'published', '测试', '', '[]', ?, ?)`)
    .bind(metricProject.identity.projectId, metricTimestamp, metricTimestamp).run();
  setRouteTestContext({ db: metricDb, actor: admin });
  const { POST: createMetric } = await import('../app/api/v1/projects/[id]/metrics/route.ts');
  const metricContext = { params: Promise.resolve({ id: metricProject.identity.projectId }) };
  const metric = { publishJobId: 'publish-metrics-critical', capturedAt: metricTimestamp, metrics: { views: 100, completionRate: 0.6 } };
  assert.equal((await createMetric(requestJson('http://local/metrics', metric, { 'idempotency-key': 'metric-critical' }), metricContext)).status, 201);
  assert.equal((await createMetric(requestJson('http://local/metrics', metric, { 'idempotency-key': 'metric-critical' }), metricContext)).status, 201);
  assert.equal((await createMetric(requestJson('http://local/metrics', { ...metric, metrics: { ...metric.metrics, views: 101 } }, { 'idempotency-key': 'metric-critical' }), metricContext)).status, 409);
});
