import { config, db } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { authorizeSourceLegalWithdrawal } from '@/lib/source-legal-deletion';
import { authorizeWorker } from '@/lib/worker-auth';

type AuthorizationBody = { workerId?: string; leaseEpoch?: number };

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  if (!(await authorizeWorker(request, config.renderWorkerToken))) {
    return sourceApiError('Render Worker 未授权。', 401);
  }
  let body: AuthorizationBody;
  try {
    body = (await request.json()) as AuthorizationBody;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (!body.workerId || !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1) {
    return sourceApiError('workerId 和有效 leaseEpoch 必填。', 422);
  }
  const { jobId } = await context.params;
  const result = await authorizeSourceLegalWithdrawal(db, {
    jobId,
    workerId: body.workerId.slice(0, 160),
    leaseEpoch: Number(body.leaseEpoch),
  });
  if ('error' in result) {
    return sourceApiError(result.error ?? '外部撤回执行授权失败。', result.status, {
      errorCode: result.errorCode,
      retryable: result.errorCode === 'LEGAL_HOLD_ACTIVE',
      ...(result.errorCode === 'LEGAL_HOLD_ACTIVE' ? { retryAfterSeconds: 60 } : {}),
    });
  }
  return Response.json({
    authorized: result.authorized,
    sourceId: result.sourceId,
    legalHoldEpoch: result.legalHoldEpoch,
  });
}
