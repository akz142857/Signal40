import { config, db } from '@/lib/runtime';
import { finishJob } from '@/lib/control-plane';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await db.prepare('SELECT kind FROM jobs WHERE id = ? LIMIT 1').bind(id).first<{ kind: string }>();
  const token = job?.kind === 'ingestion' ? config.sourceWorkerToken : job ? config.renderWorkerToken : config.workerToken;
  if (!(await authorizeWorker(request, token))) return Response.json({ error: 'Worker 未授权或不属于该服务范围。' }, { status: 401 });
  let body: { workerId?: string; leaseEpoch?: number; succeeded?: boolean; result?: unknown; error?: string; errorCode?: string; retryDelaySeconds?: number; terminal?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!body.workerId || !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1 || typeof body.succeeded !== 'boolean')
    return Response.json({ error: 'workerId、有效 leaseEpoch 和 succeeded 必填。' }, { status: 422 });
  try {
    const result = await finishJob(db, {
      id,
      workerId: body.workerId,
      leaseEpoch: Number(body.leaseEpoch),
      succeeded: body.succeeded,
      result: body.result,
      error: body.error?.slice(0, 4000),
      errorCode: body.errorCode?.slice(0, 80),
      retryDelaySeconds: body.retryDelaySeconds,
      terminal: body.terminal === true,
    });
    if ('error' in result) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ job: result });
  } catch {
    return Response.json({ error: '作业完成状态保存失败。' }, { status: 503 });
  }
}
