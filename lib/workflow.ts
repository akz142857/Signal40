import type { SqlDatabase } from './sql.ts';

export const ROLES = [
  'researcher',
  'editor',
  'producer',
  'publisher',
  'admin',
  'auditor',
] as const;

export type Role = (typeof ROLES)[number];

export const CONTENT_STATES = [
  'DRAFT',
  'RESEARCHING',
  'EVIDENCE_READY',
  'EDITOR_APPROVED',
  'SCRIPT_DRAFT',
  'SCRIPT_APPROVED',
  'ASSETS_READY',
  'RENDER_QUEUED',
  'RENDERING',
  'QC_PENDING',
  'QC_APPROVED',
  'PUBLISH_SCHEDULED',
  'PUBLISHED',
  'MEASURED',
  'CHANGES_REQUESTED',
  'REJECTED',
  'FAILED',
  'CANCELLED',
] as const;

export type ContentState = (typeof CONTENT_STATES)[number];

export type GateCode =
  | 'G0_SOURCE_RIGHTS'
  | 'G1_INPUT_QUALITY'
  | 'G2_AUTO_EVIDENCE'
  | 'G3_MANUAL_RESEARCH'
  | 'G4_SCRIPT_COVERAGE'
  | 'G5_ASSET_RIGHTS'
  | 'G6_CONTENT_TECH_QC'
  | 'G7_PUBLISH_APPROVAL'
  | 'G8_POST_PUBLISH';

export type GateResult = {
  code: GateCode;
  passed: boolean;
  reasons: string[];
};

const transitions: Record<ContentState, readonly ContentState[]> = {
  DRAFT: ['RESEARCHING', 'CANCELLED'],
  RESEARCHING: ['EVIDENCE_READY', 'CHANGES_REQUESTED', 'REJECTED', 'FAILED'],
  EVIDENCE_READY: ['EDITOR_APPROVED', 'CHANGES_REQUESTED', 'REJECTED'],
  EDITOR_APPROVED: ['SCRIPT_DRAFT', 'CHANGES_REQUESTED', 'CANCELLED'],
  SCRIPT_DRAFT: ['SCRIPT_APPROVED', 'CHANGES_REQUESTED', 'REJECTED'],
  SCRIPT_APPROVED: ['ASSETS_READY', 'CHANGES_REQUESTED', 'CANCELLED'],
  ASSETS_READY: ['RENDER_QUEUED', 'CHANGES_REQUESTED', 'CANCELLED'],
  // CHANGES_REQUESTED 是误入 RENDER_QUEUED 后的人工回退路径：
  // 没有它，点错「创建渲染任务」的项目只能靠取消渲染作业绕回去。
  RENDER_QUEUED: ['RENDERING', 'CHANGES_REQUESTED', 'FAILED', 'CANCELLED'],
  RENDERING: ['QC_PENDING', 'FAILED', 'CANCELLED'],
  QC_PENDING: ['QC_APPROVED', 'CHANGES_REQUESTED', 'REJECTED'],
  QC_APPROVED: ['PUBLISH_SCHEDULED', 'CHANGES_REQUESTED', 'CANCELLED'],
  PUBLISH_SCHEDULED: ['PUBLISHED', 'FAILED', 'CANCELLED'],
  PUBLISHED: ['MEASURED', 'CHANGES_REQUESTED'],
  MEASURED: [],
  CHANGES_REQUESTED: ['RESEARCHING', 'SCRIPT_DRAFT', 'ASSETS_READY', 'QC_PENDING', 'CANCELLED'],
  REJECTED: ['RESEARCHING', 'CANCELLED'],
  FAILED: ['RESEARCHING', 'RENDER_QUEUED', 'PUBLISH_SCHEDULED', 'CANCELLED'],
  CANCELLED: [],
};

const transitionRoles: Partial<Record<ContentState, readonly Role[]>> = {
  CHANGES_REQUESTED: ['editor', 'admin'],
  EVIDENCE_READY: ['researcher', 'editor', 'admin'],
  EDITOR_APPROVED: ['editor', 'admin'],
  SCRIPT_APPROVED: ['editor', 'admin'],
  ASSETS_READY: ['producer', 'admin'],
  RENDER_QUEUED: ['producer', 'admin'],
  RENDERING: ['producer', 'admin'],
  QC_PENDING: ['producer', 'admin'],
  QC_APPROVED: ['editor', 'producer', 'admin'],
  PUBLISH_SCHEDULED: ['publisher', 'admin'],
  PUBLISHED: ['publisher', 'admin'],
  MEASURED: ['publisher', 'admin'],
  REJECTED: ['editor', 'publisher', 'admin'],
  CANCELLED: ['editor', 'producer', 'publisher', 'admin'],
};

const requiredGates: Partial<Record<ContentState, readonly GateCode[]>> = {
  EVIDENCE_READY: ['G0_SOURCE_RIGHTS', 'G1_INPUT_QUALITY', 'G2_AUTO_EVIDENCE'],
  EDITOR_APPROVED: ['G3_MANUAL_RESEARCH'],
  SCRIPT_APPROVED: ['G4_SCRIPT_COVERAGE'],
  ASSETS_READY: ['G5_ASSET_RIGHTS'],
  QC_APPROVED: ['G6_CONTENT_TECH_QC'],
  PUBLISH_SCHEDULED: ['G7_PUBLISH_APPROVAL'],
  MEASURED: ['G8_POST_PUBLISH'],
};

/**
 * 正常推进路径上的下一个状态。
 *
 * `transitions` 列的是「允许」的目标（含要求修改、驳回、取消等岔路），
 * 编排引擎和界面还需要知道「顺着走是哪一个」。这张表曾经在编排器和工作台里
 * 各抄一份，两处一旦走偏，自动化推进的状态和界面按钮上写的就不是同一件事。
 */
export const PRIMARY_NEXT_STATE: Partial<Record<ContentState, ContentState>> = {
  DRAFT: 'RESEARCHING',
  RESEARCHING: 'EVIDENCE_READY',
  EVIDENCE_READY: 'EDITOR_APPROVED',
  EDITOR_APPROVED: 'SCRIPT_DRAFT',
  SCRIPT_DRAFT: 'SCRIPT_APPROVED',
  SCRIPT_APPROVED: 'ASSETS_READY',
  ASSETS_READY: 'RENDER_QUEUED',
  QC_PENDING: 'QC_APPROVED',
  QC_APPROVED: 'PUBLISH_SCHEDULED',
  PUBLISHED: 'MEASURED',
};

export const CONTENT_STATE_LABELS: Record<ContentState, string> = {
  DRAFT: '项目草稿',
  RESEARCHING: '研究中',
  EVIDENCE_READY: '证据就绪',
  EDITOR_APPROVED: '研究已批准',
  SCRIPT_DRAFT: '脚本草稿',
  SCRIPT_APPROVED: '脚本已批准',
  ASSETS_READY: '资产就绪',
  RENDER_QUEUED: '等待渲染',
  RENDERING: '渲染中',
  QC_PENDING: '等待质检',
  QC_APPROVED: '终审通过',
  PUBLISH_SCHEDULED: '已排期',
  PUBLISHED: '已发布',
  MEASURED: '已回流',
  CHANGES_REQUESTED: '要求修改',
  REJECTED: '已驳回',
  FAILED: '失败',
  CANCELLED: '已取消',
};

export const GATE_LABELS: Record<GateCode, string> = {
  G0_SOURCE_RIGHTS: '来源授权',
  G1_INPUT_QUALITY: '输入质量',
  G2_AUTO_EVIDENCE: '自动证据',
  G3_MANUAL_RESEARCH: '人工研究复核',
  G4_SCRIPT_COVERAGE: '脚本覆盖',
  G5_ASSET_RIGHTS: '资产版权',
  G6_CONTENT_TECH_QC: '成片与技术质检',
  G7_PUBLISH_APPROVAL: '发布审批',
  G8_POST_PUBLISH: '发布后回流',
};

/** 转换到目标状态允许的角色；返回 null 表示不限角色。 */
export function allowedRolesForState(to: ContentState): readonly Role[] | null {
  return transitionRoles[to] ?? null;
}

/** 转换到目标状态必须通过的门禁。 */
export function requiredGatesForState(to: ContentState): readonly GateCode[] {
  return requiredGates[to] ?? [];
}

export function allowedTransitionsFrom(from: ContentState): readonly ContentState[] {
  return transitions[from];
}

export class WorkflowError extends Error {
  readonly code: 'INVALID_TRANSITION' | 'FORBIDDEN' | 'GATE_FAILED' | 'VERSION_CONFLICT';
  readonly status: number;

  constructor(
    message: string,
    code: 'INVALID_TRANSITION' | 'FORBIDDEN' | 'GATE_FAILED' | 'VERSION_CONFLICT',
    status = code === 'FORBIDDEN' ? 403 : 409,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function assertTransition(input: {
  from: ContentState;
  to: ContentState;
  role: Role;
  gates?: readonly GateResult[];
}) {
  if (!transitions[input.from].includes(input.to)) {
    throw new WorkflowError(
      `不允许从 ${input.from} 转换到 ${input.to}。`,
      'INVALID_TRANSITION',
    );
  }
  const allowedRoles = transitionRoles[input.to];
  if (allowedRoles && !allowedRoles.includes(input.role)) {
    throw new WorkflowError(
      `角色 ${input.role} 无权把内容转换到 ${input.to}。`,
      'FORBIDDEN',
    );
  }
  const gateMap = new Map((input.gates ?? []).map((gate) => [gate.code, gate]));
  const failures = (requiredGates[input.to] ?? []).flatMap((code) => {
    const result = gateMap.get(code);
    return result?.passed ? [] : [result?.reasons.join('；') || `${code} 未通过`];
  });
  if (failures.length) {
    throw new WorkflowError(failures.join('；'), 'GATE_FAILED');
  }
}

export function quoteEtag(version: number) {
  return `"${version}"`;
}

export function parseIfMatch(value: string | null) {
  if (!value) return null;
  const match = /^W\/"(\d+)"$|^"(\d+)"$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1] ?? match[2]);
}

export { stableHash } from './hash.ts';

export type Actor = {
  id: string;
  email: string;
  role: Role;
  /** Source-rights and legal capabilities remain independent from the broad admin role. */
  canApproveSourceRights?: boolean;
  canManageSourceLegal?: boolean;
};

function isLocalRequest(request: Request) {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

/**
 * 身份解析选项。
 *
 * 头名可配是为了脱离 OpenAI Sites 后仍能用：自建部署在前面放一个认证反向代理，
 * 让它注入自己的身份头即可，不用改代码。`allowLocalRoleHeaders` 是本机开发的后门——
 * 生产必须关掉，否则「独立发布人」由前端说了算，G7 的职责分离就不成立。
 */
export type IdentityOptions = {
  bootstrapAdminEmails?: string;
  identityHeaders?: { id: string; email: string };
  allowLocalRoleHeaders?: boolean;
};

export async function resolveActor(
  request: Request,
  db: SqlDatabase,
  options: string | IdentityOptions = '',
): Promise<Actor | null> {
  const settings: IdentityOptions = typeof options === 'string' ? { bootstrapAdminEmails: options } : options;
  const headerNames = settings.identityHeaders ?? { id: 'oai-authenticated-user-id', email: 'oai-authenticated-user-email' };
  if (isLocalRequest(request) && (settings.allowLocalRoleHeaders ?? true)) {
    const requestedRole = request.headers.get('x-signal-role');
    const role = ROLES.includes(requestedRole as Role) ? (requestedRole as Role) : 'admin';
    return {
      id: request.headers.get('x-signal-actor-id') || 'local-developer',
      email: request.headers.get('x-signal-actor-email') || 'local@signal40.test',
      role,
      ...(role === 'admin'
        ? {
            canManageSourceLegal:
              request.headers.get('x-signal-can-manage-source-legal') !== 'false',
          }
        : {}),
    };
  }
  const id = request.headers.get(headerNames.id);
  const email = request.headers.get(headerNames.email)?.trim().toLowerCase();
  if (!id || !email) return null;
  const member = await db.prepare(`
    SELECT role, status, can_approve_source_rights, can_manage_source_legal
    FROM team_members WHERE user_id = ? OR email = ? LIMIT 1
  `).bind(id, email).first<{
    role: Role;
    status: string;
    can_approve_source_rights: number;
    can_manage_source_legal: number;
  }>();
  if (member?.status === 'active' && ROLES.includes(member.role)) {
    return {
      id,
      email,
      role: member.role,
      canApproveSourceRights: Boolean(member.can_approve_source_rights),
      canManageSourceLegal: Boolean(member.can_manage_source_legal),
    };
  }
  const bootstrap = new Set((settings.bootstrapAdminEmails ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!member && bootstrap.has(email)) {
    const now = new Date().toISOString();
    await db.prepare("INSERT INTO team_members (user_id, email, role, status, created_at, updated_at) VALUES (?, ?, 'admin', 'active', ?, ?)").bind(id, email, now, now).run();
    return {
      id,
      email,
      role: 'admin',
      canApproveSourceRights: false,
      canManageSourceLegal: false,
    };
  }
  return null;
}
