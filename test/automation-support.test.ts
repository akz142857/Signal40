import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateNarrationSeconds, evaluateScriptDuration, narrationBudget } from '../lib/script-duration.ts';
import { assessTopicQuality, detectLanguage, evidenceDistinctness } from '../lib/topic-quality.ts';
import { runPipeline, type Article } from '../lib/domain.ts';
import { listWorkers, orphanedJobs, pruneStaleWorkers, recordWorkerHeartbeat } from '../lib/workers.ts';
import { listAttentionItems, notifyPendingAttention, raiseAttentionItem, resolveAttentionItem } from '../lib/attention.ts';
import { inspectStorageCredentials, runDiagnostics } from '../lib/diagnostics.ts';
import { checkScriptCompliance } from '../lib/script-compliance.ts';
import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  GLOBAL_AUTOMATION_STAGES,
  SELECTABLE_STAGE_MODES,
  breakerStatus,
  defaultAutomationPolicy,
  isGlobalStage,
  stageMode,
} from '../lib/automation.ts';
import { readFile } from 'node:fs/promises';
import { sampleArticles } from './fixtures/sample-articles.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-08T02:00:00.000Z');

void test('中文旁白按实测速率估算，超出 60%–110% 区间时给出增删字数', () => {
  const lines = [{ text: '存储芯片价格连续第三个月上涨。' }, { text: '两家原厂在财报里确认了涨价。' }];
  const seconds = estimateNarrationSeconds(lines);
  assert.ok(seconds > 6 && seconds < 9, `估算 ${seconds} 秒应在 6–9 秒之间`);

  const tooShort = evaluateScriptDuration({ lines, targetDurationSeconds: 45 });
  assert.equal(tooShort.status, 'too_short');
  assert.match(tooShort.reason, /还需要约 \d+ 字/);
  assert.match(tooShort.reason, /不要通过缩短成片时长来迁就/);

  const ok = evaluateScriptDuration({ lines, targetDurationSeconds: 9 });
  assert.equal(ok.status, 'ok');
});

void test('英文按词计速率，目标时长可以反推字数预算', () => {
  const english = evaluateScriptDuration({ lines: [{ text: 'Memory chip prices rose for a third straight month.' }], targetDurationSeconds: 4 });
  assert.equal(english.status, 'ok');
  const budget = narrationBudget(45, 5);
  assert.ok(budget.characters > 150 && budget.characters < 180, `45 秒的中文字数预算 ${budget.characters} 不合理`);
});

void test('语言判定区分中英文，英文簇不进入自动化', () => {
  assert.equal(detectLanguage('存储芯片价格上涨'), 'zh');
  assert.equal(detectLanguage('Memory chip prices rose'), 'en');
  const englishArticles: Article[] = Array.from({ length: 3 }, (_, index) => ({
    id: `article_en_${index}`,
    source: `Source ${index}`,
    sourceType: index === 0 ? 'filing' : 'media',
    author: '',
    title: `Unrelated market headline number ${index}`,
    summary: 'A generic english summary with no shared vocabulary.',
    url: `https://example.com/${index}`,
    publishedAt: now.toISOString(),
    metrics: {},
    contentHash: `hash${index}`,
  }));
  const quality = assessTopicQuality({ articles: englishArticles, sourceCount: 3 }, now);
  assert.equal(quality.automatable, false);
  assert.ok(quality.reasons.some((reason) => reason.includes('语言')));
});

void test('同一批证据支撑多条声明时区分度为 0', () => {
  assert.equal(evidenceDistinctness([{ evidenceIds: ['a', 'b'] }, { evidenceIds: ['a', 'b'] }]), 0);
  assert.equal(evidenceDistinctness([{ evidenceIds: ['a'] }, { evidenceIds: ['b'] }]), 1);
  // 建项目规则把整簇文章挂给每一条声明：只要簇里有两条以上原始来源，
  // 几条声明的证据集合就完全相同，区分度为 0——这正是自动建项目默认关闭的原因。
  const primaryArticles: Article[] = Array.from({ length: 3 }, (_, index) => ({
    id: `article_zh_${index}`,
    source: `原始来源 ${index}`,
    sourceType: 'filing',
    author: '',
    title: `存储芯片价格涨价公告 ${index}`,
    summary: '公司公告确认存储芯片价格上涨，营收与毛利同步提升。',
    url: `https://example.com/filing/${index}`,
    publishedAt: now.toISOString(),
    metrics: {},
    contentHash: `zhhash${index}`,
  }));
  const quality = assessTopicQuality({ articles: primaryArticles, sourceCount: 3 }, now);
  assert.equal(quality.evidenceDistinctness, 0);
  assert.equal(quality.automatable, false);
  assert.ok(quality.reasons.some((reason) => reason.includes('对应唯一性')));

  // 样本选题里簇内一致性本来就不达标，同样不会被自动建项目。
  const sampleTopic = runPipeline(sampleArticles(now), now).find((candidate) => candidate.gate.passed)!;
  assert.equal(assessTopicQuality(sampleTopic, now).automatable, false);
});

void test('Worker 心跳决定在线状态，超期心跳被清理，孤儿作业能被识别', async () => {
  const db = await createMemoryPg();
  await recordWorkerHeartbeat(db, { id: 'worker-a', hostname: 'host-a', kinds: ['render', 'voice'] }, now);
  const online = await listWorkers(db, new Date(now.valueOf() + 30_000));
  assert.equal(online[0].online, true);
  const offline = await listWorkers(db, new Date(now.valueOf() + 200_000));
  assert.equal(offline[0].online, false);

  await db.client.query(
    "INSERT INTO jobs (id, kind, project_id, payload_json, status, idempotency_key, available_at, created_at, updated_at) VALUES ('job_1', 'publish', 'project_1', '{}', 'queued', 'k1', $1, $1, $1)",
    [now.toISOString()],
  );
  // publish 类型没有任何在线 Worker 声明能处理，入队 61 秒后应当被判为孤儿。
  const orphans = await orphanedJobs(db, {}, new Date(now.valueOf() + 61_000));
  assert.deepEqual(orphans.map((job) => job.kind), ['publish']);

  const pruned = await pruneStaleWorkers(db, new Date(now.valueOf() + 8 * 86_400_000));
  assert.equal(pruned.deleted, 1);
});

void test('Worker 在线判定同时检查每项能力的协议版本', async () => {
  const db = await createMemoryPg();
  await recordWorkerHeartbeat(
    db,
    {
      id: 'source-worker-v1',
      kinds: ['ingestion'],
      capabilities: ['source:http-json'],
      capabilityProtocolVersions: { 'source:http-json': 1 },
    },
    now,
  );
  const workers = await listWorkers(db, new Date(now.valueOf() + 30_000));
  assert.deepEqual(workers[0].capabilityProtocolVersions, {
    'source:http-json': 1,
  });
  await db.client.query(
    `INSERT INTO jobs
      (id, kind, required_capability, required_capability_protocol_version,
       payload_json, status, idempotency_key, available_at, created_at, updated_at)
     VALUES ('job_protocol_v2', 'ingestion', 'source:http-json', 2,
       '{}', 'queued', 'protocol-v2', $1, $1, $1)`,
    [now.toISOString()],
  );

  const orphans = await orphanedJobs(
    db,
    {},
    new Date(now.valueOf() + 61_000),
  );
  assert.deepEqual(
    orphans.map((job) => ({
      id: job.id,
      requiredCapabilityProtocolVersion:
        job.requiredCapabilityProtocolVersion,
    })),
    [
      {
        id: 'job_protocol_v2',
        requiredCapabilityProtocolVersion: 2,
      },
    ],
  );
});

void test('同一件事只产生一条待办，处理后再次出现会重新打开', async () => {
  const db = await createMemoryPg();
  const first = await raiseAttentionItem(db, { kind: 'gate_blocked', dedupeKey: 'gate:project_1', reason: 'G4 未通过', projectId: 'project_1' }, now);
  const second = await raiseAttentionItem(db, { kind: 'gate_blocked', dedupeKey: 'gate:project_1', reason: 'G4 仍未通过', projectId: 'project_1' }, new Date(now.valueOf() + 60_000));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal((await listAttentionItems(db)).length, 1);

  await resolveAttentionItem(db, { id: first.id, actor: { id: 'editor-1', role: 'editor' }, note: '已补齐脚本覆盖。' }, now);
  assert.equal((await listAttentionItems(db, { status: 'open' })).length, 0);
  await raiseAttentionItem(db, { kind: 'gate_blocked', dedupeKey: 'gate:project_1', reason: '又坏了', projectId: 'project_1' }, new Date(now.valueOf() + 120_000));
  const reopened = await listAttentionItems(db, { status: 'open' });
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].resolved_at, null);
});

void test('reopenResolved=false 的来源不会把处理过的待办再翻出来', async () => {
  const db = await createMemoryPg();
  const first = await raiseAttentionItem(db, { kind: 'dead_letter', dedupeKey: 'dlq:job_9', reason: '渲染作业进入死信队列' }, now);
  await resolveAttentionItem(db, { id: first.id, actor: { id: 'admin-1', role: 'admin' }, note: '已重建作业。' }, now);
  // 作业行会一直停在 dead_letter，每轮 tick 都会再报一次同一条。
  await raiseAttentionItem(db, { kind: 'dead_letter', dedupeKey: 'dlq:job_9', reason: '渲染作业进入死信队列', reopenResolved: false }, new Date(now.valueOf() + 60_000));
  assert.equal((await listAttentionItems(db, { status: 'open' })).length, 0);
  const resolved = await listAttentionItems(db, { status: 'resolved' });
  assert.equal(resolved[0].resolved_by, 'admin-1', '处置痕迹不该被覆盖');
});

void test('待办通知带 HMAC 签名，推送失败只记录原因不丢条目', async () => {
  const db = await createMemoryPg();
  await raiseAttentionItem(db, { kind: 'dead_letter', dedupeKey: 'dlq:job_1', reason: '渲染作业进入死信队列' }, now);
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const ok = await notifyPendingAttention(db, {
    url: 'https://hooks.example/signal40',
    secret: 'test-secret',
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), headers: init.headers as Record<string, string> });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  }, now);
  assert.deepEqual({ sent: ok.sent, failed: ok.failed }, { sent: 1, failed: 0 });
  assert.match(seen[0].headers['x-signal40-signature'], /^sha256=[0-9a-f]{64}$/);

  await raiseAttentionItem(db, { kind: 'dead_letter', dedupeKey: 'dlq:job_2', reason: '第二条' }, now);
  const unsigned = await notifyPendingAttention(db, { url: 'https://hooks.example/signal40' }, now);
  assert.equal(unsigned.skipped, 'notify_secret_missing', '不能向外发送无法验真的未签名通知');
  const failed = await notifyPendingAttention(db, {
    url: 'https://hooks.example/signal40',
    secret: 'test-secret',
    fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
  }, now);
  assert.deepEqual({ sent: failed.sent, failed: failed.failed }, { sent: 0, failed: 1 });
  const stillOpen = await listAttentionItems(db, { status: 'open' });
  assert.equal(stillOpen.length, 2, '推送失败不该丢掉待办本身');
});

void test('自检把「值填错」和「没配」分开报，且不回显密钥', async () => {
  const wrong = inspectStorageCredentials({ endpoint: 'https://acc.r2.cloudflarestorage.com/bucket', bucket: 'b', accessKeyId: 'cfat-token-value', secretAccessKey: 'f'.repeat(64) });
  assert.equal(wrong.status, 'failed');
  assert.match(wrong.detail, /Token value/);
  assert.equal(wrong.detail.includes('f'.repeat(64)), false);
  assert.equal(inspectStorageCredentials({}).status, 'unconfigured');

  const db = await createMemoryPg();
  const result = await runDiagnostics({ db, env: {}, now });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find((check) => check.id === 'workers')?.status, 'failed');
  assert.equal(result.checks.find((check) => check.id === 'scheduler')?.status, 'failed');
  assert.equal(result.checks.find((check) => check.id === 'automation_actor')?.status, 'unconfigured');
  assert.equal(result.checks.find((check) => check.id === 'worker_token_scope')?.status, 'unconfigured');

  const separated = await runDiagnostics({ db, env: { sourceWorkerToken: 'source-only', renderWorkerToken: 'render-only' }, now });
  assert.equal(separated.checks.find((check) => check.id === 'worker_token_scope')?.status, 'ok');
  const shared = await runDiagnostics({ db, env: { workerToken: 'legacy-shared' }, now });
  assert.equal(shared.checks.find((check) => check.id === 'worker_token_scope')?.status, 'degraded');
});

void test('表达合规只挡自动放行：荐股与收益承诺被识别，正常事实陈述不被误伤', () => {
  const banned = checkScriptCompliance({
    disclaimer: '本内容仅供信息参考，不构成投资建议。',
    lines: [{ id: 'line_1', text: '这只票稳赚，建议买入。' }, { id: 'line_2', text: '存储芯片价格连续第三个月上涨。' }],
  });
  assert.equal(banned.passed, false);
  assert.deepEqual(banned.findings.map((finding) => finding.lineId), ['line_1', 'line_1']);

  const clean = checkScriptCompliance({
    disclaimer: '本内容仅供信息参考，不构成投资建议。',
    lines: [{ id: 'line_1', text: '两家原厂在财报里确认了涨价，幅度约 12%。' }],
  });
  assert.equal(clean.passed, true);

  const noDisclaimer = checkScriptCompliance({ disclaimer: '', lines: [{ id: 'line_1', text: '事实陈述。' }] });
  assert.equal(noDisclaimer.passed, false);
  assert.equal(noDisclaimer.disclaimerOk, false);
});

/*
  自动化控制台第二批修复的回归覆盖：界面上摆出来的每个选项，引擎都必须真的
  分得出差别；界面和引擎对「哪些阶段是全局的」「熔断到底挡没挡住」必须用同一份判据。
*/

void test('阶段只有自动与不自动：历史落库的 manual 归一成 off', () => {
  const policy = {
    ...defaultAutomationPolicy(),
    id: 'policy_legacy',
    name: '历史策略',
    version: 1,
    stages: { ...defaultAutomationPolicy().stages, advance: 'manual' as const, jobs: 'off' as const, publish: 'auto' as const },
  };
  // 引擎里所有判断都是 === 'auto'，manual 和 off 走的是同一个分支；
  // 界面曾经把它当第三个可选项摆出来，选了什么都不会变。
  assert.equal(stageMode(policy, 'advance'), 'off');
  assert.equal(stageMode(policy, 'jobs'), 'off');
  assert.equal(stageMode(policy, 'publish'), 'auto');
  assert.deepEqual([...SELECTABLE_STAGE_MODES], ['auto', 'off']);
});

void test('全局阶段的定义由 lib 给出，界面和引擎共用一份', () => {
  // 采集、选题质量评估、指标回流不挂在项目上，引擎对所有启用中的策略取「或」。
  assert.deepEqual([...GLOBAL_AUTOMATION_STAGES], ['ingestion', 'topic_quality', 'metrics']);
  for (const stage of GLOBAL_AUTOMATION_STAGES) assert.equal(isGlobalStage(stage), true, stage);
  for (const stage of ['project_creation', 'advance', 'jobs', 'publish'] as const) {
    assert.equal(isGlobalStage(stage), false, stage);
  }
});

void test('熔断冷却结束后是「下一轮会重试」，不是「仍然熔断」', () => {
  const openedAt = new Date('2026-09-11T00:00:00.000Z');
  const breakers = {
    publish: { failures: BREAKER_FAILURE_THRESHOLD, openedAt: openedAt.toISOString(), lastError: '上游 503' },
    jobs: { failures: BREAKER_FAILURE_THRESHOLD - 1, openedAt: null, lastError: '偶发超时' },
  };
  assert.equal(breakerStatus(breakers, 'publish', new Date(openedAt.valueOf() + 60_000)), 'open');
  // failures 要等一次成功才清零，只看次数会把正在重试的阶段说成「已熔断」。
  assert.equal(breakerStatus(breakers, 'publish', new Date(openedAt.valueOf() + BREAKER_COOLDOWN_MS + 1)), 'cooling_down');
  assert.equal(breakerStatus(breakers, 'jobs', new Date(openedAt.valueOf() + 60_000)), 'closed');
  assert.equal(breakerStatus(breakers, 'metrics', openedAt), 'closed');
});

void test('自动化控制台不再逐字段写库，且删除策略要二次确认', async () => {
  const console_ = await readFile(new URL('../components/automation-console.tsx', import.meta.url), 'utf8');
  // 每个输入框的 onChange 直接 PATCH 会把审计流塞满，还会跟正在打字的人抢输入框。
  assert.match(console_, /const \[draft, setDraft\] = useState<PolicyDraft \| null>/);
  assert.match(console_, /saveDraft/);
  assert.doesNotMatch(console_, /onChange=\{\(event\) => void update\(policy/);
  // 删除会把名下项目全部退回人工，不能点一下就执行。
  assert.match(console_, /window\.confirm\(/);
  // 角色分渲染：只读角色看到的不是一堆注定 403 的控件。
  assert.match(console_, /const canEdit = session\.actor\?\.role === 'admin'/);
});
