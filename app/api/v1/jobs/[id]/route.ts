import { env } from 'cloudflare:workers';
import { resolveActor, stableHash } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || !['admin', 'auditor', 'producer'].includes(actor.role)) return Response.json({ error: '当前角色无权查看作业。' }, { status: 403 });
  const { id } = await context.params;
  const job = await env.DB.prepare('SELECT id, kind, project_id, status, attempt, max_attempts, available_at, lease_owner, lease_expires_at, result_json, last_error, cost_micros, created_at, updated_at FROM jobs WHERE id = ? LIMIT 1').bind(id).first();
  if (!job) return Response.json({ error: '作业不存在。' }, { status: 404 });
  return Response.json({ job });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以取消或重放作业。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  let body: { action?: string; note?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!['cancel', 'replay'].includes(body.action || '') || !body.note?.trim() || body.note.trim().length < 5) return Response.json({ error: 'action 必须是 cancel/replay，note 至少 5 字。' }, { status: 422 });
  const { id } = await context.params;
  const prior = await env.DB.prepare("SELECT id FROM audit_events WHERE entity_type = 'job' AND entity_id = ? AND json_extract(metadata_json, '$.idempotencyKey') = ? LIMIT 1").bind(id, key).first();
  if (prior) {
    const current = await env.DB.prepare('SELECT id, status FROM jobs WHERE id = ? LIMIT 1').bind(id).first();
    return Response.json({ job: current, replayed: true });
  }
  const job = await env.DB.prepare('SELECT id, kind, project_id, status, payload_json FROM jobs WHERE id = ? LIMIT 1').bind(id).first<{ id: string; kind: string; project_id: string | null; status: string; payload_json: string }>();
  if (!job) return Response.json({ error: '作业不存在。' }, { status: 404 });
  const replay = body.action === 'replay';
  const allowed = replay ? ['dead_letter', 'failed', 'cancelled'] : ['queued', 'retrying', 'leased'];
  if (!allowed.includes(job.status)) return Response.json({ error: `作业 ${job.status} 状态不能${replay ? '重放' : '取消'}。` }, { status: 409 });
  const now = new Date().toISOString();
  const nextStatus = replay ? 'queued' : 'cancelled';
  const statements: D1PreparedStatement[] = [
    env.DB.prepare('UPDATE jobs SET status = ?, attempt = CASE WHEN ? THEN 0 ELSE attempt END, available_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = CASE WHEN ? THEN NULL ELSE last_error END, updated_at = ? WHERE id = ? AND status = ?').bind(nextStatus, replay ? 1 : 0, now, replay ? 1 : 0, now, id, job.status),
    env.DB.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, before_hash, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, ?, 'job', ?, ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, job.project_id, actor.id, actor.role, replay ? 'job.replayed' : 'job.cancelled', id, stableHash({ status: job.status }), stableHash({ status: nextStatus }), JSON.stringify({ note: body.note.trim(), idempotencyKey: key }), crypto.randomUUID(), now),
  ];
  if (job.kind === 'ingestion') {
    const payload = JSON.parse(job.payload_json) as { ingestionRunId?: string };
    if (payload.ingestionRunId) statements.push(env.DB.prepare('UPDATE ingestion_runs SET status = ?, finished_at = ? WHERE id = ?').bind(replay ? 'queued' : 'cancelled', replay ? null : now, payload.ingestionRunId));
  }
  if (job.kind === 'render' && job.project_id && !replay) statements.push(env.DB.prepare("UPDATE content_projects SET state = 'CHANGES_REQUESTED', version = version + 1, updated_at = ? WHERE id = ? AND state IN ('RENDER_QUEUED', 'RENDERING')").bind(now, job.project_id));
  const result = await env.DB.batch(statements);
  if (!result[0].meta.changes) return Response.json({ error: '作业状态已被其他操作修改。' }, { status: 409 });
  return Response.json({ job: { id, status: nextStatus, replayed: replay } });
}
