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
  if (action === 'source.proposal.decide') {
    return Boolean(context.requestedBy && context.requestedBy !== actor.id);
  }
  if (action === 'source.rights.decide') {
    return Boolean(context.requestedBy && context.requestedBy !== actor.id);
  }
  if (action === 'source.legal-hold.release' && context.createdBy !== undefined) {
    return Boolean(context.createdBy && context.createdBy !== actor.id);
  }
  if (action === 'source.checkpoint.decide') {
    return Boolean(context.requestActorId && context.requestActorId !== actor.id);
  }
  return true;
}
