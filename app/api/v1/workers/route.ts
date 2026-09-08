import { config, db, resolveRequestActor } from '@/lib/runtime';
import { authorizeWorker } from '@/lib/worker-auth';
import { listWorkers, orphanedJobs, queueBacklog, recordWorkerHeartbeat } from '@/lib/workers';

const KINDS = ['ingestion', 'voice', 'preview', 'render', 'qc', 'publish', 'metrics'];

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const now = new Date();
  const [workers, backlog, orphans] = await Promise.all([listWorkers(db, now), queueBacklog(db), orphanedJobs(db, {}, now)]);
  return Response.json({ workers, backlog, orphanedJobs: orphans, generatedAt: now.toISOString() });
}

/** Worker 心跳。空闲轮询时也上报，界面才能区分「没人执行」和「正在排队」。 */
export async function POST(request: Request) {
  if (!(await authorizeWorker(request, config.workerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { workerId?: string; hostname?: string; kinds?: string[]; version?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.workerId || !/^[\w.-]{1,128}$/.test(body.workerId)) return Response.json({ error: 'workerId 必须是 1–128 个字母、数字、点、下划线或连字符。' }, { status: 422 });
  const kinds = (body.kinds ?? []).filter((kind) => KINDS.includes(kind));
  if (!kinds.length) return Response.json({ error: 'kinds 必须至少包含一个已知作业类型。' }, { status: 422 });
  const result = await recordWorkerHeartbeat(db, {
    id: body.workerId,
    hostname: (body.hostname ?? '').slice(0, 160),
    kinds,
    version: (body.version ?? '').slice(0, 40),
  });
  return Response.json(result);
}
