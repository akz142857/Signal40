import { env } from 'cloudflare:workers';
import { resolveActor, ROLES, stableHash } from '@/lib/workflow';

export async function GET(request: Request) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '无权读取团队成员。' }, { status: 403 });
  const result = await env.DB.prepare('SELECT user_id, email, role, status, created_at, updated_at FROM team_members ORDER BY email').all();
  return Response.json({ members: result.results });
}

export async function POST(request: Request) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以添加成员。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  let body: { userId?: string; email?: string; role?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const email = body.email?.trim().toLowerCase();
  if (!body.userId?.trim() || !email || !/^\S+@\S+\.\S+$/.test(email) || !ROLES.includes(body.role as never)) return Response.json({ error: 'userId、email 或 role 无效。' }, { status: 422 });
  const existing = await env.DB.prepare('SELECT user_id FROM team_members WHERE user_id = ? OR email = ? LIMIT 1').bind(body.userId.trim(), email).first();
  if (existing) return Response.json({ error: '用户 ID 或邮箱已经存在。' }, { status: 409 });
  const now = new Date().toISOString();
  const member = { userId: body.userId.trim(), email, role: body.role, status: 'active' };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO team_members (user_id, email, role, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)").bind(member.userId, email, body.role, now, now),
    env.DB.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'member.created', 'team_member', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, member.userId, stableHash(member), JSON.stringify({ idempotencyKey: key, email, role: body.role }), crypto.randomUUID(), now),
  ]);
  return Response.json({ member }, { status: 201 });
}
