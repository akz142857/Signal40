import { config, db, resolveRequestActor } from '@/lib/runtime';
import { resolveAutomationActor } from '@/lib/orchestrator';
import { stableHash } from '@/lib/workflow';

type ControlRow = { paused: number; reason: string; updated_by: string | null; updated_at: string };

/**
 * 建表迁移播种了 `updated_at = '1970-01-01T00:00:00.000Z'` 当「从未改动过」的哨兵。
 * 它不是一个真实的操作时间，投影成 null，界面就不会渲染出
 * 「1970/1/1 · 未知操作者动过总开关」这种句子。
 */
function normalizeUpdatedAt(value: string | null) {
  if (!value) return null;
  const at = new Date(value).valueOf();
  return Number.isNaN(at) || at <= 0 ? null : value;
}

async function readControl() {
  const row = await db.prepare("SELECT paused, reason, updated_by, updated_at FROM automation_control WHERE id = 'global'").first<ControlRow>();
  if (!row) return { paused: false, reason: '', updatedBy: null, updatedAt: null };
  const updatedAt = normalizeUpdatedAt(row.updated_at);
  return {
    paused: Number(row.paused) === 1,
    reason: row.reason,
    updatedBy: updatedAt ? row.updated_by : null,
    updatedAt,
  };
}

/**
 * 引擎能不能真的干活。
 *
 * `paused = 0` 只说明总开关没关，不说明背后有东西在跑：没有配置服务账号时
 * `runAutomationTick` 整轮不写任何东西，scheduler 进程没起来就一轮都不会有。
 * 这两件事以前只能在 /inbox 和日志里看到，自动化控制台却照样显示「运行中」。
 */
async function readEngine() {
  const actor = await resolveAutomationActor(db, config.automationActorId);
  const lastRun = await db
    .prepare('SELECT started_at, status, errors_json FROM automation_runs ORDER BY started_at DESC LIMIT 1')
    .first<{ started_at: string; status: string; errors_json: string }>();
  // 跳过原因没有独立列，它以 { stage: 'tick' } 的形式落在 errors_json 里。
  let lastRunNote: string | null = null;
  if (lastRun) {
    try {
      const errors = JSON.parse(lastRun.errors_json) as Array<{ stage?: string; message?: string }>;
      lastRunNote = errors.find((item) => item.stage === 'tick')?.message ?? null;
    } catch { lastRunNote = null; }
  }
  return {
    actorConfigured: Boolean(actor),
    actorId: actor?.id ?? null,
    lastRunAt: lastRun?.started_at ?? null,
    lastRunStatus: lastRun?.status ?? null,
    lastRunNote,
  };
}

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看自动化总开关。' }, { status: 403 });
  const [control, engine] = await Promise.all([readControl(), readEngine()]);
  return Response.json({ control, engine });
}

export async function PATCH(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以修改自动化总开关。' }, { status: 403 });
  let body: { paused?: boolean; reason?: string };
  try { body = await request.json() as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (typeof body.paused !== 'boolean') return Response.json({ error: 'paused 必须是布尔值。' }, { status: 422 });
  const reason = body.reason?.trim() ?? '';
  if (body.paused && !reason) return Response.json({ error: '全局暂停时必须填写原因。' }, { status: 422 });
  const before = await readControl();
  const now = new Date().toISOString();
  const after = { paused: body.paused, reason: body.paused ? reason : '', updatedBy: actor.id, updatedAt: now };
  await db.batch([
    db.prepare(`
      INSERT INTO automation_control (id, paused, reason, updated_by, updated_at)
      VALUES ('global', ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).bind(after.paused ? 1 : 0, after.reason, actor.id, now),
    db.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, ?, 'automation_control', 'global', ?, ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, after.paused ? 'automation.globally_paused' : 'automation.globally_resumed', stableHash(before), stableHash(after), JSON.stringify({ trigger: 'human', reason: after.reason }), crypto.randomUUID(), now),
  ]);
  return Response.json({ control: after, engine: await readEngine() });
}
