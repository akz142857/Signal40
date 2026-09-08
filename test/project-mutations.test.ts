import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createContentProject,
  evaluateProjectGates,
  listProjectAudit,
  loadContentProject,
  saveProjectSection,
  saveResearchSnapshot,
  transitionContentProject,
} from '../lib/control-plane.ts';
import { runPipeline } from '../lib/domain.ts';
import { persistPipeline } from '../lib/persistence.ts';
import { createProjectV2 } from '../lib/project-v2.ts';
import { sampleArticles } from './fixtures/sample-articles.ts';
import { stableHash, WorkflowError } from '../lib/workflow.ts';
import { createMemoryPg } from './pg-memory.ts';

/**
 * 项目写入路径在真 PostgreSQL 上的覆盖：建项目（连带声明与证据）、
 * 分节保存、研究快照重写、乐观并发冲突。
 *
 * 这些路径此前只在 D1 上跑过，方言差异（多行 INSERT ... SELECT ... WHERE EXISTS、
 * 级联删除、MAX(version) 取值）没有任何自动化验证。
 */

const now = new Date('2026-09-08T02:00:00.000Z');
const admin = { id: 'admin-1', email: 'admin@signal40.test', role: 'admin' as const };
const editor = { id: 'editor-1', email: 'editor@signal40.test', role: 'editor' as const };

function verifiedTopic() {
  const topic = runPipeline(sampleArticles(now), now).find((candidate) => candidate.gate.passed);
  assert.ok(topic, '样例数据应产出一个通过门禁的话题');
  return { ...topic, verificationStatus: 'verified' as const };
}

async function seedProject(db: Awaited<ReturnType<typeof createMemoryPg>>) {
  const articles = sampleArticles(now);
  const topics = runPipeline(articles, now);
  // 按真实顺序来：文章和话题先落库，项目才建得起来。
  // evidence_links.article_id 有指向 articles 的外键，PG 会严格执行——
  // 之前的本地 D1 没开外键约束，所以这条约束一直没被验证过。
  await persistPipeline(db, topics, 'sample', articles.length, now);

  const topic = verifiedTopic();
  const project = createProjectV2(topic, now);
  const created = await createContentProject(db, project, admin, now);
  assert.equal(created.created, true);
  return created.project;
}

void test('建项目会连带写入声明、证据与首个脚本/分镜版本', async () => {
  const db = await createMemoryPg();
  const record = await seedProject(db);

  const claims = await db.client.query('SELECT COUNT(*) AS total FROM claims WHERE project_id = $1', [record.id]);
  const evidence = await db.client.query('SELECT COUNT(*) AS total FROM evidence_links');
  const scripts = await db.client.query('SELECT COUNT(*) AS total FROM script_versions WHERE project_id = $1', [record.id]);
  const storyboards = await db.client.query('SELECT COUNT(*) AS total FROM storyboard_versions WHERE project_id = $1', [record.id]);

  assert.equal(Number((claims.rows[0] as { total: number }).total), record.project.research.claims.length);
  assert.ok(Number((evidence.rows[0] as { total: number }).total) > 0, '证据链接应落库');
  assert.equal(Number((scripts.rows[0] as { total: number }).total), 1);
  assert.equal(Number((storyboards.rows[0] as { total: number }).total), 1);

  // 同一个项目 ID 再建一次应该是幂等的，不重复插入。
  const again = await createContentProject(db, record.project, admin, now);
  assert.equal(again.created, false);

  const audit = await listProjectAudit(db, record.id);
  assert.ok(audit.some((event) => (event as { action?: string }).action === 'project.created'));
});

void test('分镜保存推进状态并追加版本，过期版本号被拒', async () => {
  const db = await createMemoryPg();
  const record = await seedProject(db);
  await db.client.query("UPDATE content_projects SET state = 'SCRIPT_APPROVED' WHERE id = $1", [record.id]);
  const current = (await loadContentProject(db, record.id))!;

  const saved = await saveProjectSection(db, {
    projectId: record.id,
    expectedVersion: current.version,
    section: 'storyboard',
    value: current.project.timeline,
    actor: admin,
  }, now);
  assert.ok('project' in saved && saved.project, `分镜保存应成功，实际：${JSON.stringify(saved)}`);

  const versions = await db.client.query('SELECT COUNT(*) AS total FROM storyboard_versions WHERE project_id = $1', [record.id]);
  assert.equal(Number((versions.rows[0] as { total: number }).total), 2, 'MAX(version)+1 应产出第二个分镜版本');

  const stale = await saveProjectSection(db, {
    projectId: record.id,
    expectedVersion: current.version,
    section: 'storyboard',
    value: current.project.timeline,
    actor: admin,
  }, now);
  assert.equal('status' in stale ? stale.status : null, 409, '过期版本号必须被拒');
});

void test('研究快照重写会替换声明与证据，并刷新批准哈希', async () => {
  const db = await createMemoryPg();
  const record = await seedProject(db);
  await db.client.query("UPDATE content_projects SET state = 'RESEARCHING' WHERE id = $1", [record.id]);
  const current = (await loadContentProject(db, record.id))!;

  const research = structuredClone(current.project.research);
  research.claims = research.claims.slice(0, 1);
  research.approvedHash = stableHash({ claims: research.claims, conflicts: research.conflicts });

  const saved = await saveResearchSnapshot(db, {
    projectId: record.id,
    expectedVersion: current.version,
    research,
    actor: editor,
  }, now);
  assert.ok('project' in saved && saved.project, `研究快照保存应成功，实际：${JSON.stringify(saved)}`);

  const claims = await db.client.query('SELECT COUNT(*) AS total FROM claims WHERE project_id = $1', [record.id]);
  assert.equal(Number((claims.rows[0] as { total: number }).total), 1, '旧声明应被级联替换');

  const orphanEvidence = await db.client.query(
    'SELECT COUNT(*) AS total FROM evidence_links e LEFT JOIN claims c ON c.id = e.claim_id WHERE c.id IS NULL',
  );
  assert.equal(Number((orphanEvidence.rows[0] as { total: number }).total), 0, '不应留下孤儿证据');
});

void test('并发写入导致守卫失配时以 VERSION_CONFLICT 结束且不留审计', async () => {
  const db = await createMemoryPg();
  const record = await seedProject(db);
  const auditBefore = (await listProjectAudit(db, record.id)).length;

  const conflicting = {
    prepare: (sql: string) => db.prepare(sql),
    batch: async (statements: unknown[]) => {
      // 读到版本之后、写入之前被别人改掉。
      await db.client.query('UPDATE content_projects SET version = version + 1 WHERE id = $1', [record.id]);
      return db.batch(statements as never);
    },
    transaction: (run: (tx: unknown) => Promise<unknown>) => db.transaction(async (tx) => {
      await db.client.query('UPDATE content_projects SET version = version + 1 WHERE id = $1', [record.id]);
      return run(tx);
    }),
  } as never;

  const gates = await evaluateProjectGates(db, record.id);
  await assert.rejects(
    () => transitionContentProject(conflicting, {
      projectId: record.id,
      expectedVersion: record.version,
      to: 'RESEARCHING',
      gates,
      note: '并发写入',
      actor: admin,
    }, now),
    (error: unknown) => error instanceof WorkflowError && error.code === 'VERSION_CONFLICT',
  );

  assert.equal((await listProjectAudit(db, record.id)).length, auditBefore, '冲突时不该留下审计事件');
});
