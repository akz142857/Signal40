import type { SqlDatabase } from './sql.ts';
import type { GateResult, Role } from './workflow.ts';

/**
 * 自动化策略：哪些阶段自动、哪几道审批可以预先授权、依据谁的身份放行、护栏是什么。
 *
 * 两条硬性约束写在这里，而不是留给界面自觉：
 *
 * 1. **职责分离**：G7 判定的是发布批准人与研究批准人的 `actor_id` 不同。
 *    同一个人同时自动放行研究与发布，这条约束就形同虚设，
 *    所以 `researchAuthorizedBy` 与 `publishAuthorizedBy` 必须是不同的真实成员；
 * 2. **默认不放行**：四道问责门禁（G3/G4/G6/G7）默认 `manual`，发布审批
 *    即使显式开启也要同时满足全部条件、日限额与静默时段。
 *
 * 预先授权是可撤销、有范围、有有效期的：`expires_at` 一过就自动转人工，
 * 不需要人记得去关。
 */

/** 编排引擎划分的阶段。前六个是机械步骤，四道审批单独由 `autoApprovals` 控制。 */
export const AUTOMATION_STAGES = [
  'ingestion',
  'topic_quality',
  'project_creation',
  'advance',
  'jobs',
  'publish',
  'metrics',
] as const;

export type AutomationStage = (typeof AUTOMATION_STAGES)[number];
export type StageMode = 'auto' | 'manual' | 'off';
export const STAGE_MODES = ['auto', 'manual', 'off'] as const;

export type ApprovalKind = 'research' | 'script' | 'qc' | 'publish';

export type AutomationPolicy = {
  id: string;
  name: string;
  scope: {
    brands: string[];
    locales: string[];
    /** 选题必须至少包含这些来源类型之一；空表示不限。 */
    sourceTypes: string[];
    minTopicScore: number;
    requireTopicQuality: boolean;
  };
  stages: Record<AutomationStage, StageMode>;
  autoApprovals: Record<ApprovalKind, { enabled: boolean }>;
  researchAuthorizedBy: string | null;
  publishAuthorizedBy: string | null;
  guardrails: {
    dailyProjectLimit: number;
    dailyPublishLimit: number;
    /** UTC 小时区间 [start, end)，落在区间内不做发布类自动动作；start===end 表示不设静默。 */
    quietHoursUtc: { start: number; end: number };
    maxCostMicrosPerProject: number;
    minIndependentSources: number;
  };
  authorizedAt: string | null;
  expiresAt: string | null;
  enabled: boolean;
  version: number;
};

/** 角色要求：自动放行写入的是真人身份，那个人必须真的有权做这道审批。 */
export const APPROVAL_ROLES: Record<ApprovalKind, Role[]> = {
  research: ['editor', 'admin'],
  script: ['editor', 'admin'],
  qc: ['editor', 'producer', 'admin'],
  publish: ['publisher', 'admin'],
};

/**
 * 默认策略：机械步骤自动，四道审批人工，自动建项目关闭。
 * 自动建项目要等选题质量指标达标后再由人显式打开（见 `lib/topic-quality.ts`）。
 */
export function defaultAutomationPolicy(): Omit<AutomationPolicy, 'id' | 'name' | 'version'> {
  return {
    scope: { brands: [], locales: [], sourceTypes: [], minTopicScore: 60, requireTopicQuality: true },
    stages: {
      ingestion: 'auto',
      topic_quality: 'auto',
      project_creation: 'off',
      advance: 'auto',
      jobs: 'auto',
      publish: 'manual',
      metrics: 'auto',
    },
    autoApprovals: { research: { enabled: false }, script: { enabled: false }, qc: { enabled: false }, publish: { enabled: false } },
    researchAuthorizedBy: null,
    publishAuthorizedBy: null,
    guardrails: {
      dailyProjectLimit: 3,
      dailyPublishLimit: 1,
      quietHoursUtc: { start: 0, end: 0 },
      maxCostMicrosPerProject: 0,
      minIndependentSources: 2,
    },
    authorizedAt: null,
    expiresAt: null,
    enabled: false,
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

export type AutomationPolicyRow = {
  id: string;
  name: string;
  scope_json: unknown;
  stages_json: unknown;
  auto_approvals_json: unknown;
  research_authorized_by: string | null;
  publish_authorized_by: string | null;
  guardrails_json: unknown;
  authorized_at: string | null;
  expires_at: string | null;
  enabled: number;
  version: number;
};

export function parseAutomationPolicy(row: AutomationPolicyRow): AutomationPolicy {
  const defaults = defaultAutomationPolicy();
  const guardrails = parseJson<Partial<AutomationPolicy['guardrails']>>(row.guardrails_json, {});
  return {
    id: row.id,
    name: row.name,
    scope: { ...defaults.scope, ...parseJson(row.scope_json, {}) },
    stages: { ...defaults.stages, ...parseJson(row.stages_json, {}) },
    autoApprovals: { ...defaults.autoApprovals, ...parseJson(row.auto_approvals_json, {}) },
    researchAuthorizedBy: row.research_authorized_by,
    publishAuthorizedBy: row.publish_authorized_by,
    guardrails: {
      ...defaults.guardrails,
      ...guardrails,
      quietHoursUtc: { ...defaults.guardrails.quietHoursUtc, ...guardrails.quietHoursUtc },
    },
    authorizedAt: row.authorized_at,
    expiresAt: row.expires_at,
    enabled: Number(row.enabled) === 1,
    version: Number(row.version ?? 1),
  };
}

export function serializeAutomationPolicy(policy: AutomationPolicy) {
  return {
    scopeJson: JSON.stringify(policy.scope),
    stagesJson: JSON.stringify(policy.stages),
    autoApprovalsJson: JSON.stringify(policy.autoApprovals),
    guardrailsJson: JSON.stringify(policy.guardrails),
  };
}

/**
 * 策略校验。除了取值范围，这里强制两条规则：
 * 自动放行必须指定授权人，且研究类与发布类授权人不能是同一个人。
 */
export function validateAutomationPolicy(policy: AutomationPolicy, now = new Date()) {
  const errors: string[] = [];
  if (!policy.name.trim() || policy.name.length > 80) errors.push('策略名称必须是 1–80 个字符。');
  for (const stage of AUTOMATION_STAGES) {
    if (!STAGE_MODES.includes(policy.stages[stage])) errors.push(`阶段 ${stage} 的模式必须是 auto、manual 或 off。`);
  }
  const { guardrails } = policy;
  if (!Number.isInteger(guardrails.dailyProjectLimit) || guardrails.dailyProjectLimit < 0 || guardrails.dailyProjectLimit > 100) errors.push('每日自动建项目上限必须是 0–100 的整数。');
  if (!Number.isInteger(guardrails.dailyPublishLimit) || guardrails.dailyPublishLimit < 0 || guardrails.dailyPublishLimit > 100) errors.push('每日自动发布上限必须是 0–100 的整数。');
  if (!Number.isInteger(guardrails.maxCostMicrosPerProject) || guardrails.maxCostMicrosPerProject < 0) errors.push('单条成本上限必须是非负整数。');
  if (!Number.isInteger(guardrails.minIndependentSources) || guardrails.minIndependentSources < 2) errors.push('最低独立来源数不得低于 2。');
  for (const bound of [guardrails.quietHoursUtc.start, guardrails.quietHoursUtc.end]) {
    if (!Number.isInteger(bound) || bound < 0 || bound > 23) errors.push('静默时段必须是 0–23 的整数小时（UTC）。');
  }
  if (!Number.isInteger(policy.scope.minTopicScore) || policy.scope.minTopicScore < 0 || policy.scope.minTopicScore > 100) errors.push('选题分数下限必须是 0–100 的整数。');
  if (policy.scope.sourceTypes.some((type) => !['social', 'media', 'market', 'filing', 'company'].includes(type))) errors.push('来源类型只能是 social、media、market、filing、company。');
  if (policy.expiresAt && Number.isNaN(new Date(policy.expiresAt).valueOf())) errors.push('expiresAt 不是合法时间。');
  if (policy.expiresAt && new Date(policy.expiresAt).valueOf() <= now.valueOf()) errors.push('预先授权的有效期必须晚于当前时间。');

  const autoResearchKinds = (['research', 'script', 'qc'] as const).filter((kind) => policy.autoApprovals[kind].enabled);
  if (autoResearchKinds.length && !policy.researchAuthorizedBy) errors.push('开启研究、脚本或终审自动放行时必须指定 research_authorized_by。');
  if (policy.autoApprovals.publish.enabled && !policy.publishAuthorizedBy) errors.push('开启发布自动放行时必须指定 publish_authorized_by。');
  if (policy.researchAuthorizedBy && policy.publishAuthorizedBy && policy.researchAuthorizedBy === policy.publishAuthorizedBy) {
    errors.push('研究类与发布类自动授权人必须是不同的真实成员，否则 G7 的职责分离形同虚设。');
  }
  if ((autoResearchKinds.length || policy.autoApprovals.publish.enabled) && !policy.expiresAt) {
    errors.push('自动放行必须设置预先授权有效期（expiresAt）。');
  }
  return { valid: errors.length === 0, errors };
}

/** 授权人必须是在 `team_members` 里、状态 active、且角色能做这道审批的真人。 */
export async function resolveAuthorizedMember(
  db: SqlDatabase,
  userId: string | null,
  kind: ApprovalKind,
): Promise<{ id: string; email: string; role: Role } | null> {
  if (!userId) return null;
  const member = await db
    .prepare("SELECT user_id, email, role FROM team_members WHERE user_id = ? AND status = 'active' LIMIT 1")
    .bind(userId)
    .first<{ user_id: string; email: string; role: Role }>();
  if (!member || !APPROVAL_ROLES[kind].includes(member.role)) return null;
  return { id: member.user_id, email: member.email, role: member.role };
}

export function isPolicyActive(policy: AutomationPolicy, now = new Date()) {
  if (!policy.enabled) return { active: false, reason: '策略未启用。' };
  if (policy.expiresAt && new Date(policy.expiresAt).valueOf() <= now.valueOf()) return { active: false, reason: '预先授权已过期，已转人工。' };
  return { active: true, reason: '' };
}

export function stageMode(policy: AutomationPolicy, stage: AutomationStage): StageMode {
  return policy.stages[stage] ?? 'manual';
}

export function inQuietHours(policy: AutomationPolicy, now = new Date()) {
  const { start, end } = policy.guardrails.quietHoursUtc;
  if (start === end) return false;
  const hour = now.getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function policyMatchesProject(policy: AutomationPolicy, project: { brand: string; locale: string }) {
  if (policy.scope.brands.length && !policy.scope.brands.includes(project.brand)) return false;
  if (policy.scope.locales.length && !policy.scope.locales.includes(project.locale)) return false;
  return true;
}

export function policyMatchesTopic(
  policy: AutomationPolicy,
  topic: { score: number; sourceTypes?: readonly string[]; quality?: { automatable?: boolean } | null },
) {
  if (topic.score < policy.scope.minTopicScore) return false;
  if (policy.scope.requireTopicQuality && !topic.quality?.automatable) return false;
  if (policy.scope.sourceTypes.length && !(topic.sourceTypes ?? []).some((type) => policy.scope.sourceTypes.includes(type))) return false;
  return true;
}

export type AutoApprovalContext = {
  gates: readonly GateResult[];
  independentSourceCount: number;
  unresolvedConflicts: number;
  scriptDurationOk: boolean;
  /** 脚本表达合规（无违禁表述、免责声明完整）；不通过的原因一并带上。 */
  scriptCompliance: { passed: boolean; reasons: string[] };
  /** 选题质量指标是否达标；策略要求时作为 G3 自动放行的前置条件。 */
  topicQualityOk: boolean;
  qcPassed: boolean;
  dailyPublishCount: number;
  now: Date;
};

/**
 * 单道审批能不能自动放行。任何一条不满足就转人工——
 * 调用方只需要判断 `allowed`，`reasons` 直接进待办箱。
 */
export function autoApprovalDecision(
  policy: AutomationPolicy,
  kind: ApprovalKind,
  context: AutoApprovalContext,
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const active = isPolicyActive(policy, context.now);
  if (!active.active) reasons.push(active.reason);
  if (!policy.autoApprovals[kind].enabled) reasons.push(`策略未开启 ${kind} 自动放行。`);
  const gate = (code: string) => context.gates.find((item) => item.code === code);
  if (kind === 'research') {
    if (context.independentSourceCount < policy.guardrails.minIndependentSources) reasons.push(`独立来源数 ${context.independentSourceCount} 低于策略要求的 ${policy.guardrails.minIndependentSources}。`);
    if (context.unresolvedConflicts > 0) reasons.push(`仍有 ${context.unresolvedConflicts} 条未解决的反驳证据。`);
    if (!gate('G2_AUTO_EVIDENCE')?.passed) reasons.push('G2 自动证据门禁未通过。');
    if (policy.scope.requireTopicQuality && !context.topicQualityOk) reasons.push('选题质量指标未达标，不自动放行研究审批。');
  }
  if (kind === 'script') {
    const coverage = gate('G4_SCRIPT_COVERAGE');
    const uncovered = (coverage?.reasons ?? []).filter((reason) => reason.includes('未被脚本覆盖'));
    if (uncovered.length) reasons.push(`仍有 ${uncovered.length} 条声明未被脚本覆盖。`);
    if (!context.scriptDurationOk) reasons.push('预计旁白时长不在目标时长的 60%–110% 区间内。');
    if (!context.scriptCompliance.passed) reasons.push(...context.scriptCompliance.reasons);
  }
  if (kind === 'qc') {
    if (!context.qcPassed) reasons.push('自动 QC 未全部通过。');
  }
  if (kind === 'publish') {
    if (!policy.publishAuthorizedBy || policy.publishAuthorizedBy === policy.researchAuthorizedBy) reasons.push('发布授权人缺失或与研究授权人相同，职责分离不成立。');
    if (!context.qcPassed) reasons.push('自动 QC 未全部通过。');
    if (!gate('G6_CONTENT_TECH_QC')?.passed) reasons.push('G6 未通过。');
    if (context.dailyPublishCount >= policy.guardrails.dailyPublishLimit) reasons.push(`当日自动发布量已达上限 ${policy.guardrails.dailyPublishLimit}。`);
    if (inQuietHours(policy, context.now)) reasons.push('当前处于静默时段，不做自动发布。');
  }
  return { allowed: reasons.length === 0, reasons };
}

export async function listAutomationPolicies(db: SqlDatabase) {
  const result = await db
    .prepare(`
      SELECT id, name, scope_json, stages_json, auto_approvals_json, research_authorized_by,
             publish_authorized_by, guardrails_json, authorized_at, expires_at, enabled, version
      FROM automation_policies ORDER BY updated_at DESC LIMIT 100
    `)
    .all<AutomationPolicyRow>();
  return result.results.map(parseAutomationPolicy);
}

export async function loadAutomationPolicy(db: SqlDatabase, id: string) {
  const row = await db
    .prepare(`
      SELECT id, name, scope_json, stages_json, auto_approvals_json, research_authorized_by,
             publish_authorized_by, guardrails_json, authorized_at, expires_at, enabled, version
      FROM automation_policies WHERE id = ? LIMIT 1
    `)
    .bind(id)
    .first<AutomationPolicyRow>();
  return row ? parseAutomationPolicy(row) : null;
}

/** 启用中且未过期的策略，按名称排序，供编排引擎选取。 */
export async function activeAutomationPolicies(db: SqlDatabase, now = new Date()) {
  const policies = await listAutomationPolicies(db);
  return policies.filter((policy) => isPolicyActive(policy, now).active).sort((left, right) => left.name.localeCompare(right.name));
}
