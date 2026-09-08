import { env } from 'cloudflare:workers';
import { resolveActor, stableHash } from '@/lib/workflow';

const kinds = ['correction', 'fact_update', 'complaint'] as const;
const severities = ['low', 'medium', 'high', 'critical'] as const;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const incidents = await env.DB.prepare('SELECT id, publish_job_id, kind, severity, status, reason, resolution, actor_id, created_at, updated_at FROM content_incidents WHERE project_id = ? ORDER BY created_at DESC').bind(id).all();
  return Response.json({ incidents: incidents.results });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || !['editor', 'publisher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权登记内容事件。' }, { status: 403 });
  let body: { kind?: string; severity?: string; reason?: string; publishJobId?: string | null };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!kinds.includes(body.kind as never) || !severities.includes(body.severity as never) || !body.reason?.trim() || body.reason.trim().length < 10 || body.reason.length > 4000) return Response.json({ error: '事件类型、严重度或 10–4000 字原因无效。' }, { status: 422 });
  const { id } = await context.params;
  const project = await env.DB.prepare('SELECT id FROM content_projects WHERE id = ? LIMIT 1').bind(id).first();
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (body.publishJobId) {
    const publish = await env.DB.prepare('SELECT id FROM publish_jobs WHERE id = ? AND project_id = ? LIMIT 1').bind(body.publishJobId, id).first();
    if (!publish) return Response.json({ error: 'publishJobId 不属于该项目。' }, { status: 422 });
  }
  const incidentId = `incident_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO content_incidents (id, project_id, publish_job_id, kind, severity, status, reason, actor_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)").bind(incidentId, id, body.publishJobId ?? null, body.kind, body.severity, body.reason.trim(), actor.id, now, now),
    env.DB.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'incident.created', 'content_incident', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, id, actor.id, actor.role, incidentId, stableHash(body), JSON.stringify({ kind: body.kind, severity: body.severity }), crypto.randomUUID(), now),
  ]);
  return Response.json({ incident: { id: incidentId, status: 'open' } }, { status: 201 });
}
