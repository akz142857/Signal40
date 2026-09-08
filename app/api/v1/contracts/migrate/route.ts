import { env } from 'cloudflare:workers';
import { migrateProjectV1, validateProjectV2 } from '@/lib/project-v2';
import { resolveActor } from '@/lib/workflow';

export async function POST(request: Request) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  if (!['researcher', 'editor', 'producer', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权迁移项目协议。' }, { status: 403 });
  try {
    const legacy = (await request.json()) as Parameters<typeof migrateProjectV1>[0];
    const project = migrateProjectV1(legacy);
    const validation = validateProjectV2(project);
    return Response.json({ project, validation });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '迁移失败。' }, { status: 422 });
  }
}
