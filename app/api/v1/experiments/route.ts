import { env } from 'cloudflare:workers';
import { resolveActor, stableHash } from '@/lib/workflow';

export async function GET(request: Request) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const result = await env.DB.prepare('SELECT * FROM experiments ORDER BY created_at DESC LIMIT 200').all();
  return Response.json({ experiments: result.results.map((row) => ({ ...row, variants: JSON.parse(String(row.variants_json)), allocationBps: JSON.parse(String(row.allocation_bps_json)), guardrails: JSON.parse(String(row.guardrails_json)), variants_json: undefined, allocation_bps_json: undefined, guardrails_json: undefined })) });
}

export async function POST(request: Request) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以创建实验。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  let body: { name?: string; hypothesis?: string; variants?: string[]; allocationBps?: number[]; primaryMetric?: string; guardrails?: string[]; startsAt?: string | null; endsAt?: string | null };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.name?.trim() || !body.hypothesis?.trim() || !body.primaryMetric?.trim() || !Array.isArray(body.variants) || body.variants.length < 2 || new Set(body.variants).size !== body.variants.length || !Array.isArray(body.allocationBps) || body.allocationBps.length !== body.variants.length || body.allocationBps.some((value) => !Number.isInteger(value) || value < 1) || body.allocationBps.reduce((sum, value) => sum + value, 0) !== 10_000) return Response.json({ error: '实验名称、假设、指标、唯一变体和总计 10000 bps 的分流必填。' }, { status: 422 });
  const existing = await env.DB.prepare("SELECT entity_id FROM audit_events WHERE action = 'experiment.created' AND json_extract(metadata_json, '$.idempotencyKey') = ? LIMIT 1").bind(key).first<{ entity_id: string }>();
  if (existing) return Response.json({ experiment: { id: existing.entity_id }, replayed: true });
  const id = `experiment_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO experiments (id, name, hypothesis, status, variants_json, allocation_bps_json, primary_metric, guardrails_json, created_by, starts_at, ends_at, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, body.name.trim(), body.hypothesis.trim(), JSON.stringify(body.variants), JSON.stringify(body.allocationBps), body.primaryMetric.trim(), JSON.stringify(body.guardrails ?? []), actor.id, body.startsAt ?? null, body.endsAt ?? null, now, now),
    env.DB.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'experiment.created', 'experiment', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash(body), JSON.stringify({ idempotencyKey: key }), crypto.randomUUID(), now),
  ]);
  return Response.json({ experiment: { id, status: 'draft' } }, { status: 201 });
}
