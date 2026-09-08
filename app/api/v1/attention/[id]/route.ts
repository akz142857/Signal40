import { db, resolveRequestActor } from '@/lib/runtime';
import { resolveAttentionItem } from '@/lib/attention';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role === 'auditor') return Response.json({ error: '当前角色无权处理待办。' }, { status: 403 });
  let body: { action?: string; note?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (body.action !== 'resolve') return Response.json({ error: 'action 只支持 resolve。' }, { status: 422 });
  if (!body.note?.trim() || body.note.trim().length < 5) return Response.json({ error: '处理待办时必须写明处置说明（至少 5 个字）。' }, { status: 422 });
  const { id } = await context.params;
  const result = await resolveAttentionItem(db, { id, actor, note: body.note.trim() });
  if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ id: result.id, status: 'resolved' });
}
