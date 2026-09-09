export const SOURCE_API_ERROR_CODES = [
  'UNAUTHORIZED', 'FORBIDDEN', 'BAD_JSON', 'VALIDATION_ERROR', 'NOT_FOUND',
  'VERSION_CONFLICT', 'STATE_CONFLICT', 'IDEMPOTENCY_REQUIRED',
  'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'BUDGET_EXCEEDED',
  'CONNECTOR_UNAVAILABLE', 'CONNECTOR_DISABLED', 'CONNECTOR_ROLLOUT_CHANGED', 'AUTH_REQUIRED',
  'RIGHTS_BLOCKED', 'LEGAL_HOLD_ACTIVE', 'LEASE_LOST', 'POLICY_DRIFT', 'BROKER_CONFIG',
  'SSRF_BLOCKED', 'NETWORK', 'PERMANENT_UNSUPPORTED', 'SCHEMA_CHANGED',
  'PAYLOAD_LIMIT', 'REDIRECT_LIMIT', 'UPSTREAM_SECRET_REFLECTION',
  'STORAGE_ERROR',
] as const;

export type SourceApiErrorCode = (typeof SOURCE_API_ERROR_CODES)[number];

export function asSourceApiErrorCode(
  value: unknown,
  fallback: SourceApiErrorCode = 'STATE_CONFLICT',
): SourceApiErrorCode {
  return typeof value === 'string' && (SOURCE_API_ERROR_CODES as readonly string[]).includes(value)
    ? value as SourceApiErrorCode
    : fallback;
}

export function sourceErrorCodeFor(status: number, error: string): SourceApiErrorCode {
  if (status === 400) {
    return error.includes('Idempotency-Key') ? 'IDEMPOTENCY_REQUIRED' : 'BAD_JSON';
  }
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) {
    if (error.includes('Idempotency-Key')) return 'IDEMPOTENCY_CONFLICT';
    if (/版本冲突|当前版本|被其他管理员修改|并发冲突/.test(error)) {
      return 'VERSION_CONFLICT';
    }
    if (/权利|授权|使用权/.test(error)) return 'RIGHTS_BLOCKED';
    if (/legal hold/i.test(error)) return 'LEGAL_HOLD_ACTIVE';
    if (/凭据/.test(error)) return 'AUTH_REQUIRED';
    if (/连接器.*停用/.test(error)) return 'CONNECTOR_DISABLED';
    if (/连接器.*不可用|连接器.*不支持/.test(error)) return 'CONNECTOR_UNAVAILABLE';
    if (/租约|leaseEpoch/.test(error)) return 'LEASE_LOST';
    return 'STATE_CONFLICT';
  }
  if (status === 413) return 'PAYLOAD_LIMIT';
  if (status === 422) return 'VALIDATION_ERROR';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) {
    return /策略配置|配置无效/.test(error) ? 'BROKER_CONFIG' : 'CONNECTOR_UNAVAILABLE';
  }
  return 'STATE_CONFLICT';
}

export function sourceApiError(
  error: string,
  status: number,
  options: {
    errorCode?: SourceApiErrorCode;
    issues?: unknown[];
    retryable?: boolean;
    retryAfterSeconds?: number;
    headers?: HeadersInit;
    sourceId?: string;
  } = {},
) {
  const correlationId = crypto.randomUUID();
  const issues: Array<string | { index: number; issue: string }> = [];
  for (const issue of options.issues?.slice(0, 100) ?? []) {
    if (typeof issue === 'string') {
      issues.push(issue.slice(0, 1000));
      continue;
    }
    if (!issue || typeof issue !== 'object') continue;
    const record = issue as Record<string, unknown>;
    if (!Number.isInteger(record.index) || typeof record.issue !== 'string') continue;
    issues.push({ index: Number(record.index), issue: record.issue.slice(0, 1000) });
  }
  return Response.json(
    {
      error: error.replace(/https?:\/\/[^\s]+/gi, '[redacted-url]').slice(0, 1000),
      errorCode: options.errorCode ?? sourceErrorCodeFor(status, error),
      correlationId,
      ...(options.sourceId ? { sourceId: options.sourceId.slice(0, 200) } : {}),
      ...(issues.length ? { issues } : {}),
      ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
      ...(options.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: options.retryAfterSeconds }
        : {}),
    },
    { status, ...(options.headers ? { headers: options.headers } : {}) },
  );
}

export function sourceResultError(result: { error?: string; status?: number }) {
  return sourceApiError(result.error ?? '来源操作失败。', result.status ?? 500);
}
