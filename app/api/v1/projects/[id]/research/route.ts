import { env } from 'cloudflare:workers';
import { loadContentProject, saveResearchSnapshot } from '@/lib/control-plane';
import type { VideoProjectV2 } from '@/lib/project-v2';
import { parseIfMatch, quoteEtag, resolveActor } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const project = await loadContentProject(env.DB, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  return Response.json({ research: project.project.research }, { headers: { ETag: quoteEtag(project.version) } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const expectedVersion = parseIfMatch(request.headers.get('if-match'));
  if (expectedVersion === null) return Response.json({ error: 'If-Match 必填。' }, { status: 428 });
  let body: { research?: VideoProjectV2['research'] };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.research) return Response.json({ error: 'research 必填。' }, { status: 422 });
  const { id } = await context.params;
  try {
    const result = await saveResearchSnapshot(env.DB, { projectId: id, expectedVersion, research: body.research, actor });
    if ('error' in result) return Response.json({ error: result.error, project: result.project }, { status: result.status });
    return Response.json({ project: result.project }, { headers: { ETag: quoteEtag(result.project.version) } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '研究快照保存失败。' }, { status: 409 });
  }
}
