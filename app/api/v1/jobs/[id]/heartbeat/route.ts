import { config, db } from '@/lib/runtime';
import { renewJobLease } from '@/lib/control-plane';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const job = await db.prepare('SELECT kind FROM jobs WHERE id = ? LIMIT 1').bind(id).first<{ kind: string }>();
  const token = job?.kind === 'ingestion' ? config.sourceWorkerToken : job ? config.renderWorkerToken : config.workerToken;
  if (!(await authorizeWorker(request, token))) return Response.json({ error: 'Worker 未授权或不属于该服务范围。' }, { status: 401 });
  let body: { workerId?: string; leaseEpoch?: number; leaseSeconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!body.workerId || !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1) return Response.json({ error: 'workerId 和有效 leaseEpoch 必填。' }, { status: 422 });
  try {
    const result = await renewJobLease(db, {
      id,
      workerId: body.workerId.slice(0, 160),
      leaseEpoch: Number(body.leaseEpoch),
      leaseSeconds: Math.min(1800, Math.max(30, body.leaseSeconds ?? 300)),
    });
    if ('error' in result) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ job: result });
  } catch {
    return Response.json({ error: '作业续约失败。' }, { status: 503 });
  }
}
