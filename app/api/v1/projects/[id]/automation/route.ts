import { db, resolveRequestActor } from '@/lib/runtime';
import { loadContentProject, pauseProjectAutomation, resumeProjectAutomation } from '@/lib/control-plane';
import { loadAutomationPolicy } from '@/lib/automation';
import { stableHash } from '@/lib/workflow';

/**
 * 按项目接管或交还自动化。
 *
 * 恢复自动必须是人的显式动作：`automation_mode` 会被任何人工编辑、审批
 * 或内容事件改成 manual，引擎自己不会把它改回去。
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['editor', 'producer', 'publisher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权调整自动化。' }, { status: 403 });
  let body: { action?: string; reason?: string; policyId?: string | null };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!['pause', 'resume'].includes(body.action ?? '')) return Response.json({ error: 'action 必须是 pause 或 resume。' }, { status: 422 });
  const { id } = await context.params;
  const project = await loadContentProject(db, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (body.action === 'resume') {
    const openIncident = await db.prepare("SELECT id FROM content_incidents WHERE project_id = ? AND status = 'open' LIMIT 1").bind(id).first();
    if (openIncident) return Response.json({ error: '项目存在未关闭的内容事件，关闭事件前不能恢复自动化。' }, { status: 409 });
    if (body.policyId) {
      const policy = await loadAutomationPolicy(db, body.policyId);
      if (!policy) return Response.json({ error: '策略不存在。' }, { status: 422 });
    }
    await resumeProjectAutomation(db, id, body.policyId ?? project.automationPolicyId ?? null);
  } else {
    if (!body.reason?.trim() || body.reason.trim().length < 5) return Response.json({ error: '暂停自动化时必须写明原因（至少 5 个字）。' }, { status: 422 });
    await pauseProjectAutomation(db, id, body.reason.trim());
  }
  const timestamp = new Date().toISOString();
  await db
    .prepare(`
      INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, 'content_project', ?, ?, ?, ?, ?)
    `)
    .bind(`audit_${crypto.randomUUID()}`, id, actor.id, actor.role, `automation.${body.action}d`, id, stableHash({ id, action: body.action, reason: body.reason ?? null }), JSON.stringify({ action: body.action, reason: body.reason ?? null, policyId: body.policyId ?? null, trigger: 'human' }), crypto.randomUUID(), timestamp)
    .run();
  const updated = await loadContentProject(db, id);
  return Response.json({ project: updated });
}
