import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_ACTION_ROLES,
  sourceActionAllowed,
  type SourceAction,
} from '../lib/source-authorization.ts';
import type { Role } from '../lib/workflow.ts';

const roles: Role[] = ['researcher', 'editor', 'producer', 'publisher', 'admin', 'auditor'];

void test('source action matrix is exhaustive and auditors never receive writes', () => {
  assert.ok(Object.keys(SOURCE_ACTION_ROLES).length >= 20);
  for (const [action, allowedRoles] of Object.entries(SOURCE_ACTION_ROLES)) {
    for (const role of roles) {
      const actor = {
        id: `${role}-1`,
        email: `${role}@signal40.test`,
        role,
        ...(role === 'admin' ? { canManageSourceLegal: true } : {}),
      };
      const context = action === 'source.proposal.read'
        ? { requestedBy: actor.id }
        : action === 'source.proposal.decide'
          ? { requestedBy: 'researcher-1' }
          : action === 'source.rights.decide'
            ? { requestedBy: 'admin-2' }
          : action === 'source.legal-hold.release'
            ? { createdBy: 'admin-2' }
            : action === 'source.checkpoint.decide'
              ? { requestActorId: 'admin-2' }
              : {};
      assert.equal(
        sourceActionAllowed(actor, action as SourceAction, context),
        (allowedRoles as readonly string[]).includes(role),
        `${role} policy drift for ${action}`,
      );
    }
  }
  for (const action of Object.keys(SOURCE_ACTION_ROLES) as SourceAction[]) {
    if (!action.endsWith('.read')) {
      assert.equal((SOURCE_ACTION_ROLES[action] as readonly string[]).includes('auditor'), false);
    }
  }
});

void test('proposal, checkpoint and legal-hold decisions enforce separation of duties', () => {
  const admin = { id: 'admin-1', email: 'admin@signal40.test', role: 'admin' as const, canManageSourceLegal: true };
  assert.equal(sourceActionAllowed(admin, 'source.proposal.decide', { requestedBy: admin.id }), false);
  assert.equal(sourceActionAllowed(admin, 'source.proposal.decide', { requestedBy: 'researcher-1' }), true);
  assert.equal(sourceActionAllowed(admin, 'source.checkpoint.decide', { requestActorId: admin.id }), false);
  assert.equal(sourceActionAllowed(admin, 'source.checkpoint.decide', { requestActorId: 'admin-2' }), true);
  assert.equal(sourceActionAllowed(admin, 'source.legal-hold.release', { createdBy: admin.id }), false);
  assert.equal(sourceActionAllowed(admin, 'source.legal-hold.release', { createdBy: 'admin-2' }), true);
  assert.equal(sourceActionAllowed(admin, 'source.rights.decide', { requestedBy: admin.id }), false);
  assert.equal(sourceActionAllowed(admin, 'source.rights.decide', { requestedBy: 'admin-2' }), true);
});

void test('admin role alone does not grant source legal operations', () => {
  const ordinaryAdmin = { id: 'admin-1', email: 'admin@signal40.test', role: 'admin' as const };
  assert.equal(sourceActionAllowed(ordinaryAdmin, 'source.legal-delete'), false);
  assert.equal(sourceActionAllowed(ordinaryAdmin, 'source.legal-hold.create'), false);
  assert.equal(sourceActionAllowed(ordinaryAdmin, 'source.legal-hold.release', { createdBy: 'admin-2' }), false);
});

void test('researchers and editors can only read their own proposals', () => {
  const researcher = { id: 'researcher-1', email: 'r@signal40.test', role: 'researcher' as const };
  assert.equal(sourceActionAllowed(researcher, 'source.proposal.read', { requestedBy: researcher.id }), true);
  assert.equal(sourceActionAllowed(researcher, 'source.proposal.read', { requestedBy: 'researcher-2' }), false);
});
