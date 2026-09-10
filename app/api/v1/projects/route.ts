import { db, resolveRequestActor } from '@/lib/runtime';
import { createContentProject, listContentProjects } from '@/lib/control-plane';
import { loadTopic } from '@/lib/persistence';
import { createProjectV2, validateProjectV2, type VideoProjectV2 } from '@/lib/project-v2';
import { quoteEtag } from '@/lib/workflow';
import { abandonIdempotentRequest, beginIdempotentRequest, completeIdempotencyStatement, validIdempotencyKey } from '@/lib/idempotency';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  try {
    const projects = await listContentProjects(db);
    return Response.json({ projects });
  } catch {
    return Response.json({ error: '项目列表读取失败。' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  if (!['researcher', 'editor', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权创建项目。' }, { status: 403 });
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(idempotencyKey))
    return Response.json({ error: '必须提供有效的 Idempotency-Key。' }, { status: 400 });
  let body: { topicId?: string; project?: VideoProjectV2 };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  try {
    let project: VideoProjectV2;
    if (body.project) {
      const validation = validateProjectV2(body.project);
      if (!validation.valid)
        return Response.json({ error: '项目协议无效。', issues: validation.errors }, { status: 422 });
      project = body.project;
    } else {
      if (!body.topicId) return Response.json({ error: 'topicId 必填。' }, { status: 422 });
      const topic = await loadTopic(db, body.topicId);
      if (!topic) return Response.json({ error: '选题不存在。' }, { status: 404 });
      project = createProjectV2(topic);
    }
    const started = await beginIdempotentRequest(db, {
      scope: `projects.create:${actor.id}`,
      key: idempotencyKey!,
      request: body,
    });
    if (started.kind === 'conflict') return Response.json({ error: '该 Idempotency-Key 已用于不同的项目创建请求。' }, { status: 409 });
    if (started.kind === 'pending') return Response.json({ error: '相同项目创建请求正在处理中。' }, { status: 425, headers: { 'Retry-After': '2' } });
    if (started.kind === 'replay') return Response.json(started.body, { status: started.status, headers: { 'Idempotency-Replayed': 'true', 'Idempotency-Key': idempotencyKey! } });
    let result;
    try {
      result = await db.transaction(async (tx) => {
        const created = await createContentProject(tx, project, actor);
        await completeIdempotencyStatement(tx, started.reservation, created.created ? 201 : 200, created).run();
        return created;
      });
    } catch (error) {
      await abandonIdempotentRequest(db, started.reservation);
      throw error;
    }
    return Response.json(result, {
      status: result.created ? 201 : 200,
      headers: { ETag: quoteEtag(result.project.version), 'Idempotency-Key': idempotencyKey! },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : '项目创建失败。' },
      { status: error instanceof Error && /必须|没有/.test(error.message) ? 409 : 503 },
    );
  }
}
