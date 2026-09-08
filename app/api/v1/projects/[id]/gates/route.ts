import { env } from 'cloudflare:workers';
import { evaluateProjectGates, loadContentProject } from '@/lib/control-plane';
import { resolveActor } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const project = await loadContentProject(env.DB, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  return Response.json({ gates: await evaluateProjectGates(env.DB, id) });
}
