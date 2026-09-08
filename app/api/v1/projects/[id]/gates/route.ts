import { db, resolveRequestActor } from '@/lib/runtime';
import { evaluateProjectGates, loadContentProject } from '@/lib/control-plane';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const project = await loadContentProject(db, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  return Response.json({ gates: await evaluateProjectGates(db, id) });
}
