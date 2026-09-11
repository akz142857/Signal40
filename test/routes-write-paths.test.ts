import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { createMemoryPg } from './pg-memory.ts';
import { setRouteTestContext, setRouteTestActor } from './route-runtime.ts';
import type { Actor } from '../lib/workflow.ts';

/**
 * 路由级写路径测试：真正执行 `app/api/**` 里的处理函数和它们的 SQL。
 *
 * 存在的理由是一次真实事故：`team_members`（8 列 / 9 值）与 `source_configs`
 * （33 列 / 31 值，且 'draft'/'unknown'/'pending' 整体错位两列）两条 INSERT
 * 都会被 PostgreSQL 直接拒绝，也就是「添加成员」和「创建来源」这两条 API
 * 从来没有成功过。它们通过了 lint、tsc 和全部 260 项测试，因为既有的
 * 「路由测试」只是 readFile 断言源码文本，从不执行路由。见 R-ROUTE-SQL-01。
 *
 * 所以这里断言的不是文本，而是 HTTP 状态码和落库结果：路由跑不通就红。
 */

register('./route-alias-hook.mjs', import.meta.url);

const admin: Actor = { id: 'admin-one', email: 'one@example.com', role: 'admin' } as Actor;
const secondAdmin: Actor = { id: 'admin-two', email: 'two@example.com', role: 'admin' } as Actor;
const researcher: Actor = { id: 'researcher-one', email: 'r@example.com', role: 'researcher' } as Actor;

const database = await createMemoryPg();
setRouteTestContext({ db: database, actor: admin });

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

void test('POST /api/v1/team-members 真正写入成员并记审计', async () => {
  const { POST } = await import('../app/api/v1/team-members/route.ts');
  setRouteTestActor(admin);

  const response = await POST(jsonRequest('http://local/api/v1/team-members', {
    userId: 'admin-two',
    email: 'two@example.com',
    role: 'admin',
    canApproveSourceRights: true,
  }, { 'idempotency-key': 'member-1' }));

  assert.equal(response.status, 201, await response.clone().text());
  const payload = await response.json() as { member: { userId: string; canApproveSourceRights: boolean } };
  assert.equal(payload.member.userId, 'admin-two');
  assert.equal(payload.member.canApproveSourceRights, true);

  const stored = await database.prepare(
    'SELECT user_id, email, role, status, can_approve_source_rights FROM team_members WHERE user_id = ?',
  ).bind('admin-two').first<{ user_id: string; email: string; role: string; status: string; can_approve_source_rights: number }>();
  assert.equal(stored?.email, 'two@example.com');
  assert.equal(stored?.role, 'admin');
  assert.equal(stored?.status, 'active');
  assert.equal(Number(stored?.can_approve_source_rights), 1);

  const audit = await database.prepare(
    "SELECT entity_id FROM audit_events WHERE action = 'member.created' AND entity_id = ?",
  ).bind('admin-two').first();
  assert.ok(audit, '成员创建必须写审计事件');
});

void test('POST /api/v1/team-members 同键重放返回同一结果而不是重复插入', async () => {
  const { POST } = await import('../app/api/v1/team-members/route.ts');
  setRouteTestActor(admin);

  const replay = await POST(jsonRequest('http://local/api/v1/team-members', {
    userId: 'admin-two',
    email: 'two@example.com',
    role: 'admin',
    canApproveSourceRights: true,
  }, { 'idempotency-key': 'member-1' }));

  assert.equal(replay.status, 200, await replay.clone().text());
  const payload = await replay.json() as { replayed?: boolean };
  assert.equal(payload.replayed, true);

  const count = await database.prepare('SELECT COUNT(*)::int AS total FROM team_members WHERE user_id = ?')
    .bind('admin-two').first<{ total: number }>();
  assert.equal(Number(count?.total), 1);
});

void test('POST /api/v1/team-members 拒绝非管理员', async () => {
  const { POST } = await import('../app/api/v1/team-members/route.ts');
  setRouteTestActor(researcher);
  const response = await POST(jsonRequest('http://local/api/v1/team-members', {
    userId: 'x', email: 'x@example.com', role: 'researcher',
  }, { 'idempotency-key': 'member-forbidden' }));
  assert.equal(response.status, 403);
});

void test('POST /api/v1/source-configs 建出 draft 来源，字段落到正确的列', async () => {
  // 业务负责人必须是 active 成员，先补上第一个 admin 自己。
  const now = new Date().toISOString();
  await database.prepare(
    "INSERT INTO team_members (user_id, email, role, status, can_approve_source_rights, can_manage_source_legal, created_at, updated_at) VALUES (?, ?, 'admin', 'active', ?, ?, ?, ?)",
  ).bind(admin.id, admin.email, 0, 0, now, now).run();

  const { POST } = await import('../app/api/v1/source-configs/route.ts');
  setRouteTestActor(admin);

  const response = await POST(jsonRequest('http://local/api/v1/source-configs', {
    name: '测试 RSS 来源',
    adapter: 'rss',
    platform: 'rss',
    sourceType: 'media',
    url: 'https://example.com/feed.xml',
    rightsStatus: 'pending',
    publicUseConfirmed: true,
    businessOwnerId: admin.id,
    rateLimitPerMinute: 10,
    retention: { mode: 'metadata', days: 90 },
  }, { 'idempotency-key': 'source-1' }));

  assert.equal(response.status, 201, await response.clone().text());
  const payload = await response.json() as { source: { id: string; lifecycleStatus: string; rightsStatus: string } };
  assert.equal(payload.source.lifecycleStatus, 'draft');
  assert.equal(payload.source.rightsStatus, 'pending');

  // 这几列正是错位缺陷的落点：'draft' 曾经被写进 collection_policy_json，
  // 'unknown' 写进 capabilities_json，'pending' 写进 source_type。
  const stored = await database.prepare(`
    SELECT lifecycle_status, health_status, rights_status, source_type, enabled, version,
      collection_policy_json, capabilities_json, created_at, updated_at
    FROM source_configs WHERE id = ?
  `).bind(payload.source.id).first<{
    lifecycle_status: string; health_status: string; rights_status: string; source_type: string;
    enabled: number; version: number; collection_policy_json: unknown; capabilities_json: unknown;
    created_at: string | null; updated_at: string | null;
  }>();

  assert.equal(stored?.lifecycle_status, 'draft');
  assert.equal(stored?.health_status, 'unknown');
  assert.equal(stored?.rights_status, 'pending');
  assert.equal(stored?.source_type, 'media');
  assert.equal(Number(stored?.enabled), 0);
  assert.equal(Number(stored?.version), 1);
  assert.ok(stored?.created_at, 'created_at 不能为空');
  assert.ok(stored?.updated_at, 'updated_at 不能为空');

  const policy = typeof stored?.collection_policy_json === 'string'
    ? JSON.parse(stored.collection_policy_json) as Record<string, unknown>
    : stored?.collection_policy_json as Record<string, unknown>;
  const capabilities = typeof stored?.capabilities_json === 'string'
    ? JSON.parse(stored.capabilities_json) as Record<string, unknown>
    : stored?.capabilities_json as Record<string, unknown>;
  assert.equal(typeof policy, 'object');
  assert.ok('mode' in policy, 'collection_policy_json 必须是采集策略而不是被挤进来的状态字面量');
  assert.ok('test' in capabilities, 'capabilities_json 必须是连接器能力表');
});

void test('POST /api/v1/source-configs 创建时自动挂起权利请求，且不能自批', async () => {
  const source = await database.prepare('SELECT id FROM source_configs LIMIT 1').first<{ id: string }>();
  const pending = await database.prepare(
    "SELECT requested_by, status FROM source_rights_requests WHERE source_config_id = ?",
  ).bind(source!.id).first<{ requested_by: string; status: string }>();

  assert.equal(pending?.status, 'pending');
  assert.equal(pending?.requested_by, admin.id, '权利请求的申请人应当是创建者');
  assert.notEqual(pending?.requested_by, secondAdmin.id, '异人审批要求批准人与申请人不同');
});

void test('POST /api/v1/source-configs 拒绝缺少公开使用声明的请求', async () => {
  const { POST } = await import('../app/api/v1/source-configs/route.ts');
  setRouteTestActor(admin);
  const response = await POST(jsonRequest('http://local/api/v1/source-configs', {
    name: '无声明来源',
    adapter: 'rss',
    platform: 'rss',
    sourceType: 'media',
    url: 'https://example.com/other.xml',
    rightsStatus: 'pending',
    businessOwnerId: admin.id,
  }, { 'idempotency-key': 'source-no-confirm' }));
  assert.equal(response.status, 422);
});

void test('POST /api/v1/source-configs 拒绝直接以 approved 创建', async () => {
  const { POST } = await import('../app/api/v1/source-configs/route.ts');
  setRouteTestActor(admin);
  const response = await POST(jsonRequest('http://local/api/v1/source-configs', {
    name: '越权来源',
    adapter: 'rss',
    platform: 'rss',
    sourceType: 'media',
    url: 'https://example.com/approved.xml',
    rightsStatus: 'approved',
    publicUseConfirmed: true,
    businessOwnerId: admin.id,
  }, { 'idempotency-key': 'source-approved' }));
  assert.equal(response.status, 422);
});

/*
  自动化控制台「这一页说的话要是真的」这一组的回归覆盖。

  三条断言对应三个真实缺陷：策略 PATCH 的版本检查写了却不看结果（丢更新还写假
  审计）；总开关只反映一个配置位，说「运行中」时引擎其实可能一个字都写不了；
  建表迁移播种的 1970 哨兵被当成真实操作时间渲染。
*/

void test('PATCH /api/v1/automation/policies/:id 版本不匹配时报 409，且不写审计', async () => {
  const { POST } = await import('../app/api/v1/automation/policies/route.ts');
  const { PATCH } = await import('../app/api/v1/automation/policies/[id]/route.ts');
  setRouteTestActor(admin);

  const created = await POST(jsonRequest('http://local/api/v1/automation/policies', { name: '并发测试策略' }));
  assert.equal(created.status, 201, await created.clone().text());
  const { policy } = (await created.json()) as { policy: { id: string; version: number } };

  const ok = await PATCH(
    new Request(`http://local/api/v1/automation/policies/${policy.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guardrails: { dailyProjectLimit: 5 } }),
    }),
    { params: Promise.resolve({ id: policy.id }) },
  );
  assert.equal(ok.status, 200, await ok.clone().text());

  const auditBefore = await database
    .prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'automation_policy.updated' AND entity_id = ?")
    .bind(policy.id)
    .first<{ total: number }>();

  // 两个管理员同时改同一条策略：两次都读到同一个版本，只有一次能写进去。
  const patch = (limit: number) =>
    PATCH(
      new Request(`http://local/api/v1/automation/policies/${policy.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ guardrails: { dailyProjectLimit: limit } }),
      }),
      { params: Promise.resolve({ id: policy.id }) },
    );
  const [first, second] = await Promise.all([patch(7), patch(9)]);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], '并发写入必须一成一冲突，而不是双双返回 200');

  const stored = await database
    .prepare('SELECT guardrails_json, version FROM automation_policies WHERE id = ?')
    .bind(policy.id)
    .first<{ guardrails_json: string; version: number }>();
  const storedLimit = (JSON.parse(stored!.guardrails_json) as { dailyProjectLimit: number }).dailyProjectLimit;
  assert.ok([7, 9].includes(storedLimit), '落库的必须是两次写入之一');
  assert.equal(Number(stored?.version), 3, '只有一次写入推进了版本');

  const auditAfter = await database
    .prepare("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'automation_policy.updated' AND entity_id = ?")
    .bind(policy.id)
    .first<{ total: number }>();
  assert.equal(
    Number(auditAfter?.total) - Number(auditBefore?.total),
    1,
    '被拒绝的写入不能留下「改过了」的审计记录',
  );
});

void test('GET /api/v1/automation/control 说明引擎能不能真的写入', async () => {
  const { GET } = await import('../app/api/v1/automation/control/route.ts');
  setRouteTestActor(admin);

  const unconfigured = await GET(new Request('http://local/api/v1/automation/control'));
  assert.equal(unconfigured.status, 200);
  const idle = (await unconfigured.json()) as {
    control: { paused: boolean; updatedAt: string | null; updatedBy: string | null };
    engine: { actorConfigured: boolean; lastRunAt: string | null };
  };
  assert.equal(idle.control.paused, false);
  assert.equal(idle.engine.actorConfigured, false, '没有服务账号时引擎不会写入任何东西，界面必须知道');
  assert.equal(idle.engine.lastRunAt, null, '一轮都没跑过');
  assert.equal(idle.control.updatedAt, null, '迁移播种的 1970 哨兵不是一次真实操作');
  assert.equal(idle.control.updatedBy, null);

  // 指向一个 active 的 admin 成员后，引擎才具备写入能力。
  setRouteTestContext({ db: database, actor: admin, config: { automationActorId: admin.id } });
  const configured = await GET(new Request('http://local/api/v1/automation/control'));
  const ready = (await configured.json()) as { engine: { actorConfigured: boolean; actorId: string | null } };
  assert.equal(ready.engine.actorConfigured, true);
  assert.equal(ready.engine.actorId, admin.id);
  setRouteTestContext({ db: database, actor: admin });
});
