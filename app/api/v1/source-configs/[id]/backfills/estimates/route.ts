import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { sourceActionAllowed } from '@/lib/source-authorization';
import {
  estimateSourceBackfill,
  parseSourceBackfillWindow,
} from '@/lib/source-backfill-estimate';
import { sourceConnectorByPlatform } from '@/lib/source-connectors/registry';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.backfill.estimate')) {
    return sourceApiError('当前角色无权估算历史补采。', 403);
  }
  let body: { from?: unknown; to?: unknown; maxItems?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sourceApiError('请求体必须是 JSON object。', 400);
  }
  const unknownFields = Object.keys(body).filter(
    (field) => !['from', 'to', 'maxItems'].includes(field),
  );
  if (unknownFields.length) {
    return sourceApiError(`不支持字段：${unknownFields.join('、')}。`, 422);
  }
  const parsed = parseSourceBackfillWindow(body);
  if ('error' in parsed) return sourceApiError(parsed.error, 422);

  const { id } = await context.params;
  const source = await db.prepare(`
    SELECT id, platform, version, rate_limit_per_minute,
      cost_micros_per_request, estimated_requests_per_run
    FROM source_configs WHERE id = ? LIMIT 1
  `).bind(id).first<{
    id: string;
    platform: string;
    version: number;
    rate_limit_per_minute: number;
    cost_micros_per_request: number;
    estimated_requests_per_run: number;
  }>();
  if (!source) return sourceApiError('来源不存在。', 404);
  const connector = sourceConnectorByPlatform(source.platform);
  if (!connector?.supports.backfill) {
    return sourceApiError('该连接器不支持补采。', 409, {
      errorCode: 'CONNECTOR_UNAVAILABLE',
    });
  }
  return Response.json({
    estimate: estimateSourceBackfill({
      sourceId: source.id,
      sourceVersion: source.version,
      window: parsed.window,
      configuredRequestsPerRun: source.estimated_requests_per_run,
      costMicrosPerRequest: source.cost_micros_per_request,
      rateLimitPerMinute: source.rate_limit_per_minute,
    }),
  });
}
