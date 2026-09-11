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
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  // 成本按作业创建时的策略快照归集；项目后来换策略不会改写历史账单。
  const [costs, projects, activity] = await Promise.all([
    db
    .prepare(`
      SELECT automation_policy_id AS policy_id,
        COALESCE(SUM(CASE WHEN cost_micros > 0 THEN cost_micros ELSE estimated_cost_micros END), 0) AS cost_micros
      FROM jobs WHERE automation_policy_id IS NOT NULL AND created_at >= ?
      GROUP BY automation_policy_id
    `)
      .bind(since)
      .all<{ policy_id: string; cost_micros: number }>(),
    // 项目数和成本并排显示成「近 30 天」，所以两条查询必须用同一个时间窗，
    // 否则一个是 30 天、一个是全时段，看的人无从分辨。
    db.prepare('SELECT automation_policy_id AS policy_id, COUNT(*) AS project_count FROM content_projects WHERE automation_policy_id IS NOT NULL AND created_at >= ? GROUP BY automation_policy_id').bind(since).all<{ policy_id: string; project_count: number }>(),
    db.prepare(`
      SELECT COALESCE(metadata_json ->> 'trigger', 'human') AS trigger, COUNT(*) AS total
      FROM audit_events WHERE created_at >= ? GROUP BY COALESCE(metadata_json ->> 'trigger', 'human')
    `).bind(since).all<{ trigger: string; total: number }>(),
  ]);
  const costByPolicy = new Map(costs.results.map((row) => [row.policy_id, Number(row.cost_micros)]));
  const projectByPolicy = new Map(projects.results.map((row) => [row.policy_id, Number(row.project_count)]));
  const policyIds = new Set([...costByPolicy.keys(), ...projectByPolicy.keys()]);
  return Response.json({
    policies: await listAutomationPolicies(db),
    defaults: defaultAutomationPolicy(),
    costs: Object.fromEntries([...policyIds].map((id) => [id, { projectCount: projectByPolicy.get(id) ?? 0, costMicros: costByPolicy.get(id) ?? 0 }])),
    // 只有显式写了 trigger 的审计事件才能分辨来源，其余（worker 写的作业完成、
    // 采集提交等）既不是自动化也不是人工，所以这里只分「自动化」与「其余」，
    // 不把没有标注的一律算成人工——那会让自动化占比系统性偏低。
    activity: {
      automated: Number(activity.results.find((row) => row.trigger === 'automation')?.total ?? 0),
      other: activity.results.filter((row) => row.trigger !== 'automation').reduce((sum, row) => sum + Number(row.total), 0),
      since,
    },
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
