import { db, resolveRequestActor } from '@/lib/runtime';
import {
  loadAutomationPolicy,
  resolveAuthorizedMember,
  serializeAutomationPolicy,
  validateAutomationPolicy,
  type AutomationPolicy,
} from '@/lib/automation';
import { stableHash } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看自动化策略。' }, { status: 403 });
  const { id } = await context.params;
  const policy = await loadAutomationPolicy(db, id);
  if (!policy) return Response.json({ error: '策略不存在。' }, { status: 404 });
  return Response.json({ policy });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以修改自动化策略。' }, { status: 403 });
  let body: Partial<AutomationPolicy>;
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const { id } = await context.params;
  const current = await loadAutomationPolicy(db, id);
  if (!current) return Response.json({ error: '策略不存在。' }, { status: 404 });
  const now = new Date();
  const next: AutomationPolicy = {
    ...current,
    ...body,
    id: current.id,
    version: current.version + 1,
    scope: { ...current.scope, ...body.scope },
    stages: { ...current.stages, ...body.stages },
    autoApprovals: { ...current.autoApprovals, ...body.autoApprovals },
    guardrails: { ...current.guardrails, ...body.guardrails, quietHoursUtc: { ...current.guardrails.quietHoursUtc, ...body.guardrails?.quietHoursUtc } },
  };
  const validation = validateAutomationPolicy(next, now);
  const problems = [...validation.errors];
  const needsResearch = next.autoApprovals.research.enabled || next.autoApprovals.script.enabled || next.autoApprovals.qc.enabled;
  if (needsResearch && !(await resolveAuthorizedMember(db, next.researchAuthorizedBy, 'research'))) problems.push('research_authorized_by 必须是 active 且具备编辑或管理员角色的成员。');
  if (next.autoApprovals.publish.enabled && !(await resolveAuthorizedMember(db, next.publishAuthorizedBy, 'publish'))) problems.push('publish_authorized_by 必须是 active 且具备发布者或管理员角色的成员。');
  if (problems.length) return Response.json({ error: '策略无效。', issues: problems }, { status: 422 });
  const columns = serializeAutomationPolicy(next);
  const timestamp = now.toISOString();
  await db.batch([
    db.prepare(`
      UPDATE automation_policies SET name = ?, scope_json = ?, stages_json = ?, auto_approvals_json = ?,
        research_authorized_by = ?, publish_authorized_by = ?, guardrails_json = ?, authorized_at = ?,
        expires_at = ?, enabled = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(next.name, columns.scopeJson, columns.stagesJson, columns.autoApprovalsJson, next.researchAuthorizedBy, next.publishAuthorizedBy, columns.guardrailsJson, next.enabled ? (current.authorizedAt ?? timestamp) : null, next.expiresAt, next.enabled ? 1 : 0, timestamp, id, current.version),
    db.prepare(`
      INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, before_hash, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'automation_policy.updated', 'automation_policy', ?, ?, ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash(current), stableHash(next), JSON.stringify({ enabled: next.enabled, stages: next.stages, autoApprovals: next.autoApprovals, expiresAt: next.expiresAt }), crypto.randomUUID(), timestamp),
  ]);
  return Response.json({ policy: await loadAutomationPolicy(db, id) });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以删除自动化策略。' }, { status: 403 });
  const { id } = await context.params;
  const timestamp = new Date().toISOString();
  const [deleted] = await db.batch([
    db.prepare('DELETE FROM automation_policies WHERE id = ?').bind(id),
    // 策略没了，挂在它名下的项目回到人工，而不是悄悄换一条策略继续跑。
    db.prepare("UPDATE content_projects SET automation_mode = 'manual', automation_paused_reason = '所属自动化策略已删除。', automation_policy_id = NULL WHERE automation_policy_id = ?").bind(id),
    db.prepare(`
      INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'automation_policy.deleted', 'automation_policy', ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, JSON.stringify({}), crypto.randomUUID(), timestamp),
  ]);
  if (!deleted.meta.changes) return Response.json({ error: '策略不存在。' }, { status: 404 });
  return Response.json({ deleted: true });
}
