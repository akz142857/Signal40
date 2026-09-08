import { db, resolveRequestActor } from '@/lib/runtime';
import { listProjectAudit } from '@/lib/control-plane';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  try {
    return Response.json({ events: await listProjectAudit(db, id) });
  } catch {
    return Response.json({ error: '审计记录读取失败。' }, { status: 503 });
  }
}
