import { db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';
import { abandonIdempotentRequest, beginIdempotentRequest, completeIdempotencyStatement, validIdempotencyKey } from '@/lib/idempotency';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const result = await db.prepare('SELECT * FROM experiments ORDER BY created_at DESC LIMIT 200').all();
  return Response.json({ experiments: result.results.map((row) => ({ ...row, variants: JSON.parse(String(row.variants_json)), allocationBps: JSON.parse(String(row.allocation_bps_json)), guardrails: JSON.parse(String(row.guardrails_json)), variants_json: undefined, allocation_bps_json: undefined, guardrails_json: undefined })) });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以创建实验。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(key)) return Response.json({ error: '有效的 Idempotency-Key 必填。' }, { status: 400 });
  let body: { name?: string; hypothesis?: string; variants?: string[]; allocationBps?: number[]; primaryMetric?: string; guardrails?: string[]; startsAt?: string | null; endsAt?: string | null };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.name?.trim() || !body.hypothesis?.trim() || !body.primaryMetric?.trim() || !Array.isArray(body.variants) || body.variants.length < 2 || new Set(body.variants).size !== body.variants.length || !Array.isArray(body.allocationBps) || body.allocationBps.length !== body.variants.length || body.allocationBps.some((value) => !Number.isInteger(value) || value < 1) || body.allocationBps.reduce((sum, value) => sum + value, 0) !== 10_000) return Response.json({ error: '实验名称、假设、指标、唯一变体和总计 10000 bps 的分流必填。' }, { status: 422 });
  const name = body.name.trim();
  const hypothesis = body.hypothesis.trim();
  const primaryMetric = body.primaryMetric.trim();
  const started = await beginIdempotentRequest(db, { scope: `experiments.create:${actor.id}`, key: key!, request: body });
  if (started.kind === 'conflict') return Response.json({ error: '该 Idempotency-Key 已用于不同的实验创建请求。' }, { status: 409 });
  if (started.kind === 'pending') return Response.json({ error: '相同实验创建请求正在处理中。' }, { status: 425, headers: { 'Retry-After': '2' } });
  if (started.kind === 'replay') return Response.json(started.body, { status: started.status, headers: { 'Idempotency-Replayed': 'true' } });
  const id = `experiment_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const responseBody = { experiment: { id, status: 'draft' } };
  try {
    await db.transaction(async (tx) => {
      await tx.batch([
        tx.prepare("INSERT INTO experiments (id, name, hypothesis, status, variants_json, allocation_bps_json, primary_metric, guardrails_json, created_by, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, name, hypothesis, JSON.stringify(body.variants), JSON.stringify(body.allocationBps), primaryMetric, JSON.stringify(body.guardrails ?? []), actor.id, body.startsAt ?? null, body.endsAt ?? null, now, now),
        tx.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'experiment.created', 'experiment', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash(body), JSON.stringify({ idempotencyKey: key }), crypto.randomUUID(), now),
        completeIdempotencyStatement(tx, started.reservation, 201, responseBody),
      ]);
    });
  } catch {
    await abandonIdempotentRequest(db, started.reservation);
    return Response.json({ error: '实验保存失败。' }, { status: 503 });
  }
  return Response.json(responseBody, { status: 201 });
}
