import { db, resolveRequestActor } from '@/lib/runtime';
import { ROLES, stableHash } from '@/lib/workflow';
import { reconcileSourceOwnership } from '@/lib/source-ownership';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '无权读取团队成员。' }, { status: 403 });
  const result = await db.prepare(`
    SELECT member.user_id, member.email, member.role, member.status,
      member.can_approve_source_rights, member.can_manage_source_legal,
      member.created_at, member.updated_at,
      CAST((SELECT COUNT(*) FROM source_configs source
       WHERE source.business_owner_id = member.user_id
         AND source.lifecycle_status <> 'archived') AS integer) AS business_source_count,
      CAST((SELECT COUNT(*) FROM source_configs source
       WHERE source.credential_steward_id = member.user_id
         AND source.lifecycle_status <> 'archived') AS integer) AS credential_source_count,
      CAST((SELECT COUNT(*) FROM source_configs source
       WHERE source.backup_admin_id = member.user_id
         AND source.lifecycle_status <> 'archived') AS integer) AS backup_source_count
    FROM team_members member ORDER BY member.email
  `).all();
  return Response.json({ members: result.results });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以添加成员。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 160) return Response.json({ error: 'Idempotency-Key 必填且不能超过 160 字符。' }, { status: 400 });
  let body: {
    userId?: string;
    email?: string;
    role?: string;
    canApproveSourceRights?: boolean;
    canManageSourceLegal?: boolean;
  };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: '请求体必须是 JSON object。' }, { status: 400 });
  const unknownFields = Object.keys(body).filter((field) =>
    !['userId', 'email', 'role', 'canApproveSourceRights', 'canManageSourceLegal'].includes(field));
  if (unknownFields.length) return Response.json({ error: `不支持字段：${unknownFields.join('、')}。` }, { status: 422 });
  const email = body.email?.trim().toLowerCase();
  if (!body.userId?.trim() || body.userId.trim().length > 200 || !email || email.length > 320 || !/^\S+@\S+\.\S+$/.test(email) || !ROLES.includes(body.role as never)) return Response.json({ error: 'userId、email 或 role 无效。' }, { status: 422 });
  if (body.canApproveSourceRights !== undefined && typeof body.canApproveSourceRights !== 'boolean') return Response.json({ error: 'canApproveSourceRights 必须是布尔值。' }, { status: 422 });
  if (body.canManageSourceLegal !== undefined && typeof body.canManageSourceLegal !== 'boolean') return Response.json({ error: 'canManageSourceLegal 必须是布尔值。' }, { status: 422 });
  if (body.canApproveSourceRights && body.role !== 'admin') return Response.json({ error: '只有 admin 成员可以获得来源权利审批能力。' }, { status: 422 });
  if (body.canManageSourceLegal && body.role !== 'admin') return Response.json({ error: '只有 admin 成员可以获得来源法律操作能力。' }, { status: 422 });
  // 与 experiments / source-configs 保持一致：同一幂等键重放第一次的成功结果，而不是回 409。
  const replay = await db.prepare("SELECT entity_id FROM audit_events WHERE action = 'member.created' AND metadata_json ->> 'idempotencyKey' = ? LIMIT 1").bind(key).first<{ entity_id: string }>();
  if (replay) {
    const stored = await db.prepare('SELECT user_id, email, role, status, can_approve_source_rights, can_manage_source_legal FROM team_members WHERE user_id = ? LIMIT 1').bind(replay.entity_id).first<{
      user_id: string;
      email: string;
      role: string;
      status: string;
      can_approve_source_rights: number;
      can_manage_source_legal: number;
    }>();
    if (!stored) return Response.json({ error: '幂等记录对应的成员不存在。' }, { status: 409 });
    return Response.json({
      member: {
        userId: stored.user_id,
        email: stored.email,
        role: stored.role,
        status: stored.status,
        canApproveSourceRights: Boolean(stored.can_approve_source_rights),
        canManageSourceLegal: Boolean(stored.can_manage_source_legal),
      },
      replayed: true,
    });
  }
  const existing = await db.prepare('SELECT user_id FROM team_members WHERE user_id = ? OR email = ? LIMIT 1').bind(body.userId.trim(), email).first();
  if (existing) return Response.json({ error: '用户 ID 或邮箱已经存在。' }, { status: 409 });
  const now = new Date().toISOString();
  const member = {
    userId: body.userId.trim(),
    email,
    role: body.role,
    status: 'active',
    canApproveSourceRights: Boolean(body.canApproveSourceRights),
    canManageSourceLegal: Boolean(body.canManageSourceLegal),
  };
  const ownership = await db.transaction(async (tx) => {
    await tx.prepare("INSERT INTO team_members (user_id, email, role, status, can_approve_source_rights, can_manage_source_legal, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)").bind(member.userId, email, body.role, member.canApproveSourceRights ? 1 : 0, member.canManageSourceLegal ? 1 : 0, now, now).run();
    await tx.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'member.created', 'team_member', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, member.userId, stableHash(member), JSON.stringify({ idempotencyKey: key, email, role: body.role, canApproveSourceRights: member.canApproveSourceRights, canManageSourceLegal: member.canManageSourceLegal }), crypto.randomUUID(), now).run();
    return reconcileSourceOwnership(tx, actor, new Date(now));
  });
  return Response.json({ member, ownershipImpact: ownership }, { status: 201 });
}
