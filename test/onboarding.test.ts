import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeOnboardingChecklist,
  currentOnboardingStep,
  eligibleRightsApprovers,
  onboardingComplete,
  sourceNextStep,
  type OnboardingState,
} from '../lib/onboarding.ts';
import { createMemoryPg } from './pg-memory.ts';
import { loadOnboardingState } from '../lib/onboarding.ts';

const emptyState: OnboardingState = {
  sources: [],
  rightsApprovers: [],
  articleCount: 0,
  topicCount: 0,
  ingestionWorkerOnline: false,
};

function source(overrides: Partial<OnboardingState['sources'][number]> = {}) {
  return {
    id: 'source_1',
    name: 'Google News',
    lifecycleStatus: 'tested',
    rightsStatus: 'pending',
    enabled: false,
    pendingRightsRequestedBy: 'local-developer',
    ...overrides,
  };
}

void test('空库时第一步是接入来源，后面的步骤显示为未解锁', () => {
  const steps = computeOnboardingChecklist(emptyState);
  assert.deepEqual(steps.map((step) => step.status), ['current', 'locked', 'locked', 'locked']);
  assert.equal(steps[0].action?.href, '/sources');
  assert.equal(onboardingComplete(steps), false);
  assert.equal(currentOnboardingStep(steps)?.key, 'connect_source');
});

void test('等待权利审批时列出能审批的人，并排除提交者本人', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source()],
    rightsApprovers: [
      { userId: 'local-developer', email: 'dev@local.test' },
      { userId: 'reviewer', email: 'reviewer@local.test' },
    ],
  });
  assert.equal(steps[1].status, 'current');
  assert.match(steps[1].detail, /reviewer@local\.test/);
  assert.doesNotMatch(steps[1].detail, /dev@local\.test/);
});

void test('团队里没有第二个审批人时这步是受阻，并指向治理页', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source()],
    rightsApprovers: [{ userId: 'local-developer', email: 'dev@local.test' }],
  });
  assert.equal(steps[1].status, 'blocked');
  assert.equal(steps[1].action?.href, '/governance');
});

void test('已启用但没有在线采集 Worker 时明说作业会排队', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source({ lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true, pendingRightsRequestedBy: null })],
    ingestionWorkerOnline: false,
  });
  assert.equal(steps[2].status, 'done');
  assert.match(steps[2].detail, /没有在线的采集 Worker/);
  assert.equal(steps[2].action?.href, '/operations');
});

void test('出了选题之后四步全完成，清单不再需要显示', () => {
  const steps = computeOnboardingChecklist({
    sources: [source({ lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true, pendingRightsRequestedBy: null })],
    rightsApprovers: [{ userId: 'reviewer', email: 'reviewer@local.test' }],
    articleCount: 38,
    topicCount: 1,
    ingestionWorkerOnline: true,
  });
  assert.equal(onboardingComplete(steps), true);
  assert.equal(currentOnboardingStep(steps), null);
  assert.match(steps[3].detail, /38 篇文章/);
});

void test('来源卡片的下一步跟着状态走', () => {
  const approvers = [{ userId: 'reviewer', email: 'reviewer@local.test' }];
  assert.match(
    sourceNextStep(source({ lifecycleStatus: 'draft' }), { approvers, hasSucceededRun: false })!.text,
    /先测试连接/,
  );
  assert.match(
    sourceNextStep(source(), { approvers, hasSucceededRun: false })!.text,
    /reviewer@local\.test/,
  );
  assert.match(
    sourceNextStep(source({ rightsStatus: 'approved' }), { approvers, hasSucceededRun: false })!.text,
    /启用来源/,
  );
  assert.match(
    sourceNextStep(
      source({ lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true }),
      { approvers, hasSucceededRun: false },
    )!.text,
    /立即采集/,
  );
  assert.equal(
    sourceNextStep(
      source({ lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true }),
      { approvers, hasSucceededRun: true },
    ),
    null,
  );
});

void test('提交者未知时不谎称没人能审批', () => {
  const approvers = [{ userId: 'reviewer', email: 'reviewer@local.test' }];
  assert.deepEqual(eligibleRightsApprovers(approvers, null), approvers);
  assert.deepEqual(eligibleRightsApprovers(approvers, 'reviewer'), []);
});

void test('状态读取只认数据库里的行', async () => {
  const db = await createMemoryPg();
  try {
    const now = new Date();
    await db.prepare(`
      INSERT INTO source_configs
        (id, name, adapter, platform, source_type, config_json, config_hash, rights_status,
         lifecycle_status, enabled, rate_limit_per_minute, created_at, updated_at)
      VALUES (?, ?, 'rss', 'rss', 'media', '{}', 'sha256:x', 'pending', 'tested', 0, 30, ?, ?)
    `).bind('source_1', 'Google News', now.toISOString(), now.toISOString()).run();
    await db.prepare(`
      INSERT INTO source_rights_requests
        (id, source_config_id, requested_by, status, assertion_ref, source_version,
         rights_config_hash, request_idempotency_key, created_at, updated_at)
      VALUES (?, ?, 'local-developer', 'pending', 'provisional:sha256:x', 1,
        'sha256:x', 'rights:source_1:1', ?, ?)
    `).bind('rights_request_1', 'source_1', now.toISOString(), now.toISOString()).run();
    await db.prepare(`
      INSERT INTO team_members
        (user_id, email, role, status, can_approve_source_rights, can_manage_source_legal, created_at, updated_at)
      VALUES (?, ?, 'admin', 'active', 1, 0, ?, ?)
    `).bind('reviewer', 'reviewer@local.test', now.toISOString(), now.toISOString()).run();

    const state = await loadOnboardingState(db, now);
    assert.equal(state.sources.length, 1);
    assert.equal(state.sources[0].pendingRightsRequestedBy, 'local-developer');
    assert.deepEqual(state.rightsApprovers, [{ userId: 'reviewer', email: 'reviewer@local.test' }]);
    assert.equal(state.articleCount, 0);
    assert.equal(state.topicCount, 0);
    assert.equal(state.ingestionWorkerOnline, false);

    const steps = computeOnboardingChecklist(state);
    assert.equal(steps[1].status, 'current');
    assert.match(steps[1].detail, /reviewer@local\.test/);
  } finally {
    await db.client.close();
  }
});
