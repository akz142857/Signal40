import {
  allowedRolesForState,
  CONTENT_STATE_LABELS,
  GATE_LABELS,
  PRIMARY_NEXT_STATE,
  requiredGatesForState,
  type ContentState,
  type GateCode,
  type GateResult,
  type Role,
} from './workflow.ts';

/**
 * 项目工作台上的「下一步」。
 *
 * 状态机、门禁和角色都是现成的，问题在于它们分散在三处：状态名在标题栏，
 * 门禁在右侧卡片，角色只在服务端拒绝时才出现。人看到的是一个推不动的按钮，
 * 看不到推不动的原因。这里把同一批数据合成一句话：下一步是什么、该谁做、
 * 还差哪道门禁、当前身份能不能动手。
 *
 * 判断标准全部来自 `workflow.ts`，不新增门禁，也不放宽任何一条。
 */

export type ProjectNextStep = {
  /** 顺着流程的下一个状态；等待机器完成时为 null。 */
  targetState: ContentState | null;
  title: string;
  detail: string;
  /** 允许执行这步的角色；null 表示不限角色。 */
  roles: readonly Role[] | null;
  blockedGates: { code: GateCode; label: string; reasons: string[] }[];
  /** 当前身份此刻能否推进：角色对得上且门禁全过。 */
  actorCanAct: boolean;
  /** 这一步在等机器（Worker/编排引擎），不是在等人。 */
  waitingOnMachine: boolean;
};

const ROLE_LABELS: Record<Role, string> = {
  researcher: '研究员',
  editor: '编辑',
  producer: '制作',
  publisher: '发布者',
  admin: '管理员',
  auditor: '审计',
};

/** 等待机器完成的状态：这些状态下人不需要做任何事，催也没用。 */
const MACHINE_WAIT_DETAIL: Partial<Record<ContentState, string>> = {
  RENDER_QUEUED: '渲染作业已入队，等待 Render Worker 领取。没有在线 Worker 时作业会一直排队。',
  RENDERING: '渲染进行中，完成后自动进入等待质检。',
  PUBLISH_SCHEDULED: '已排期，发布作业由 Worker 执行；也可以在这里直接生成发布包或上传。',
};

const TERMINAL_DETAIL: Partial<Record<ContentState, string>> = {
  MEASURED: '指标已回流，这个项目走完了全流程。',
  CANCELLED: '项目已取消，不会再推进。',
};

const RECOVERY_DETAIL: Partial<Record<ContentState, string>> = {
  CHANGES_REQUESTED: '已要求修改：按批注改完后，回到研究、脚本、资产或质检中对应的那一步重新提交。',
  REJECTED: '已驳回：需要重新研究后才能再次推进。',
  FAILED: '上一步失败：修复原因后可以从研究、渲染或发布重新发起。',
};

export function describeRoles(roles: readonly Role[] | null) {
  if (!roles?.length) return '任何有权限的成员';
  return roles.map((role) => ROLE_LABELS[role]).join(' / ');
}

export function projectNextStep(input: {
  state: ContentState;
  gates: readonly GateResult[];
  role: Role | null;
}): ProjectNextStep {
  const machineDetail = MACHINE_WAIT_DETAIL[input.state];
  const terminalDetail = TERMINAL_DETAIL[input.state];
  const recoveryDetail = RECOVERY_DETAIL[input.state];
  const target = PRIMARY_NEXT_STATE[input.state] ?? null;

  if (terminalDetail) {
    return {
      targetState: null,
      title: CONTENT_STATE_LABELS[input.state],
      detail: terminalDetail,
      roles: null,
      blockedGates: [],
      actorCanAct: false,
      waitingOnMachine: false,
    };
  }

  if (machineDetail && !target) {
    return {
      targetState: null,
      title: CONTENT_STATE_LABELS[input.state],
      detail: machineDetail,
      roles: null,
      blockedGates: [],
      actorCanAct: false,
      waitingOnMachine: true,
    };
  }

  if (!target) {
    return {
      targetState: null,
      title: CONTENT_STATE_LABELS[input.state],
      detail: recoveryDetail ?? '当前状态没有可以直接推进的下一步。',
      roles: null,
      blockedGates: [],
      actorCanAct: false,
      waitingOnMachine: false,
    };
  }

  const gateMap = new Map(input.gates.map((gate) => [gate.code, gate]));
  const blockedGates = requiredGatesForState(target)
    .filter((code) => !gateMap.get(code)?.passed)
    .map((code) => ({
      code,
      label: GATE_LABELS[code],
      reasons: gateMap.get(code)?.reasons ?? [`${code} 尚未评估`],
    }));
  const roles = allowedRolesForState(target);
  const roleAllowed = !roles || (input.role ? roles.includes(input.role) : false);

  const detailParts = [`推进到「${CONTENT_STATE_LABELS[target]}」，由${describeRoles(roles)}执行。`];
  if (blockedGates.length) {
    detailParts.push(
      `还差门禁：${blockedGates.map((gate) => `${gate.label}（${gate.reasons.join('；')}）`).join('；')}`,
    );
  } else if (!roleAllowed) {
    detailParts.push('门禁已全部通过，但当前身份没有执行这一步的权限。');
  }

  return {
    targetState: target,
    title: `下一步：${CONTENT_STATE_LABELS[target]}`,
    detail: detailParts.join(' '),
    roles,
    blockedGates,
    actorCanAct: roleAllowed && blockedGates.length === 0,
    waitingOnMachine: false,
  };
}
