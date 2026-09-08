import { config, db } from '@/lib/runtime';
import { finishJob } from '@/lib/control-plane';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.workerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { workerId?: string; succeeded?: boolean; result?: unknown; error?: string; retryDelaySeconds?: number; terminal?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!body.workerId || typeof body.succeeded !== 'boolean')
    return Response.json({ error: 'workerId 和 succeeded 必填。' }, { status: 422 });
  const { id } = await context.params;
  try {
    const result = await finishJob(db, {
      id,
      workerId: body.workerId,
      succeeded: body.succeeded,
      result: body.result,
      error: body.error?.slice(0, 4000),
      retryDelaySeconds: body.retryDelaySeconds,
      terminal: body.terminal === true,
    });
    if ('error' in result) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ job: result });
  } catch {
    return Response.json({ error: '作业完成状态保存失败。' }, { status: 503 });
  }
}
