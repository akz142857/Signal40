import { db, resolveRequestActor } from '@/lib/runtime';
import { loadContentProject } from '@/lib/control-plane';
import { stableHash } from '@/lib/workflow';

type MetricsInput = {
  publishJobId?: string;
  capturedAt?: string;
  metrics?: { views?: number; averageViewDurationSeconds?: number; completionRate?: number; threeSecondRetentionRate?: number; likes?: number; comments?: number; shares?: number; clicks?: number; follows?: number; negativeFeedback?: number };
  attribution?: { source?: string; window?: string; externalId?: string };
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await db.prepare('SELECT id, publish_job_id, captured_at, metrics_json, attribution_json FROM metric_snapshots WHERE project_id = ? ORDER BY captured_at ASC').bind(id).all();
  return Response.json({ snapshots: result.results.map((row) => ({ id: row.id, publishJobId: row.publish_job_id, capturedAt: row.captured_at, metrics: JSON.parse(String(row.metrics_json)), attribution: JSON.parse(String(row.attribution_json)) })) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['publisher', 'auditor', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权写入发布指标。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  let body: MetricsInput;
  try { body = (await request.json()) as MetricsInput; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const capturedAt = body.capturedAt ? new Date(body.capturedAt) : new Date();
  if (!body.publishJobId || Number.isNaN(capturedAt.valueOf()) || !body.metrics) return Response.json({ error: 'publishJobId、capturedAt 和 metrics 必填。' }, { status: 422 });
  for (const [name, value] of Object.entries(body.metrics)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return Response.json({ error: `metrics.${name} 必须是非负数。` }, { status: 422 });
  }
  if (body.metrics.completionRate !== undefined && body.metrics.completionRate > 1) return Response.json({ error: 'completionRate 必须在 0–1。' }, { status: 422 });
  if (body.metrics.threeSecondRetentionRate !== undefined && body.metrics.threeSecondRetentionRate > 1) return Response.json({ error: 'threeSecondRetentionRate 必须在 0–1。' }, { status: 422 });
  const { id } = await context.params;
  const project = await loadContentProject(db, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (!['PUBLISHED', 'MEASURED'].includes(project.state)) return Response.json({ error: '项目尚未确认发布。' }, { status: 409 });
  const publishJob = await db.prepare("SELECT id FROM publish_jobs WHERE id = ? AND project_id = ? AND status = 'published'").bind(body.publishJobId, id).first();
  if (!publishJob) return Response.json({ error: '发布任务不存在或尚未发布。' }, { status: 409 });
  const existing = await db.prepare('SELECT id FROM metric_snapshots WHERE project_id = ? AND idempotency_key = ?').bind(id, key).first<{ id: string }>();
  if (existing) return Response.json({ snapshot: { id: existing.id }, replayed: true });
  const snapshotId = `metric_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const assignments = await db.prepare('SELECT experiment_id, variant, assignment_hash FROM project_experiment_assignments WHERE project_id = ?').bind(id).all();
  const attribution = { source: body.attribution?.source ?? 'manual', window: body.attribution?.window ?? 'custom', externalId: body.attribution?.externalId ?? null, projectVersion: project.version, snapshotHash: project.project.render.snapshotHash, experiments: assignments.results };
  await db.batch([
    db.prepare('INSERT INTO metric_snapshots (id, project_id, publish_job_id, idempotency_key, captured_at, metrics_json, attribution_json) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(snapshotId, id, body.publishJobId, key, capturedAt.toISOString(), JSON.stringify(body.metrics), JSON.stringify(attribution)),
    db.prepare("UPDATE content_projects SET state = 'MEASURED', version = version + 1, updated_at = ? WHERE id = ? AND state = 'PUBLISHED'").bind(now, id),
    db.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'metrics.captured', 'metric_snapshot', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, id, actor.id, actor.role, snapshotId, stableHash(body.metrics), JSON.stringify(attribution), crypto.randomUUID(), now),
  ]);
  return Response.json({ snapshot: { id: snapshotId, capturedAt: capturedAt.toISOString(), metrics: body.metrics, attribution } }, { status: 201 });
}
