import { db, resolveRequestActor } from '@/lib/runtime';
import { loadTopic } from '@/lib/persistence';
import { createProjectV2 } from '@/lib/project-v2';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!actor)
    return Response.json(
      { error: '用户未加入 Signal 40 团队。' },
      { status: 403 },
    );
  const { id } = await context.params;
  try {
    const topic = await loadTopic(db, id);
    if (!topic)
      return Response.json({ error: '选题不存在。' }, { status: 404 });
    return Response.json(createProjectV2(topic));
  } catch (error) {
    if (error instanceof Error && /has not/.test(error.message))
      return Response.json({ error: error.message }, { status: 409 });
    return Response.json(
      { error: '无法读取选题或生成视频协议，请稍后重试。' },
      { status: 503 },
    );
  }
}
