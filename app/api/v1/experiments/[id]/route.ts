import { env } from 'cloudflare:workers';
import { resolveActor, stableHash } from '@/lib/workflow';

const transitions: Record<string, string[]> = { draft: ['running', 'cancelled'], running: ['completed', 'cancelled'], completed: [], cancelled: [] };

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以变更实验状态。' }, { status: 403 });
  let body: { status?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const { id } = await context.params;
  const experiment = await env.DB.prepare('SELECT id, status FROM experiments WHERE id = ? LIMIT 1').bind(id).first<{ id: string; status: string }>();
  if (!experiment) return Response.json({ error: '实验不存在。' }, { status: 404 });
  if (!body.status || !transitions[experiment.status]?.includes(body.status)) return Response.json({ error: `不允许从 ${experiment.status} 转换到 ${body.status ?? '空状态'}。` }, { status: 409 });
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE experiments SET status = ?, starts_at = CASE WHEN ? = \'running\' THEN COALESCE(starts_at, ?) ELSE starts_at END, ends_at = CASE WHEN ? IN (\'completed\', \'cancelled\') THEN ? ELSE ends_at END, updated_at = ? WHERE id = ? AND status = ?').bind(body.status, body.status, now, body.status, now, now, id, experiment.status),
    env.DB.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, before_hash, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'experiment.transitioned', 'experiment', ?, ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash({ status: experiment.status }), stableHash({ status: body.status }), JSON.stringify({ from: experiment.status, to: body.status }), crypto.randomUUID(), now),
  ]);
  return Response.json({ experiment: { id, status: body.status } });
}
