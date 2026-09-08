import { db, resolveRequestActor } from '@/lib/runtime';
import { enqueueIngestionRun } from '@/lib/control-plane';
import { validateSourceConfig, type SourceConfigInput } from '@/lib/source-adapters';
import { stableHash } from '@/lib/workflow';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const result = await db.prepare('SELECT id, name, adapter, config_json, rights_status, rate_limit_per_minute, retention_mode, retention_days, enabled, version, schedule_cron, checkpoint, last_success_at, last_error, created_at, updated_at FROM source_configs ORDER BY name').all();
  return Response.json({ sources: result.results.map((row) => ({ ...row, config: JSON.parse(typeof row.config_json === 'string' ? row.config_json : '{}'), config_json: undefined })) });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  if (actor.role !== 'admin') return Response.json({ error: '只有管理员可以登记来源授权。' }, { status: 403 });
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  let input: SourceConfigInput;
  try { input = (await request.json()) as SourceConfigInput; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const validation = validateSourceConfig(input);
  if (!validation.valid) return Response.json({ error: '来源配置无效。', issues: validation.errors }, { status: 422 });
  const existing = await db.prepare("SELECT id FROM audit_events WHERE action = 'source.created' AND metadata_json ->> 'idempotencyKey' = ? LIMIT 1").bind(idempotencyKey).first<{ id: string }>();
  if (existing) return Response.json({ replayed: true }, { status: 200 });
  const id = `source_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const config = { sourceType: input.sourceType, url: input.url, mapping: input.mapping ?? {} };
  const rateLimitPerMinute = input.rateLimitPerMinute ?? 30;
  const retention = input.retention ?? { mode: 'metadata' as const, days: 30 };
  await db.batch([
    db.prepare(`INSERT INTO source_configs (id, name, adapter, config_json, rights_status, rate_limit_per_minute, retention_mode, retention_days, enabled, version, schedule_cron, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`).bind(id, input.name.trim(), input.adapter, JSON.stringify(config), input.rightsStatus, rateLimitPerMinute, retention.mode, retention.days, input.scheduleCron ?? null, now, now),
    db.prepare(`INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'source.created', 'source_config', ?, ?, ?, ?, ?)`).bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash(input), JSON.stringify({ idempotencyKey }), crypto.randomUUID(), now),
  ]);
  const scheduled = input.scheduleCron ? await enqueueIngestionRun(db, { sourceConfigId: id, idempotencyKey: `initial:${id}`, actor }) : null;
  return Response.json({ source: { id, ...input, rateLimitPerMinute, retention, version: 1 }, initialJob: scheduled }, { status: 201 });
}
