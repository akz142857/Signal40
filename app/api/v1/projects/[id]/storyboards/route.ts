import { env } from 'cloudflare:workers';
import { loadContentProject, saveProjectSection } from '@/lib/control-plane';
import type { VideoProjectV2 } from '@/lib/project-v2';
import { parseIfMatch, quoteEtag, resolveActor } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const project = await loadContentProject(env.DB, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  const versions = await env.DB.prepare('SELECT id, version, storyboard_json, content_hash, created_by, created_at FROM storyboard_versions WHERE project_id = ? ORDER BY version DESC').bind(id).all();
  return Response.json({ current: project.project.timeline, versions: versions.results.map((row) => ({ ...row, storyboard: JSON.parse(typeof row.storyboard_json === 'string' ? row.storyboard_json : '[]'), storyboard_json: undefined })) });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const expectedVersion = parseIfMatch(request.headers.get('if-match'));
  if (expectedVersion === null) return Response.json({ error: 'If-Match 必填。' }, { status: 428 });
  let body: { timeline?: VideoProjectV2['timeline'] };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.timeline) return Response.json({ error: 'timeline 必填。' }, { status: 422 });
  const { id } = await context.params;
  const result = await saveProjectSection(env.DB, { projectId: id, expectedVersion, section: 'storyboard', value: body.timeline, actor });
  if ('error' in result) return Response.json({ error: result.error, project: result.project }, { status: result.status });
  return Response.json({ project: result.project }, { headers: { ETag: quoteEtag(result.project.version) } });
}
