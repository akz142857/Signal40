import type { Actor } from './workflow.ts';

export const SOURCE_ACTION_ROLES = {
  'source.read': ['researcher', 'editor', 'producer', 'publisher', 'admin', 'auditor'],
  'source.run.request': ['researcher', 'editor', 'admin'],
  'source.create': ['admin'],
  'source.update': ['admin'],
  'source.test': ['admin'],
  'source.backfill.request': ['admin'],
  'source.backfill.estimate': ['researcher', 'admin'],
  'source.enable': ['admin'],
  'source.ownership.manage': ['admin'],
  'source.rights.decide': ['admin'],
  'source.archive': ['admin'],
  /** 硬删除仅限没有任何采集内容的来源；有内容的走 source.legal-delete。 */
  'source.delete': ['admin'],
  'source.withdraw': ['admin'],
  'source.legal-delete': ['admin'],
  'source.legal-hold.create': ['admin'],
  'source.legal-hold.release': ['admin'],
  'source.checkpoint.request': ['admin'],
  'source.checkpoint.decide': ['admin'],
  'source.quarantine.manage': ['admin'],
  'connector.release.manage': ['admin'],
  'source.governance.read': ['admin', 'auditor'],
  'source.evidence.read': ['researcher', 'editor', 'admin', 'auditor'],
  'source.evidence.manage': ['admin'],
  'source.evidence.correct': ['editor', 'admin'],
  'source.proposal.create': ['researcher', 'editor'],
  'source.proposal.read': ['researcher', 'editor', 'admin', 'auditor'],
  'source.proposal.decide': ['admin'],
} as const;

export type SourceAction = keyof typeof SOURCE_ACTION_ROLES;

type AuthorizationContext = {
  requestedBy?: string | null;
  createdBy?: string | null;
  requestActorId?: string | null;
};

export function sourceActionAllowed(
  actor: Actor | null,
  action: SourceAction,
  context: AuthorizationContext = {},
) {
  if (!actor) return false;
  const roles = SOURCE_ACTION_ROLES[action] as readonly string[];
  if (!roles.includes(actor.role)) return false;
  if (
    ['source.legal-delete', 'source.legal-hold.create', 'source.legal-hold.release'].includes(action) &&
    !actor.canManageSourceLegal
  ) return false;
  if (action === 'source.proposal.read' && ['researcher', 'editor'].includes(actor.role)) {
    return context.requestedBy === actor.id;
  }
  // 职责分离（提案、权利、legal hold 解除、检查点切换必须由另一个人批准）已按
  // 单人运营的决定移除：这套系统现在的使用场景是一个人从头跑到尾，第二个签字人
  // 只能是同一个人的第二个账号，挡不住任何东西，却让整条流程在界面上走不通。
  // 审计仍然记录每一次批准是谁在什么时候做的——去掉的是「必须是两个人」，
  // 不是「记录是谁」。要恢复成编辑部模式，在这里和 lib/control-plane.ts 的 G7、
  // lib/automation.ts 的授权人校验三处一起加回来。
  if (action === 'source.proposal.decide') return Boolean(context.requestedBy);
  if (action === 'source.rights.decide') return Boolean(context.requestedBy);
  if (action === 'source.legal-hold.release' && context.createdBy !== undefined) {
    return Boolean(context.createdBy);
  }
  if (action === 'source.checkpoint.decide') return Boolean(context.requestActorId);
  return true;
}
