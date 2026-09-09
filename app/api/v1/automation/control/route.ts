import { db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';

type ControlRow = { paused: number; reason: string; updated_by: string | null; updated_at: string };

async function readControl() {
  const row = await db.prepare("SELECT paused, reason, updated_by, updated_at FROM automation_control WHERE id = 'global'").first<ControlRow>();
  return row
    ? { paused: Number(row.paused) === 1, reason: row.reason, updatedBy: row.updated_by, updatedAt: row.updated_at }
    : { paused: false, reason: '', updatedBy: null, updatedAt: null };
}

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看自动化总开关。' }, { status: 403 });
  return Response.json({ control: await readControl() });
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
  return Response.json({ control: after });
}
