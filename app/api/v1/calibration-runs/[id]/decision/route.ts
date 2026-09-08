import { db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['editor', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权审批校准运行。' }, { status: 403 });
  let body: { decision?: string; note?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!['approved', 'rejected'].includes(body.decision || '') || !body.note?.trim() || body.note.trim().length < 10) return Response.json({ error: 'decision 与至少 10 字审批说明必填。' }, { status: 422 });
  const { id } = await context.params;
  const run = await db.prepare("SELECT id, status, created_by FROM calibration_runs WHERE id = ? LIMIT 1").bind(id).first<{ id: string; status: string; created_by: string }>();
  if (!run) return Response.json({ error: '校准运行不存在。' }, { status: 404 });
  if (run.status !== 'candidate') return Response.json({ error: `校准运行已处于 ${run.status}。` }, { status: 409 });
  if (run.created_by === actor.id) return Response.json({ error: '校准提交者不能审批自己的结果。' }, { status: 409 });
  const now = new Date().toISOString();
  await db.batch([
    db.prepare('UPDATE calibration_runs SET status = ?, approved_by = ?, note = ?, updated_at = ? WHERE id = ? AND status = \'candidate\'').bind(body.decision, actor.id, body.note.trim(), now, id),
    db.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'calibration_run', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, `calibration.${body.decision}`, id, stableHash(body), JSON.stringify({ note: body.note.trim() }), crypto.randomUUID(), now),
  ]);
  return Response.json({ run: { id, status: body.decision } });
}
