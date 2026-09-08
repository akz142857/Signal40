import { env } from 'cloudflare:workers';
import { listProjectAudit } from '@/lib/control-plane';
import { resolveActor } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  try {
    return Response.json({ events: await listProjectAudit(env.DB, id) });
  } catch {
    return Response.json({ error: '审计记录读取失败。' }, { status: 503 });
  }
}
