import { config, db, resolveRequestActor } from '@/lib/runtime';
import { validateSourceConfig, type SourceConfigInput } from '@/lib/source-adapters';
import { authorizeWorker } from '@/lib/worker-auth';
import { stableHash } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.workerToken))) {
    return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  }
  const { id } = await context.params;
  const source = await db.prepare(
    'SELECT id, name, adapter, config_json, rights_status, rate_limit_per_minute, retention_mode, retention_days, enabled, version, schedule_cron, checkpoint FROM source_configs WHERE id = ? LIMIT 1',
  ).bind(id).first<Record<string, unknown>>();
  if (!source) return Response.json({ error: '来源不存在。' }, { status: 404 });
  return Response.json({
    source: {
      ...source,
      config: JSON.parse(typeof source.config_json === 'string' ? source.config_json : '{}'),
      config_json: undefined,
    },
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以修改来源授权与调度。' }, { status: 403 });
  let body: SourceConfigInput & { expectedVersion?: number; enabled?: boolean };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1 || typeof body.enabled !== 'boolean') return Response.json({ error: 'expectedVersion 和 enabled 必填。' }, { status: 422 });
  const validation = validateSourceConfig(body, false);
  if (!validation.valid) return Response.json({ error: '来源配置无效。', issues: validation.errors }, { status: 422 });
  if (body.enabled && body.rightsStatus !== 'approved') return Response.json({ error: '受限或禁止来源不能启用。' }, { status: 422 });
  const { id } = await context.params;
  const existing = await db.prepare('SELECT version, config_json, rights_status, rate_limit_per_minute, retention_mode, retention_days, enabled FROM source_configs WHERE id = ? LIMIT 1').bind(id).first<{ version: number; config_json: string; rights_status: string; rate_limit_per_minute: number; retention_mode: string; retention_days: number; enabled: number }>();
  if (!existing) return Response.json({ error: '来源不存在。' }, { status: 404 });
  if (existing.version !== body.expectedVersion) return Response.json({ error: `版本冲突：当前版本为 ${existing.version}。` }, { status: 409 });
  const config = { sourceType: body.sourceType, url: body.url, mapping: body.mapping ?? {} };
  const rateLimitPerMinute = body.rateLimitPerMinute ?? existing.rate_limit_per_minute;
  const retention = body.retention ?? { mode: existing.retention_mode as 'metadata' | 'raw', days: existing.retention_days };
  const now = new Date().toISOString();
  const nextHash = stableHash({ ...body, expectedVersion: undefined });
  const [updated] = await db.batch([
    db.prepare(`
      UPDATE source_configs
      SET name = ?, adapter = ?, config_json = ?, rights_status = ?, enabled = ?,
          rate_limit_per_minute = ?, retention_mode = ?, retention_days = ?,
          schedule_cron = ?, version = version + 1, last_error = NULL, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(body.name.trim(), body.adapter, JSON.stringify(config), body.rightsStatus, body.enabled ? 1 : 0, rateLimitPerMinute, retention.mode, retention.days, body.scheduleCron ?? null, now, id, body.expectedVersion),
    db.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         after_hash, metadata_json, request_id, created_at)
      SELECT ?, ?, ?, 'source.updated', 'source_config', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM source_configs WHERE id = ? AND version = ? AND updated_at = ?)
    `).bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash(existing), nextHash, JSON.stringify({ enabled: body.enabled, rightsStatus: body.rightsStatus }), crypto.randomUUID(), now, id, body.expectedVersion + 1, now),
  ]);
  if (!updated.meta.changes) return Response.json({ error: '来源已被其他管理员修改。' }, { status: 409 });
  return Response.json({ source: { id, ...body, expectedVersion: undefined, rateLimitPerMinute, retention, version: body.expectedVersion + 1, config } });
}
