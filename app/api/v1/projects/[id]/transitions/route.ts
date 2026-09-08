import { db, resolveRequestActor } from '@/lib/runtime';
import { evaluateProjectGates, transitionContentProject } from '@/lib/control-plane';
import { CONTENT_STATES, parseIfMatch, quoteEtag, WorkflowError } from '@/lib/workflow';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
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
  if (['RENDERING', 'QC_PENDING'].includes(body.to as string))
    return Response.json({ error: `${body.to} 只能由持有租约的 Worker 或渠道完成回调写入。` }, { status: 409 });
  const { id } = await context.params;
  if (body.to === 'PUBLISHED') {
    // youtube 渠道由渠道回调写入 PUBLISHED；package 渠道只产出待分发包，
    // 内容并没有真的发出去，必须由发布人确认已完成人工分发才算发布。
    // 没有这条通道时，package 渠道的项目永远到不了 PUBLISHED，也就永远过不了 G8。
    const distributed = await db
      .prepare("SELECT id FROM publish_jobs WHERE project_id = ? AND channel = 'package' AND status = 'published' ORDER BY updated_at DESC LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!distributed)
      return Response.json({ error: 'PUBLISHED 只能由渠道回调写入；package 渠道需要先有已完成的发布包。' }, { status: 409 });
    // 人工确认必须留下可追溯的说明，审计里要能看出是谁、依据什么确认已分发。
    if (!body.note || body.note.trim().length < 10)
      return Response.json({ error: '人工确认已分发时必须填写至少 10 个字的说明。' }, { status: 422 });
  }
  try {
    const result = await transitionContentProject(db, {
      projectId: id,
      expectedVersion,
      to: body.to as (typeof CONTENT_STATES)[number],
      note: typeof body.note === 'string' ? body.note.slice(0, 2000) : '',
      gates: await evaluateProjectGates(db, id),
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
