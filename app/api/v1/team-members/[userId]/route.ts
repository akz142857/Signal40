import { db, resolveRequestActor } from '@/lib/runtime';
import { ROLES, stableHash } from '@/lib/workflow';
import { reconcileSourceOwnership } from '@/lib/source-ownership';

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以修改成员。' }, { status: 403 });
  let body: {
    role?: string;
    status?: string;
    canApproveSourceRights?: boolean;
    canManageSourceLegal?: boolean;
  };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: '请求体必须是 JSON object。' }, { status: 400 });
  const unknownFields = Object.keys(body).filter((field) =>
    !['role', 'status', 'canApproveSourceRights', 'canManageSourceLegal'].includes(field));
  if (unknownFields.length) return Response.json({ error: `不支持字段：${unknownFields.join('、')}。` }, { status: 422 });
  if (body.role !== undefined && !ROLES.includes(body.role as never)) return Response.json({ error: 'role 无效。' }, { status: 422 });
  if (body.status !== undefined && !['active', 'suspended'].includes(body.status)) return Response.json({ error: 'status 无效。' }, { status: 422 });
  if (body.canApproveSourceRights !== undefined && typeof body.canApproveSourceRights !== 'boolean') return Response.json({ error: 'canApproveSourceRights 必须是布尔值。' }, { status: 422 });
  if (body.canManageSourceLegal !== undefined && typeof body.canManageSourceLegal !== 'boolean') return Response.json({ error: 'canManageSourceLegal 必须是布尔值。' }, { status: 422 });
  if (body.role === undefined && body.status === undefined && body.canApproveSourceRights === undefined && body.canManageSourceLegal === undefined) return Response.json({ error: '至少提供 role、status、canApproveSourceRights 或 canManageSourceLegal。' }, { status: 422 });
  const { userId } = await context.params;
  const now = new Date().toISOString();
  const result = await db.transaction(async (tx) => {
    // Lock the active governance set before counting it. Legal-hold creation
    // takes the same lock, so concurrent capability removal cannot strand a hold.
    await tx.prepare("SELECT user_id FROM team_members WHERE role = 'admin' AND status = 'active' ORDER BY user_id FOR UPDATE").all();
    const current = await tx.prepare('SELECT user_id, email, role, status, can_approve_source_rights, can_manage_source_legal FROM team_members WHERE user_id = ? LIMIT 1 FOR UPDATE').bind(userId).first<{ user_id: string; email: string; role: string; status: string; can_approve_source_rights: number; can_manage_source_legal: number }>();
    if (!current) return { status: 404 as const, error: '成员不存在。' };
    const nextRole = body.role ?? current.role;
    const next = {
      ...current,
      role: nextRole,
      status: body.status ?? current.status,
      can_approve_source_rights: nextRole === 'admin'
        ? (body.canApproveSourceRights === undefined ? current.can_approve_source_rights : body.canApproveSourceRights ? 1 : 0)
        : 0,
      can_manage_source_legal: nextRole === 'admin'
        ? (body.canManageSourceLegal === undefined ? current.can_manage_source_legal : body.canManageSourceLegal ? 1 : 0)
        : 0,
    };
    if (body.canApproveSourceRights && next.role !== 'admin') return { status: 422 as const, error: '只有 admin 成员可以获得来源权利审批能力。' };
    if (body.canManageSourceLegal && next.role !== 'admin') return { status: 422 as const, error: '只有 admin 成员可以获得来源法律操作能力。' };
    if (current.role === 'admin' && current.status === 'active' && (next.role !== 'admin' || next.status !== 'active')) {
      const count = await tx.prepare("SELECT COUNT(*) AS total FROM team_members WHERE role = 'admin' AND status = 'active'").first<{ total: number }>();
      if (Number(count?.total ?? 0) <= 1) return { status: 409 as const, error: '不能停用或降级最后一名管理员。' };
    }
    const currentRightsApprover = current.role === 'admin' && current.status === 'active' && Boolean(current.can_approve_source_rights);
    const nextRightsApprover = next.role === 'admin' && next.status === 'active' && Boolean(next.can_approve_source_rights);
    if (currentRightsApprover && !nextRightsApprover) {
      const count = await tx.prepare("SELECT COUNT(*) AS total FROM team_members WHERE role = 'admin' AND status = 'active' AND can_approve_source_rights = 1").first<{ total: number }>();
      if (Number(count?.total ?? 0) <= 1) return { status: 409 as const, error: '不能移除最后一名有效来源权利审批者。' };
    }
    const currentLegalOperator = current.role === 'admin' && current.status === 'active' && Boolean(current.can_manage_source_legal);
    const nextLegalOperator = next.role === 'admin' && next.status === 'active' && Boolean(next.can_manage_source_legal);
    if (currentLegalOperator && !nextLegalOperator) {
      const counts = await tx.prepare(`
        SELECT
          (SELECT COUNT(*) FROM team_members
            WHERE role = 'admin' AND status = 'active' AND can_manage_source_legal = 1) AS operators,
          (SELECT COUNT(*) FROM source_legal_holds WHERE status = 'active') AS active_holds,
          (SELECT COUNT(*) FROM source_deletion_requests
            WHERE status NOT IN ('completed')) AS open_deletions
      `).first<{ operators: number; active_holds: number; open_deletions: number }>();
      const operators = Number(counts?.operators ?? 0);
      if (Number(counts?.active_holds ?? 0) > 0 && operators <= 2) {
        return { status: 409 as const, error: '存在 active legal hold，必须保留至少两名有效法律操作人。' };
      }
      if (Number(counts?.open_deletions ?? 0) > 0 && operators <= 1) {
        return { status: 409 as const, error: '存在未完成依法删除，必须保留至少一名有效法律操作人。' };
      }
    }
    await tx.prepare('UPDATE team_members SET role = ?, status = ?, can_approve_source_rights = ?, can_manage_source_legal = ?, updated_at = ? WHERE user_id = ?').bind(next.role, next.status, next.can_approve_source_rights, next.can_manage_source_legal, now, userId).run();
    await tx.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, before_hash, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'member.updated', 'team_member', ?, ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, userId, stableHash(current), stableHash(next), JSON.stringify({ role: next.role, status: next.status, canApproveSourceRights: Boolean(next.can_approve_source_rights), canManageSourceLegal: Boolean(next.can_manage_source_legal) }), crypto.randomUUID(), now).run();
    const ownershipImpact = await reconcileSourceOwnership(tx, actor, new Date(now));
    return {
      status: 200 as const,
      member: { userId, email: current.email, role: next.role, status: next.status, canApproveSourceRights: Boolean(next.can_approve_source_rights), canManageSourceLegal: Boolean(next.can_manage_source_legal) },
      ownershipImpact,
    };
  });
  if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ member: result.member, ownershipImpact: result.ownershipImpact });
}
