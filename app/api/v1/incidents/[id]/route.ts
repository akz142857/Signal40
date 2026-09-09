import { db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['editor', 'publisher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权关闭内容事件。' }, { status: 403 });
  let body: { resolution?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.resolution?.trim() || body.resolution.trim().length < 10 || body.resolution.length > 4000) return Response.json({ error: '处置结果必须为 10–4000 字。' }, { status: 422 });
  const { id } = await context.params;
  const incident = await db.prepare("SELECT id, project_id, status FROM content_incidents WHERE id = ? LIMIT 1").bind(id).first<{ id: string; project_id: string; status: string }>();
  if (!incident) return Response.json({ error: '内容事件不存在。' }, { status: 404 });
  if (incident.status === 'resolved') return Response.json({ incident: { id, status: 'resolved' }, replayed: true });
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE content_incidents SET status = 'resolved', resolution = ?, updated_at = ? WHERE id = ? AND status = 'open'").bind(body.resolution.trim(), now, id),
    db.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'incident.resolved', 'content_incident', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, incident.project_id, actor.id, actor.role, id, stableHash(body.resolution.trim()), JSON.stringify({ resolution: body.resolution.trim(), trigger: 'human' }), crypto.randomUUID(), now),
  ]);
  return Response.json({ incident: { id, status: 'resolved' } });
}
