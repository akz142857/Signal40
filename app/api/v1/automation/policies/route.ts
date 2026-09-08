import { db, resolveRequestActor } from '@/lib/runtime';
import {
  defaultAutomationPolicy,
  listAutomationPolicies,
  resolveAuthorizedMember,
  serializeAutomationPolicy,
  validateAutomationPolicy,
  type AutomationPolicy,
} from '@/lib/automation';
import { stableHash } from '@/lib/workflow';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看自动化策略。' }, { status: 403 });
  // 成本按策略归集：预算烧在哪条策略上，看这一张表就够了，不用去翻作业。
  const costs = await db
    .prepare(`
      SELECT cp.automation_policy_id AS policy_id,
        COUNT(DISTINCT cp.id) AS project_count,
        COALESCE(SUM(CASE WHEN j.cost_micros > 0 THEN j.cost_micros ELSE j.estimated_cost_micros END), 0) AS cost_micros
      FROM content_projects cp LEFT JOIN jobs j ON j.project_id = cp.id AND j.created_at >= ?
      WHERE cp.automation_policy_id IS NOT NULL
      GROUP BY cp.automation_policy_id
    `)
    .bind(new Date(Date.now() - 30 * 86_400_000).toISOString())
    .all<{ policy_id: string; project_count: number; cost_micros: number }>();
  return Response.json({
    policies: await listAutomationPolicies(db),
    defaults: defaultAutomationPolicy(),
    costs: Object.fromEntries(costs.results.map((row) => [row.policy_id, { projectCount: Number(row.project_count), costMicros: Number(row.cost_micros) }])),
  });
}

/** 策略里的两个授权人必须是真实、在职、角色够格且互不相同的成员——这里就要挡住。 */
async function validateAuthorizers(policy: AutomationPolicy) {
  const problems: string[] = [];
  const needsResearch = policy.autoApprovals.research.enabled || policy.autoApprovals.script.enabled || policy.autoApprovals.qc.enabled;
  if (needsResearch && !(await resolveAuthorizedMember(db, policy.researchAuthorizedBy, 'research'))) problems.push('research_authorized_by 必须是 active 且具备编辑或管理员角色的成员。');
  if (policy.autoApprovals.publish.enabled && !(await resolveAuthorizedMember(db, policy.publishAuthorizedBy, 'publish'))) problems.push('publish_authorized_by 必须是 active 且具备发布者或管理员角色的成员。');
  return problems;
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以创建自动化策略。' }, { status: 403 });
  let body: Partial<AutomationPolicy> & { name?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const now = new Date();
  const policy: AutomationPolicy = {
    ...defaultAutomationPolicy(),
    ...body,
    scope: { ...defaultAutomationPolicy().scope, ...body.scope },
    stages: { ...defaultAutomationPolicy().stages, ...body.stages },
    autoApprovals: { ...defaultAutomationPolicy().autoApprovals, ...body.autoApprovals },
    guardrails: { ...defaultAutomationPolicy().guardrails, ...body.guardrails, quietHoursUtc: { ...defaultAutomationPolicy().guardrails.quietHoursUtc, ...body.guardrails?.quietHoursUtc } },
    id: `policy_${crypto.randomUUID()}`,
    name: (body.name ?? '').trim(),
    version: 1,
  };
  const validation = validateAutomationPolicy(policy, now);
  const authorizerProblems = await validateAuthorizers(policy);
  if (!validation.valid || authorizerProblems.length) return Response.json({ error: '策略无效。', issues: [...validation.errors, ...authorizerProblems] }, { status: 422 });
  const columns = serializeAutomationPolicy(policy);
  const timestamp = now.toISOString();
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO automation_policies
          (id, name, scope_json, stages_json, auto_approvals_json, research_authorized_by, publish_authorized_by,
           guardrails_json, authorized_at, expires_at, enabled, version, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
      `).bind(policy.id, policy.name, columns.scopeJson, columns.stagesJson, columns.autoApprovalsJson, policy.researchAuthorizedBy, policy.publishAuthorizedBy, columns.guardrailsJson, policy.enabled ? timestamp : null, policy.expiresAt, policy.enabled ? 1 : 0, actor.id, timestamp, timestamp),
      db.prepare(`
        INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
        VALUES (?, ?, ?, 'automation_policy.created', 'automation_policy', ?, ?, ?, ?, ?)
      `).bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, policy.id, stableHash(policy), JSON.stringify({ name: policy.name, enabled: policy.enabled, expiresAt: policy.expiresAt }), crypto.randomUUID(), timestamp),
    ]);
  } catch {
    return Response.json({ error: '策略名称已存在或写入失败。' }, { status: 409 });
  }
  return Response.json({ policy }, { status: 201 });
}
