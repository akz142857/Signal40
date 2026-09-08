import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentProject, loadContentProject, recordApproval } from '../lib/control-plane.ts';
import { createProjectV2 } from '../lib/project-v2.ts';
import { runPipeline } from '../lib/domain.ts';
import { defaultAutomationPolicy, serializeAutomationPolicy, validateAutomationPolicy, type AutomationPolicy } from '../lib/automation.ts';
import { runAutomationTick } from '../lib/orchestrator.ts';
import { stableHash } from '../lib/workflow.ts';
import { sampleArticles } from './fixtures/sample-articles.ts';
import { createMemoryPg } from './pg-memory.ts';

type MemoryPg = Awaited<ReturnType<typeof createMemoryPg>>;

const baseTime = new Date('2026-09-08T02:00:00.000Z');
const serviceActorId = 'automation-service';

function at(offsetSeconds: number) {
  return new Date(baseTime.valueOf() + offsetSeconds * 1000);
}

async function seedMembers(db: MemoryPg) {
  const now = baseTime.toISOString();
  for (const [userId, email, role] of [
    [serviceActorId, 'automation@signal40.test', 'admin'],
    ['editor-1', 'editor@signal40.test', 'editor'],
    ['publisher-1', 'publisher@signal40.test', 'publisher'],
  ] as const) {
    await db.client.query(
      "INSERT INTO team_members (user_id, email, role, status, created_at, updated_at) VALUES ($1, $2, $3, 'active', $4, $4)",
      [userId, email, role, now],
    );
  }
}

async function seedPolicy(db: MemoryPg, overrides: Partial<AutomationPolicy> = {}) {
  const policy: AutomationPolicy = {
    ...defaultAutomationPolicy(),
    id: 'policy_test',
    name: '测试策略',
    version: 1,
    enabled: true,
    ...overrides,
  };
  const columns = serializeAutomationPolicy(policy);
  const now = baseTime.toISOString();
  await db.client.query(
    `INSERT INTO automation_policies
       (id, name, scope_json, stages_json, auto_approvals_json, research_authorized_by, publish_authorized_by,
        guardrails_json, authorized_at, expires_at, enabled, version, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 'admin-1', $12, $12)`,
    [policy.id, policy.name, columns.scopeJson, columns.stagesJson, columns.autoApprovalsJson, policy.researchAuthorizedBy, policy.publishAuthorizedBy, columns.guardrailsJson, policy.authorizedAt, policy.expiresAt, policy.enabled ? 1 : 0, now],
  );
  return policy;
}

/** 造一个真实的 v2 项目：门禁判定读的是 claims / evidence_links，假 JSON 骗不过去。 */
async function seedProject(db: MemoryPg, state: string, quality: { automatable: boolean } = { automatable: true }) {
  const topic = runPipeline(sampleArticles(baseTime), baseTime).find((candidate) => candidate.gate.passed);
  assert.ok(topic, '样本文章里应当有一个通过自动证据门禁的选题');
  // 选题行要真的存在：研究审批的自动放行会读它的质量指标，读不到就按不达标处理。
  await db.client.query(
    `INSERT INTO topics (id, title, keywords_json, score, heat_change, score_breakdown_json, source_count, status, gate_json, quality_json, updated_at)
     VALUES ($1, $2, '[]', $3, 0, '{}', $4, 'ready', $5, $6, $7) ON CONFLICT (id) DO UPDATE SET quality_json = excluded.quality_json`,
    [topic.id, topic.title, topic.score, topic.sourceCount, JSON.stringify(topic.gate), JSON.stringify(quality), baseTime.toISOString()],
  );
  const project = createProjectV2({ ...topic, verificationStatus: 'verified' }, baseTime);
  const actor = { id: serviceActorId, email: 'automation@signal40.test', role: 'admin' as const };
  const created = await createContentProject(db, project, actor, baseTime);
  await db.client.query('UPDATE content_projects SET state = $1, automation_policy_id = $2 WHERE id = $3', [state, 'policy_test', created.project.id]);
  return created.project.id;
}

async function tick(db: MemoryPg, now: Date, overrides: Record<string, unknown> = {}) {
  return runAutomationTick({ db, now, trigger: 'scheduler', automationActorId: serviceActorId, ...overrides });
}

void test('没有配置服务账号时引擎不做任何写入', async () => {
  const db = await createMemoryPg();
  const result = await runAutomationTick({ db, now: baseTime, trigger: 'scheduler' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.skippedReason, 'automation_actor_missing');
  const items = await db.client.query("SELECT kind FROM attention_items WHERE status = 'open'");
  assert.equal((items.rows[0] as { kind: string }).kind, 'automation_actor_missing');
});

void test('门禁未过时不推进，只往待办箱写一条原因', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db);
  // EVIDENCE_READY 的下一步需要 G3（研究批准），策略默认不自动放行。
  const projectId = await seedProject(db, 'EVIDENCE_READY');
  const result = await tick(db, at(1));
  assert.equal(result.status, 'succeeded');
  const project = await loadContentProject(db, projectId);
  assert.equal(project?.state, 'EVIDENCE_READY');
  const items = await db.client.query("SELECT kind, reason FROM attention_items WHERE project_id = $1", [projectId]);
  assert.equal((items.rows[0] as { kind: string }).kind, 'auto_approval_rejected');
});

void test('tick 重入不会重复入队配音作业', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db);
  const projectId = await seedProject(db, 'SCRIPT_APPROVED');
  await tick(db, at(1));
  await tick(db, at(60));
  const jobs = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE project_id = $1 AND kind = 'voice'", [projectId]);
  assert.equal(Number((jobs.rows[0] as { total: number }).total), 1);
});

void test('预先授权过期后策略失效，项目转由人工推进', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db, {
    autoApprovals: { research: { enabled: true }, script: { enabled: false }, qc: { enabled: false }, publish: { enabled: false } },
    researchAuthorizedBy: 'editor-1',
    expiresAt: at(30).toISOString(),
  });
  const projectId = await seedProject(db, 'EVIDENCE_READY');
  // 有效期内：研究审批被自动放行，项目越过 EDITOR_APPROVED 继续推进到脚本阶段。
  await tick(db, at(10));
  assert.equal((await loadContentProject(db, projectId))?.state, 'SCRIPT_DRAFT');
  const approved = await db.client.query("SELECT actor_id FROM approvals WHERE project_id = $1 AND kind = 'research'", [projectId]);
  assert.equal((approved.rows[0] as { actor_id: string }).actor_id, 'editor-1', '自动放行写入的必须是策略里那个真人');

  await db.client.query("UPDATE content_projects SET state = 'EVIDENCE_READY' WHERE id = $1", [projectId]);
  await db.client.query('DELETE FROM approvals WHERE project_id = $1', [projectId]);
  // 过期之后同一条策略不再被选中，状态原地不动。
  const later = await tick(db, at(600));
  assert.equal((await loadContentProject(db, projectId))?.state, 'EVIDENCE_READY');
  assert.equal(later.actions.some((action) => action.action === 'approval.auto_research'), false);
});

void test('研究与发布授权人相同的策略在保存时就被拒绝', () => {
  const policy: AutomationPolicy = {
    ...defaultAutomationPolicy(),
    id: 'policy_same',
    name: '同一个人两头批',
    version: 1,
    enabled: true,
    autoApprovals: { research: { enabled: true }, script: { enabled: false }, qc: { enabled: false }, publish: { enabled: true } },
    researchAuthorizedBy: 'editor-1',
    publishAuthorizedBy: 'editor-1',
    expiresAt: at(3600).toISOString(),
  };
  const validation = validateAutomationPolicy(policy, baseTime);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('职责分离')));
});

void test('授权人相同的策略即使绕过校验落库，自动放行也会被拒绝', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db, {
    autoApprovals: { research: { enabled: true }, script: { enabled: false }, qc: { enabled: false }, publish: { enabled: true } },
    researchAuthorizedBy: 'editor-1',
    publishAuthorizedBy: 'editor-1',
    expiresAt: at(3600).toISOString(),
  });
  const projectId = await seedProject(db, 'QC_APPROVED');
  await tick(db, at(1));
  assert.equal((await loadContentProject(db, projectId))?.state, 'QC_APPROVED');
  const items = await db.client.query("SELECT reason FROM attention_items WHERE project_id = $1 AND kind = 'auto_approval_rejected'", [projectId]);
  assert.ok(String((items.rows[0] as { reason: string }).reason).includes('职责分离'));
});

void test('月度渲染预算耗尽时不入队渲染作业', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db);
  const projectId = await seedProject(db, 'ASSETS_READY');
  await db.client.query(
    "INSERT INTO jobs (id, kind, payload_json, status, idempotency_key, cost_micros, available_at, created_at, updated_at) VALUES ('job_spent', 'render', '{}', 'succeeded', 'spent', 900000, $1, $1, $1)",
    [baseTime.toISOString()],
  );
  await tick(db, at(1), { monthlyRenderBudgetMicros: 500_000 });
  const jobs = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE project_id = $1 AND kind = 'render'", [projectId]);
  assert.equal(Number((jobs.rows[0] as { total: number }).total), 0);
  const items = await db.client.query("SELECT kind FROM attention_items WHERE kind = 'budget_exceeded'");
  assert.equal(items.rows.length, 1);
});

void test('连续失败达到阈值后该阶段熔断，后续 tick 不再重试', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db);
  await db.client.query(
    `INSERT INTO automation_runs (id, trigger, status, started_at, breakers_json)
     VALUES ('automation_prev', 'scheduler', 'partial', $1, $2)`,
    [at(-30).toISOString(), JSON.stringify({ ingestion: { failures: 3, openedAt: at(-30).toISOString(), lastError: '对象存储不可用' } })],
  );
  await db.client.query(
    `INSERT INTO source_configs (id, name, adapter, config_json, rights_status, schedule_cron, enabled, created_at, updated_at)
     VALUES ('source_1', '测试来源', 'rss', '{}', 'approved', '* * * * *', 1, $1, $1)`,
    [at(-3600).toISOString()],
  );
  const result = await tick(db, at(1));
  const jobs = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE kind = 'ingestion'");
  assert.equal(Number((jobs.rows[0] as { total: number }).total), 0, '熔断期间不该继续入队采集作业');
  assert.equal(result.breakers.ingestion?.failures, 3);
});

void test('内容事件一开，自动化立即停止并写明原因', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db);
  const projectId = await seedProject(db, 'SCRIPT_APPROVED');
  await db.client.query(
    `INSERT INTO content_incidents (id, project_id, kind, severity, status, reason, actor_id, created_at, updated_at)
     VALUES ('incident_1', $1, 'correction', 'high', 'open', '数字口径有误，需要勘误。', 'editor-1', $2, $2)`,
    [projectId, at(1).toISOString()],
  );
  await tick(db, at(2));
  const project = await loadContentProject(db, projectId);
  assert.equal(project?.automationMode, 'manual');
  assert.match(project?.automationPausedReason ?? '', /内容事件/);
  const jobs = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE project_id = $1", [projectId]);
  assert.equal(Number((jobs.rows[0] as { total: number }).total), 0);
});

void test('人工审批会把项目踢出自动化，审计区分得出是人还是策略', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db);
  const projectId = await seedProject(db, 'EVIDENCE_READY');
  const project = await loadContentProject(db, projectId);
  assert.ok(project);
  const result = await recordApproval(db, {
    projectId,
    kind: 'research',
    decision: 'approved',
    subjectHash: project.project.research.approvedHash,
    note: '人工核对过证据。',
    actor: { id: 'editor-1', email: 'editor@signal40.test', role: 'editor' },
  }, at(1));
  assert.equal('status' in result ? result.status : 0, 201);
  const updated = await loadContentProject(db, projectId);
  assert.equal(updated?.automationMode, 'manual');
  const audit = await db.client.query("SELECT metadata_json ->> 'trigger' AS trigger FROM audit_events WHERE action = 'approval.approved' AND project_id = $1", [projectId]);
  assert.equal((audit.rows[0] as { trigger: string }).trigger, 'human');
  assert.equal(stableHash({ a: 1 }), stableHash({ a: 1 }));
});

void test('选题质量不达标时不自动放行研究审批', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db, {
    autoApprovals: { research: { enabled: true }, script: { enabled: false }, qc: { enabled: false }, publish: { enabled: false } },
    researchAuthorizedBy: 'editor-1',
    expiresAt: at(3600).toISOString(),
  });
  const projectId = await seedProject(db, 'EVIDENCE_READY', { automatable: false });
  await tick(db, at(1));
  assert.equal((await loadContentProject(db, projectId))?.state, 'EVIDENCE_READY');
  const items = await db.client.query("SELECT reason FROM attention_items WHERE project_id = $1 AND kind = 'auto_approval_rejected'", [projectId]);
  assert.match(String((items.rows[0] as { reason: string }).reason), /选题质量指标未达标/);
});

void test('渲染被预算挡下时项目不会推进到没有作业的 RENDER_QUEUED', async () => {
  const db = await createMemoryPg();
  await seedMembers(db);
  await seedPolicy(db);
  const projectId = await seedProject(db, 'ASSETS_READY');
  await db.client.query(
    "INSERT INTO jobs (id, kind, payload_json, status, idempotency_key, cost_micros, available_at, created_at, updated_at) VALUES ('job_spent2', 'render', '{}', 'succeeded', 'spent2', 900000, $1, $1, $1)",
    [baseTime.toISOString()],
  );
  await tick(db, at(1), { monthlyRenderBudgetMicros: 500_000 });
  assert.equal((await loadContentProject(db, projectId))?.state, 'ASSETS_READY', '没有渲染作业就不能进 RENDER_QUEUED');
});
