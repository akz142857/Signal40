import { config, db } from '@/lib/runtime';
import { leaseNextJob } from '@/lib/control-plane';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request) {
  let body: { workerId?: string; kinds?: string[]; capabilities?: string[]; capabilityProtocolVersions?: Record<string, unknown>; maxPayloadSchemaVersion?: number; leaseSeconds?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!body.workerId || !Array.isArray(body.kinds) || !body.kinds.length)
    return Response.json({ error: 'workerId 和 kinds 必填。' }, { status: 422 });
  const sourceOnly = body.kinds.every((kind) => kind === 'ingestion');
  const renderOnly = body.kinds.every((kind) => kind !== 'ingestion');
  const token = sourceOnly ? config.sourceWorkerToken : renderOnly ? config.renderWorkerToken : config.workerToken;
  if (!(await authorizeWorker(request, token))) return Response.json({ error: 'Worker 未授权或请求了越界作业类型。' }, { status: 401 });
  try {
    const capabilities = (body.capabilities ?? []).filter((value): value is string => typeof value === 'string' && /^source:[a-z0-9-]{1,40}$/.test(value)).slice(0, 20);
    const capabilityProtocolVersions = Object.fromEntries(
      capabilities.map((capability) => {
        const candidate = body.capabilityProtocolVersions?.[capability];
        return [
          capability,
          Number.isInteger(candidate)
            ? Math.max(1, Math.min(100, Number(candidate)))
            : 1,
        ];
      }),
    );
    const job = await leaseNextJob(db, {
      workerId: body.workerId.slice(0, 160),
      kinds: body.kinds.slice(0, 6),
      capabilities,
      capabilityProtocolVersions,
      maxPayloadSchemaVersion: Number.isInteger(body.maxPayloadSchemaVersion) ? Math.max(1, Math.min(100, Number(body.maxPayloadSchemaVersion))) : 1,
      leaseSeconds: Math.min(1800, Math.max(30, body.leaseSeconds ?? 300)),
      renderConcurrencyLimit: Math.min(100, Math.max(1, Number(config.renderConcurrencyLimit ?? 2))),
    });
    return job ? Response.json({ job }) : new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: '作业租约失败。' }, { status: 503 });
  }
}
