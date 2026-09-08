import { env } from 'cloudflare:workers';
import { resolveActor, ROLES, stableHash } from '@/lib/workflow';

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以修改成员。' }, { status: 403 });
  let body: { role?: string; status?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (body.role !== undefined && !ROLES.includes(body.role as never)) return Response.json({ error: 'role 无效。' }, { status: 422 });
  if (body.status !== undefined && !['active', 'suspended'].includes(body.status)) return Response.json({ error: 'status 无效。' }, { status: 422 });
  if (body.role === undefined && body.status === undefined) return Response.json({ error: '至少提供 role 或 status。' }, { status: 422 });
  const { userId } = await context.params;
  const current = await env.DB.prepare('SELECT user_id, email, role, status FROM team_members WHERE user_id = ? LIMIT 1').bind(userId).first<{ user_id: string; email: string; role: string; status: string }>();
  if (!current) return Response.json({ error: '成员不存在。' }, { status: 404 });
  const next = { ...current, role: body.role ?? current.role, status: body.status ?? current.status };
  if (current.role === 'admin' && current.status === 'active' && (next.role !== 'admin' || next.status !== 'active')) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS total FROM team_members WHERE role = 'admin' AND status = 'active'").first<{ total: number }>();
    if (Number(count?.total ?? 0) <= 1) return Response.json({ error: '不能停用或降级最后一名管理员。' }, { status: 409 });
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('UPDATE team_members SET role = ?, status = ?, updated_at = ? WHERE user_id = ?').bind(next.role, next.status, now, userId),
    env.DB.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, before_hash, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'member.updated', 'team_member', ?, ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, userId, stableHash(current), stableHash(next), JSON.stringify({ role: next.role, status: next.status }), crypto.randomUUID(), now),
  ]);
  return Response.json({ member: { userId, email: current.email, role: next.role, status: next.status } });
}
