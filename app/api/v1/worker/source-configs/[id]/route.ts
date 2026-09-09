import { config, db } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { authorizeWorker } from '@/lib/worker-auth';

function parseJsonObject(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function requiredString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await authorizeWorker(request, config.sourceWorkerToken))) {
    return sourceApiError('Worker 认证失败。', 401);
  }
  const { id } = await context.params;
  const source = await db
    .prepare(`
      SELECT id, name, adapter, platform, enabled, rights_status, config_hash,
        config_json, credential_ref, credential_version, rate_limit_per_minute,
        retention_mode, retention_days
      FROM source_configs WHERE id = ? LIMIT 1
    `)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!source) return sourceApiError('来源不存在。', 404);
  return Response.json({
    source: {
      id: requiredString(source.id),
      name: requiredString(source.name),
      adapter: requiredString(source.adapter),
      platform: requiredString(source.platform),
      enabled: Boolean(source.enabled),
      rights_status: requiredString(source.rights_status),
      config_hash: requiredString(source.config_hash),
      credential_ref:
        typeof source.credential_ref === 'string' ? source.credential_ref : null,
      credential_version: Number(source.credential_version ?? 0),
      rate_limit_per_minute: Number(source.rate_limit_per_minute ?? 1),
      retention_mode: source.retention_mode === 'raw' ? 'raw' : 'metadata',
      retention_days: Number(source.retention_days ?? 1),
      config: parseJsonObject(source.config_json),
    },
  });
}
