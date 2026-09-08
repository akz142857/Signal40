import { config, db } from '@/lib/runtime';
import { leaseNextJob } from '@/lib/control-plane';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request) {
  if (!(await authorizeWorker(request, config.workerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { workerId?: string; kinds?: string[]; leaseSeconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!body.workerId || !Array.isArray(body.kinds) || !body.kinds.length)
    return Response.json({ error: 'workerId 和 kinds 必填。' }, { status: 422 });
  try {
    const job = await leaseNextJob(db, {
      workerId: body.workerId.slice(0, 160),
      kinds: body.kinds.slice(0, 6),
      leaseSeconds: Math.min(1800, Math.max(30, body.leaseSeconds ?? 300)),
      renderConcurrencyLimit: Math.min(100, Math.max(1, Number(config.renderConcurrencyLimit ?? 2))),
    });
    return job ? Response.json({ job }) : new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: '作业租约失败。' }, { status: 503 });
  }
}
