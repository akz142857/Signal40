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

void test('提案、检查点、legal hold、权利审批都允许提交者本人决定', () => {
  // 职责分离（必须换一个人批）已按单人运营的决定移除。这里断言的是移除后的行为：
  // 同一个人可以批自己提的，但请求上下文仍然必须存在——缺少 requestedBy 之类的
  // 关联信息时照旧拒绝，避免路由忘记带上下文就放行。
  const admin = { id: 'admin-1', email: 'admin@signal40.test', role: 'admin' as const, canManageSourceLegal: true };
  assert.equal(sourceActionAllowed(admin, 'source.proposal.decide', { requestedBy: admin.id }), true);
  assert.equal(sourceActionAllowed(admin, 'source.proposal.decide', { requestedBy: 'researcher-1' }), true);
  assert.equal(sourceActionAllowed(admin, 'source.proposal.decide', {}), false);
  assert.equal(sourceActionAllowed(admin, 'source.checkpoint.decide', { requestActorId: admin.id }), true);
  assert.equal(sourceActionAllowed(admin, 'source.checkpoint.decide', {}), false);
  assert.equal(sourceActionAllowed(admin, 'source.legal-hold.release', { createdBy: admin.id }), true);
  assert.equal(sourceActionAllowed(admin, 'source.legal-hold.release', { createdBy: null }), false);
  assert.equal(sourceActionAllowed(admin, 'source.rights.decide', { requestedBy: admin.id }), true);
  assert.equal(sourceActionAllowed(admin, 'source.rights.decide', {}), false);
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
