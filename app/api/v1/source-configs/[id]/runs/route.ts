import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { enqueueIngestionRun } from '@/lib/control-plane';
import { sourceRunRateLimit } from '@/lib/schedule';
import { SourceBudgetExceededError } from '@/lib/source-budget';
import {
  decodeSourceRunCursor,
  listSourceRunPage,
  sourceRunPageLimit,
} from '@/lib/source-run-pagination';
import { sourceActionAllowed } from '@/lib/source-authorization';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.read'))
    return sourceApiError('用户未加入 Signal 40 团队。', 403);
  const { id } = await context.params;
  const url = new URL(request.url);
  const limitResult = sourceRunPageLimit(url.searchParams.get('limit'));
  if ('error' in limitResult) {
    return sourceApiError(limitResult.error ?? 'limit 无效。', 422);
  }
  const cursorResult = decodeSourceRunCursor(url.searchParams.get('cursor'));
  if ('error' in cursorResult) {
    return sourceApiError(cursorResult.error ?? 'cursor 无效。', 422);
  }
  const cursor = cursorResult.cursor;
  return Response.json(
    await listSourceRunPage(db, {
      sourceConfigId: id,
      limit: limitResult.limit,
      cursor,
    }),
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.run.request'))
    return sourceApiError('当前角色无权触发采集。', 403);
  const key = request.headers.get('idempotency-key');
  if (!key)
    return sourceApiError('Idempotency-Key 必填。', 400);
  const { id } = await context.params;
  const source = await db
    .prepare(`
    SELECT id, enabled, lifecycle_status, rights_status, checkpoint, checkpoint_json,
      version, rate_limit_per_minute FROM source_configs WHERE id = ?
  `)
    .bind(id)
    .first<{
      id: string;
      enabled: number;
      lifecycle_status: string;
      rights_status: string;
      checkpoint: string | null;
      checkpoint_json: unknown;
      version: number;
      rate_limit_per_minute: number;
    }>();
  if (!source) return sourceApiError('来源不存在。', 404);
  if (
    !source.enabled ||
    !['enabled', 'degraded'].includes(source.lifecycle_status) ||
    source.rights_status !== 'approved'
  ) {
    return sourceApiError('来源尚未通过测试并启用，或权利状态未批准。', 409);
  }
  const replay = await db
    .prepare(
      "SELECT id FROM jobs WHERE kind = 'ingestion' AND idempotency_key = ? LIMIT 1",
    )
    .bind(key)
    .first<{ id: string }>();
  if (!replay) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await db
      .prepare(
        'SELECT created_at FROM ingestion_runs WHERE source_config_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 600',
      )
      .bind(id, since)
      .all<{ created_at: string }>();
    const quota = sourceRunRateLimit(
      recent.results.map((run) => run.created_at),
      source.rate_limit_per_minute,
    );
    if (!quota.allowed) {
      return sourceApiError(`来源触发频率超过每分钟 ${source.rate_limit_per_minute} 次限制。`, 429, {
        retryable: true,
        retryAfterSeconds: quota.retryAfterSeconds,
        headers: { 'retry-after': String(quota.retryAfterSeconds) },
      });
    }
  }
  try {
    const job = await enqueueIngestionRun(db, {
      sourceConfigId: id,
      checkpoint: source.checkpoint,
      checkpointJson: source.checkpoint_json,
      sourceVersion: source.version,
      runTrigger: 'manual',
      idempotencyKey: key,
      actor: actor!,
    });
    return Response.json(
      { ingestionRunId: job.ingestionRunId, created: job.created },
      { status: job.created ? 202 : 200 },
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : '采集运行创建失败。';
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
