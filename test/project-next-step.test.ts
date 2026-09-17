import assert from 'node:assert/strict';
import test from 'node:test';
import { describeRoles, projectNextStep } from '../lib/project-next-step.ts';
import {
  CONTENT_STATES,
  PRIMARY_NEXT_STATE,
  allowedTransitionsFrom,
  CONTENT_STATE_LABELS,
  type ContentState,
  type GateResult,
} from '../lib/workflow.ts';

const passed = (code: string): GateResult => ({ code: code as GateResult['code'], passed: true, reasons: [] });
const failed = (code: string, reason: string): GateResult => ({
  code: code as GateResult['code'],
  passed: false,
  reasons: [reason],
});

void test('正常推进路径上的每个目标都是状态机允许的转换', () => {
  for (const [from, to] of Object.entries(PRIMARY_NEXT_STATE)) {
    assert.ok(
      allowedTransitionsFrom(from as ContentState).includes(to),
      `${from} → ${to}`,
    );
  }
});

void test('每个状态都有中文标签', () => {
  for (const state of CONTENT_STATES) {
    assert.ok(CONTENT_STATE_LABELS[state], state);
  }
});

void test('门禁没过时说清差哪一道、原因是什么，并且不让人误以为能推进', () => {
  const step = projectNextStep({
    state: 'RESEARCHING',
    gates: [
      passed('G0_SOURCE_RIGHTS'),
      failed('G1_INPUT_QUALITY', '缺少独立来源'),
      failed('G2_AUTO_EVIDENCE', '声明未绑定证据'),
    ],
    role: 'researcher',
  });
  assert.equal(step.targetState, 'EVIDENCE_READY');
  assert.deepEqual(step.blockedGates.map((gate) => gate.code), ['G1_INPUT_QUALITY', 'G2_AUTO_EVIDENCE']);
  assert.match(step.detail, /缺少独立来源/);
  assert.equal(step.actorCanAct, false);
});

void test('门禁全过但角色不对时，说的是没权限而不是门禁没过', () => {
  const step = projectNextStep({
    state: 'EVIDENCE_READY',
    gates: [passed('G3_MANUAL_RESEARCH')],
    role: 'researcher',
  });
  assert.deepEqual(step.blockedGates, []);
  assert.equal(step.actorCanAct, false);
  assert.match(step.detail, /没有执行这一步的权限/);
  assert.match(step.detail, /编辑/);
});

void test('角色对且门禁全过时可以动手', () => {
  const step = projectNextStep({
    state: 'EVIDENCE_READY',
    gates: [passed('G3_MANUAL_RESEARCH')],
    role: 'editor',
  });
  assert.equal(step.actorCanAct, true);
  assert.equal(step.title, '下一步：研究已批准');
});

void test('未评估的门禁按未通过处理，不给乐观结论', () => {
  const step = projectNextStep({ state: 'RESEARCHING', gates: [], role: 'admin' });
  assert.equal(step.actorCanAct, false);
  assert.equal(step.blockedGates.length, 3);
  assert.match(step.blockedGates[0].reasons[0], /尚未评估/);
});

void test('等机器的状态说明在等什么，而不是催人操作', () => {
  for (const state of ['RENDER_QUEUED', 'RENDERING'] as const) {
    const step = projectNextStep({ state, gates: [], role: 'producer' });
    assert.equal(step.waitingOnMachine, true);
    assert.equal(step.actorCanAct, false);
    assert.equal(step.targetState, null);
  }
});

void test('回退与终态给出去向，不留空白', () => {
  assert.match(projectNextStep({ state: 'CHANGES_REQUESTED', gates: [], role: 'editor' }).detail, /重新提交/);
  assert.match(projectNextStep({ state: 'REJECTED', gates: [], role: 'editor' }).detail, /重新研究/);
  assert.match(projectNextStep({ state: 'FAILED', gates: [], role: 'admin' }).detail, /修复/);
  assert.match(projectNextStep({ state: 'MEASURED', gates: [], role: 'publisher' }).detail, /走完了全流程/);
  assert.match(projectNextStep({ state: 'CANCELLED', gates: [], role: 'admin' }).detail, /不会再推进/);
});

void test('未登录（无角色）时不会声称可以动手', () => {
  const step = projectNextStep({
    state: 'EVIDENCE_READY',
    gates: [passed('G3_MANUAL_RESEARCH')],
    role: null,
  });
  assert.equal(step.actorCanAct, false);
});

void test('角色描述覆盖全部允许角色', () => {
  assert.equal(describeRoles(['editor', 'admin']), '编辑 / 管理员');
  assert.equal(describeRoles(null), '任何有权限的成员');
});
