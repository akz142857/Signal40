import { env } from 'cloudflare:workers';
import { evaluateProjectGates, transitionContentProject } from '@/lib/control-plane';
import { CONTENT_STATES, parseIfMatch, quoteEtag, resolveActor, WorkflowError } from '@/lib/workflow';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const expectedVersion = parseIfMatch(request.headers.get('if-match'));
  if (expectedVersion === null)
    return Response.json({ error: '必须提供格式为 "版本号" 的 If-Match。' }, { status: 428 });
  let body: { to?: string; note?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!CONTENT_STATES.includes(body.to as never))
    return Response.json({ error: '目标状态无效。' }, { status: 422 });
  if (['RENDERING', 'QC_PENDING', 'PUBLISHED'].includes(body.to as string))
    return Response.json({ error: `${body.to} 只能由持有租约的 Worker 或渠道完成回调写入。` }, { status: 409 });
  const { id } = await context.params;
  try {
    const result = await transitionContentProject(env.DB, {
      projectId: id,
      expectedVersion,
      to: body.to as (typeof CONTENT_STATES)[number],
      note: typeof body.note === 'string' ? body.note.slice(0, 2000) : '',
      gates: await evaluateProjectGates(env.DB, id),
      actor,
    });
    if ('error' in result)
      return Response.json({ error: result.error, project: result.project }, { status: result.status });
    return Response.json({ project: result.project }, { headers: { ETag: quoteEtag(result.project.version) } });
  } catch (error) {
    if (error instanceof WorkflowError)
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    return Response.json({ error: '状态转换保存失败。' }, { status: 503 });
  }
}
