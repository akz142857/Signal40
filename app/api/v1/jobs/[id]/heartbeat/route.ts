import { config, db } from '@/lib/runtime';
import { renewJobLease } from '@/lib/control-plane';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.workerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { workerId?: string; leaseSeconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!body.workerId) return Response.json({ error: 'workerId 必填。' }, { status: 422 });
  const { id } = await context.params;
  try {
    const result = await renewJobLease(db, {
      id,
      workerId: body.workerId.slice(0, 160),
      leaseSeconds: Math.min(1800, Math.max(30, body.leaseSeconds ?? 300)),
    });
    if ('error' in result) return Response.json({ error: result.error }, { status: 409 });
    return Response.json({ job: result });
  } catch {
    return Response.json({ error: '作业续约失败。' }, { status: 503 });
  }
}
