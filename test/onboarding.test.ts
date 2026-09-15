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
  latestRunArticleCount: 0,
  latestRunTopicCount: 0,
  latestRunGatePassedCount: 0,
  discardedRunCount: 0,
  ingestionWorkerOnline: false,
};

function source(overrides: Partial<OnboardingState['sources'][number]> = {}) {
  return {
    id: 'source_1',
    name: 'Google News',
    lifecycleStatus: 'tested',
    rightsStatus: 'pending',
    sourceType: 'media',
    testedCurrentConfig: true,
    enabled: false,
    pendingRightsRequestedBy: 'local-developer',
    ...overrides,
  };
}

void test('空库时第一步是接入来源，后面的步骤显示为未解锁', () => {
  const steps = computeOnboardingChecklist(emptyState);
  assert.deepEqual(steps.map((step) => step.status), ['current', 'locked', 'locked', 'locked', 'locked']);
  assert.equal(steps[0].action?.href, '/sources');
  assert.equal(onboardingComplete(steps), false);
  assert.equal(currentOnboardingStep(steps)?.key, 'connect_source');
});

void test('等待权利审批时列出所有能审批的人，提交者本人也在内', () => {
  // 职责分离移除后，提交者可以批自己的请求；清单不再把他排除在外。
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
  assert.match(steps[1].detail, /dev@local\.test/);
});

void test('团队里一个能批权利的管理员都没有时这步是受阻，并指向治理页', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source()],
    rightsApprovers: [],
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

void test('候选通过证据门禁之后五步全完成，清单不再需要显示', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source({ lifecycleStatus: 'enabled', rightsStatus: 'approved', sourceType: 'company', enabled: true, pendingRightsRequestedBy: null })],
    rightsApprovers: [{ userId: 'reviewer', email: 'reviewer@local.test' }],
    articleCount: 38,
    latestRunArticleCount: 38,
    latestRunTopicCount: 1,
    latestRunGatePassedCount: 1,
    ingestionWorkerOnline: true,
  });
  assert.equal(onboardingComplete(steps), true);
  assert.equal(currentOnboardingStep(steps), null);
  assert.match(steps[3].detail, /38 篇语料/);
});

void test('历史上出过选题、但最近一次运行没有产出时，这步不算完成', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source({ lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true, pendingRightsRequestedBy: null })],
    rightsApprovers: [{ userId: 'reviewer', email: 'reviewer@local.test' }],
    articleCount: 50,
    latestRunArticleCount: 0,
    latestRunTopicCount: 0,
    discardedRunCount: 2,
    ingestionWorkerOnline: true,
  });
  assert.equal(steps[3].status, 'blocked');
  assert.match(steps[3].detail, /2 个采集批次被丢弃/);
  assert.equal(onboardingComplete(steps), false);
});

void test('来源全是转述类时，证据门禁这步明说永远过不了', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source({ lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true, pendingRightsRequestedBy: null })],
    rightsApprovers: [{ userId: 'reviewer', email: 'reviewer@local.test' }],
    articleCount: 50,
    latestRunArticleCount: 50,
    latestRunTopicCount: 3,
    latestRunGatePassedCount: 0,
    ingestionWorkerOnline: true,
  });
  assert.equal(steps[4].status, 'blocked');
  assert.match(steps[4].detail, /filing \/ company \/ market/);
  assert.equal(steps[4].action?.href, '/sources');
});

void test('已有一手来源但还差交叉印证时，门禁这步说缺的是独立证据', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [source({ name: 'OpenAI 官方博客', lifecycleStatus: 'enabled', rightsStatus: 'approved', sourceType: 'company', enabled: true, pendingRightsRequestedBy: null })],
    rightsApprovers: [{ userId: 'reviewer', email: 'reviewer@local.test' }],
    articleCount: 50,
    latestRunArticleCount: 50,
    latestRunTopicCount: 3,
    latestRunGatePassedCount: 0,
    ingestionWorkerOnline: true,
  });
  assert.equal(steps[4].status, 'current');
  assert.match(steps[4].detail, /独立证据/);
  assert.match(steps[4].detail, /OpenAI 官方博客/);
});

void test('来源卡片的下一步跟着状态走', () => {
  const approvers = [{ userId: 'reviewer', email: 'reviewer@local.test' }];
  assert.match(
    sourceNextStep(source({ lifecycleStatus: 'draft', testedCurrentConfig: false }), { approvers, hasSucceededRun: false })!.text,
    /先测试连接/,
  );
  // 改过配置的来源会回到 paused，但旧测试结果已经对不上当前配置。
  assert.match(
    sourceNextStep(
      source({ lifecycleStatus: 'paused', rightsStatus: 'approved', testedCurrentConfig: false }),
      { approvers, hasSucceededRun: false },
    )!.text,
    /重新测试连接/,
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

void test('可审批名单不再排除提交者本人', () => {
  const approvers = [{ userId: 'reviewer', email: 'reviewer@local.test' }];
  assert.deepEqual(eligibleRightsApprovers(approvers, null), approvers);
  // 职责分离移除后，提交者自己也在名单里——否则界面会指向一个不存在的第二个人。
  assert.deepEqual(eligibleRightsApprovers(approvers, 'reviewer'), approvers);
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
    assert.equal(state.sources[0].sourceType, 'media');
    assert.equal(state.latestRunTopicCount, 0);
    assert.equal(state.latestRunGatePassedCount, 0);
    assert.equal(state.discardedRunCount, 0);
    assert.equal(state.ingestionWorkerOnline, false);

    const steps = computeOnboardingChecklist(state);
    assert.equal(steps[1].status, 'current');
    assert.match(steps[1].detail, /reviewer@local\.test/);
  } finally {
    await db.client.close();
  }
});

void test('状态只读最近一次运行，并数出被丢弃的采集批次', async () => {
  const db = await createMemoryPg();
  try {
    const now = new Date();
    const stamp = now.toISOString();
    await db.prepare(`
      INSERT INTO source_configs
        (id, name, adapter, platform, source_type, config_json, config_hash, rights_status,
         lifecycle_status, enabled, rate_limit_per_minute, created_at, updated_at)
      VALUES (?, ?, 'rss', 'rss', 'media', '{}', 'sha256:x', 'approved', 'enabled', 1, 30, ?, ?)
    `).bind('source_1', 'Google News', stamp, stamp).run();
    for (const run of [
      { id: 'run_old', created: '2026-01-01T00:00:00.000Z', articles: 40, topics: 1 },
      { id: 'run_new', created: '2026-01-02T00:00:00.000Z', articles: 0, topics: 0 },
    ]) {
      await db.prepare(`
        INSERT INTO pipeline_runs (id, mode, article_count, topic_count, created_at)
        VALUES (?, 'import', ?, ?, ?)
      `).bind(run.id, run.articles, run.topics, run.created).run();
    }
    // 旧运行里的选题还在库里，但雷达读不到它——清单必须跟雷达说同一件事。
    await db.prepare(`
      INSERT INTO topics
        (id, title, keywords_json, run_id, score, heat_change, score_breakdown_json,
         source_count, status, gate_json, quality_json, updated_at)
      VALUES (?, ?, '[]', 'run_old', 64, 0, '{}', 0, 'needs_primary_source', ?, '{}', ?)
    `).bind('topic_old', '旧选题', '{"passed":false}', stamp).run();
    await db.prepare(`
      INSERT INTO ingestion_runs
        (id, source_config_id, status, quarantine_status, trigger, created_at)
      VALUES (?, 'source_1', 'succeeded', 'discarded', 'human', ?)
    `).bind('ingestion_1', stamp).run();
    // 文章还在库里，只是被丢弃批次摘掉了来源归属，已经进不了语料。
    await db.prepare(`
      INSERT INTO articles
        (id, source, source_type, author, title, summary, url, published_at,
         metrics_json, content_hash, created_at)
      VALUES (?, 'Google News', 'media', '', ?, '', ?, ?, '{}', ?, ?)
    `).bind('article_1', '被丢弃的文章', 'https://example.com/a', stamp, 'hash_1', stamp).run();

    const state = await loadOnboardingState(db, now);
    assert.equal(state.latestRunArticleCount, 0);
    assert.equal(state.latestRunTopicCount, 0);
    assert.equal(state.discardedRunCount, 1);

    const steps = computeOnboardingChecklist(state);
    assert.equal(steps[3].status, 'blocked');
    assert.equal(onboardingComplete(steps), false);
  } finally {
    await db.client.close();
  }
});

void test('一手来源还没启用时，门禁这步不谎报已经有一手来源', () => {
  // 只按 sourceType 过滤会把停着、权利还没批的来源也算成「已有一手来源」，
  // 那两个来源一篇文章都没供上，界面却报出一个不存在的进展。
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [
      source({ name: 'Google News', lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true, pendingRightsRequestedBy: null }),
      source({ id: 'source_2', name: 'openai', sourceType: 'company', lifecycleStatus: 'paused', rightsStatus: 'pending', enabled: false }),
    ],
    rightsApprovers: [{ userId: 'reviewer', email: 'reviewer@local.test' }],
    articleCount: 74,
    latestRunArticleCount: 74,
    latestRunTopicCount: 50,
    latestRunGatePassedCount: 0,
    ingestionWorkerOnline: true,
  });
  assert.equal(steps[4].status, 'blocked');
  assert.match(steps[4].detail, /还没启用或使用权还没批准/);
  assert.doesNotMatch(steps[4].detail, /已有一手来源/);
  assert.equal(steps[4].action?.href, '/sources');
});

void test('一手来源已启用且权利已批准时，门禁这步说缺的是交叉印证', () => {
  const steps = computeOnboardingChecklist({
    ...emptyState,
    sources: [
      source({ name: 'openai', sourceType: 'company', lifecycleStatus: 'enabled', rightsStatus: 'approved', enabled: true, pendingRightsRequestedBy: null }),
    ],
    rightsApprovers: [{ userId: 'reviewer', email: 'reviewer@local.test' }],
    articleCount: 74,
    latestRunArticleCount: 74,
    latestRunTopicCount: 50,
    latestRunGatePassedCount: 0,
    ingestionWorkerOnline: true,
  });
  assert.equal(steps[4].status, 'current');
  assert.match(steps[4].detail, /已有一手来源 openai/);
});
