import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { enqueueIngestionRun } from '@/lib/control-plane';
import { sourceConnectorByPlatform } from '@/lib/source-connectors/registry';
import { SourceBudgetExceededError } from '@/lib/source-budget';
import { sourceActionAllowed } from '@/lib/source-authorization';
import {
  estimateSourceBackfill,
  parseSourceBackfillWindow,
  sourceBackfillConfirmationValid,
} from '@/lib/source-backfill-estimate';

type BackfillBody = {
  from?: unknown;
  to?: unknown;
  maxItems?: unknown;
  confirmed?: unknown;
  confirmationHash?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.backfill.request')) {
    return sourceApiError('只有管理员可以发起历史补采。', 403);
  }
  const key = request.headers.get('idempotency-key');
  if (!key)
    return sourceApiError('Idempotency-Key 必填。', 400);
  let body: BackfillBody;
  try {
    body = (await request.json()) as BackfillBody;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sourceApiError('请求体必须是 JSON object。', 400);
  }
  const unknownFields = Object.keys(body).filter(
    (field) =>
      !['from', 'to', 'maxItems', 'confirmed', 'confirmationHash'].includes(
        field,
      ),
  );
  if (unknownFields.length) {
    return sourceApiError(`不支持字段：${unknownFields.join('、')}。`, 422);
  }
  if (body.confirmed !== undefined && typeof body.confirmed !== 'boolean') {
    return sourceApiError('confirmed 必须是布尔值。', 422);
  }
  if (
    body.confirmationHash !== undefined &&
    (typeof body.confirmationHash !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(body.confirmationHash))
  ) {
    return sourceApiError('confirmationHash 格式无效。', 422);
  }
  const parsed = parseSourceBackfillWindow(body);
  if ('error' in parsed) return sourceApiError(parsed.error, 422);
  const { id } = await context.params;
  const source = await db
    .prepare(`
    SELECT id, enabled, lifecycle_status, rights_status, platform, version,
      backfill_checkpoint_json, rate_limit_per_minute,
      cost_micros_per_request, estimated_requests_per_run
    FROM source_configs WHERE id = ? LIMIT 1
  `)
    .bind(id)
    .first<{
      id: string;
      enabled: number;
      lifecycle_status: string;
      rights_status: string;
      platform: string;
      version: number;
      backfill_checkpoint_json: unknown;
      rate_limit_per_minute: number;
      cost_micros_per_request: number;
      estimated_requests_per_run: number;
    }>();
  if (!source) return sourceApiError('来源不存在。', 404);
  if (
    !source.enabled ||
    !['enabled', 'degraded'].includes(source.lifecycle_status) ||
    source.rights_status !== 'approved'
  ) {
    return sourceApiError('来源必须先通过测试并启用，且权利授权有效。', 409);
  }
  const connector = sourceConnectorByPlatform(source.platform);
  if (!connector?.supports.backfill) {
    return sourceApiError('该连接器不支持补采。', 409, { errorCode: 'CONNECTOR_UNAVAILABLE' });
  }
  const estimate = estimateSourceBackfill({
    sourceId: source.id,
    sourceVersion: source.version,
    window: parsed.window,
    configuredRequestsPerRun: source.estimated_requests_per_run,
    costMicrosPerRequest: source.cost_micros_per_request,
    rateLimitPerMinute: source.rate_limit_per_minute,
  });
  if (!sourceBackfillConfirmationValid(estimate, body)) {
    return sourceApiError('该补采范围必须先取得当前估算并显式确认。', 409);
  }
  const checkpointJson = {
    schemaVersion: 1,
    connector: connector.id,
    connectorVersion: connector.version,
    mode: 'backfill',
    range: { from: parsed.window.from, to: parsed.window.to },
    maxItems: parsed.window.maxItems,
    cursor: null,
  };
  try {
    const job = await enqueueIngestionRun(db, {
      sourceConfigId: id,
      checkpointJson,
      sourceVersion: source.version,
      runTrigger: 'backfill',
      idempotencyKey: key,
      actor: actor!,
    });
    return Response.json(
      {
        ingestionRunId: job.ingestionRunId,
        created: job.created,
        checkpointScope: 'backfill',
      },
      { status: job.created ? 202 : 200 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '补采作业创建失败。';
    const status =
      error instanceof SourceBudgetExceededError
        ? 429
        : message.includes('活动采集运行')
          ? 409
          : 503;
    return sourceApiError(message, status, {
      errorCode: error instanceof SourceBudgetExceededError ? 'BUDGET_EXCEEDED' : undefined,
      retryable: status === 503,
    });
  }
}
