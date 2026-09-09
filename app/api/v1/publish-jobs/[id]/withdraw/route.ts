import { db, resolveRequestActor } from '@/lib/runtime';
import { enqueueJob, pauseAutomationStatement } from '@/lib/control-plane';
import { stableHash } from '@/lib/workflow';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['publisher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权撤回内容。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  let body: { reason?: string; severity?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.reason?.trim() || body.reason.trim().length < 10 || body.reason.length > 2000) return Response.json({ error: '撤回原因必须为 10–2000 字。' }, { status: 422 });
  if (body.severity && !['low', 'medium', 'high', 'critical'].includes(body.severity)) return Response.json({ error: 'severity 无效。' }, { status: 422 });
  const { id } = await context.params;
  const publish = await db.prepare("SELECT id, project_id, channel, external_id, status FROM publish_jobs WHERE id = ? LIMIT 1").bind(id).first<{ id: string; project_id: string; channel: string; external_id: string | null; status: string }>();
  if (!publish) return Response.json({ error: '发布任务不存在。' }, { status: 404 });
  if (publish.status === 'withdrawn') return Response.json({ publishJobId: id, status: 'withdrawn', replayed: true });
  if (!['scheduled', 'publishing', 'published', 'failed'].includes(publish.status)) return Response.json({ error: `不能从 ${publish.status} 撤回。` }, { status: 409 });
  const incidentId = `incident_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const payload = { operation: 'withdraw', publishJobId: id, channel: publish.channel, externalId: publish.external_id, reason: body.reason.trim() };
  const job = await enqueueJob(db, { kind: 'publish', projectId: publish.project_id, payload, idempotencyKey: `withdraw:${id}:${key}`, actor });
  const existingIncident = await db.prepare("SELECT id FROM content_incidents WHERE publish_job_id = ? AND kind = 'withdrawal' AND status = 'open' ORDER BY created_at DESC LIMIT 1")
    .bind(id).first<{ id: string }>();
  if (!job.created && existingIncident) {
    return Response.json({ publishJobId: id, status: 'withdrawal_pending', incidentId: existingIncident.id, remoteRemovalJob: job, replayed: true }, { status: 202 });
  }
  await db.batch([
    db.prepare("INSERT INTO content_incidents (id, project_id, publish_job_id, kind, severity, status, reason, actor_id, created_at, updated_at) VALUES (?, ?, ?, 'withdrawal', ?, 'open', ?, ?, ?, ?)").bind(incidentId, publish.project_id, id, body.severity ?? 'high', body.reason.trim(), actor.id, now, now),
    db.prepare("UPDATE content_projects SET state = 'CHANGES_REQUESTED', version = version + 1, updated_at = ? WHERE id = ? AND state IN ('PUBLISHED', 'MEASURED', 'PUBLISH_SCHEDULED')").bind(now, publish.project_id),
    pauseAutomationStatement(db, publish.project_id, '人工撤回发布并创建内容事件，自动化已暂停，需处置后显式恢复。'),
    db.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'publish.withdrawal_requested', 'publish_job', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, publish.project_id, actor.id, actor.role, id, stableHash(payload), JSON.stringify({ incidentId, channel: publish.channel, externalId: publish.external_id, trigger: 'human' }), crypto.randomUUID(), now),
  ]);
  return Response.json({ publishJobId: id, status: 'withdrawal_pending', incidentId, remoteRemovalJob: job }, { status: 202 });
}
