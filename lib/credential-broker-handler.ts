import { activeLeaseMatches } from './job-lease.ts';
import { authorizeCredentialBrokerRequest, parseSourceCredentialPolicies } from './source-credentials.ts';
import { asSourceApiErrorCode, sourceApiError } from './source-api-error.ts';
import { fetchSourceThroughBroker, SourceEgressError } from './source-egress.ts';
import type { SqlDatabase } from './sql.ts';
import { authorizeWorker } from './worker-auth.ts';

type FetchBody = {
  sourceConfigId?: string;
  credentialRef?: string;
  credentialVersion?: number;
  url?: string;
  workerId?: string;
  jobId?: string;
  leaseEpoch?: number;
  conditional?: { etag?: unknown; lastModified?: unknown };
};

export type CredentialBrokerDependencies = {
  db: SqlDatabase;
  sourceWorkerToken?: string;
  policiesJson?: string;
  resolveSecret: (environmentName: string) => string | undefined;
};

function record(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function auditRedemption(
  db: SqlDatabase,
  input: {
    body: FetchBody;
    targetOrigin: string;
    outcome: 'succeeded' | 'denied' | 'failed';
    errorCode?: string;
  },
) {
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO audit_events
      (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
    VALUES (?, ?, 'admin', 'source_credential.redeemed', 'source_credential', ?, ?, ?, ?)
  `).bind(
    `audit_${crypto.randomUUID()}`,
    `workload:${String(input.body.workerId ?? 'unknown').slice(0, 128)}`,
    String(input.body.credentialRef ?? 'unknown').slice(0, 128),
    JSON.stringify({
      sourceConfigId: input.body.sourceConfigId,
      credentialVersion: input.body.credentialVersion,
      connectorAction: 'fetch',
      targetOrigin: input.targetOrigin,
      jobId: String(input.body.jobId ?? '').slice(0, 128),
      outcome: input.outcome,
      errorCode: input.errorCode ?? null,
    }),
    crypto.randomUUID(),
    now,
  ).run();
}

/**
 * Credential Broker 的协议内核。它只依赖数据库、source token、策略和 Secret 解析器，
 * 因而可以由本地控制面兼容路由或生产独立进程承载，而不把其他 workload Secret 带进来。
 */
export async function handleCredentialBrokerFetch(request: Request, dependencies: CredentialBrokerDependencies) {
  if (!(await authorizeWorker(request, dependencies.sourceWorkerToken))) {
    return sourceApiError('采集 Worker 认证失败。', 401);
  }
  let body: FetchBody;
  try {
    body = (await request.json()) as FetchBody;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (
    !body.sourceConfigId || !body.credentialRef || !Number.isInteger(body.credentialVersion) ||
    !body.url || !body.workerId || !body.jobId || !Number.isInteger(body.leaseEpoch) ||
    Number(body.leaseEpoch) < 1
  ) {
    return sourceApiError('broker 请求字段不完整。', 422);
  }
  let targetOrigin = 'invalid';
  try {
    targetOrigin = new URL(body.url).origin;
  } catch {
    return sourceApiError('目标 URL 无效。', 422);
  }
  const lease = await dependencies.db.prepare(`
    SELECT status, lease_owner, lease_epoch, lease_expires_at, payload_json
    FROM jobs WHERE id = ? AND kind = 'ingestion' LIMIT 1
  `).bind(body.jobId).first<{
    status: string;
    lease_owner: string | null;
    lease_epoch: number;
    lease_expires_at: string | null;
    payload_json: unknown;
  }>();
  const payload = record(lease?.payload_json);
  if (
    !lease || !activeLeaseMatches(lease, { workerId: body.workerId, leaseEpoch: Number(body.leaseEpoch) }) ||
    payload?.sourceConfigId !== body.sourceConfigId || payload?.credentialRef !== body.credentialRef ||
    Number(payload?.credentialVersion) !== Number(body.credentialVersion)
  ) {
    await auditRedemption(dependencies.db, { body, targetOrigin, outcome: 'denied', errorCode: 'LEASE_LOST' });
    return sourceApiError('作业租约、来源或凭据快照已经失效。', 409, {
      errorCode: 'LEASE_LOST',
      retryable: false,
    });
  }
  const grant = await authorizeCredentialBrokerRequest(dependencies.db, {
    sourceConfigId: body.sourceConfigId,
    credentialRef: body.credentialRef,
    credentialVersion: Number(body.credentialVersion),
    targetUrl: body.url,
  });
  if (!grant) {
    await auditRedemption(dependencies.db, { body, targetOrigin, outcome: 'denied', errorCode: 'AUTH_REQUIRED' });
    return sourceApiError('凭据已撤销、版本不匹配或目标不在 allowlist。', 409, { errorCode: 'AUTH_REQUIRED' });
  }
  let policies;
  try {
    policies = parseSourceCredentialPolicies(dependencies.policiesJson);
  } catch (error) {
    await auditRedemption(dependencies.db, { body, targetOrigin, outcome: 'failed', errorCode: 'BROKER_CONFIG' });
    return sourceApiError(error instanceof Error ? error.message : 'broker 策略配置无效。', 503, {
      errorCode: 'BROKER_CONFIG',
    });
  }
  const policy = policies[grant.secretAlias];
  if (
    !policy || policy.headerName !== grant.headerName ||
    JSON.stringify(policy.targetOrigins) !== JSON.stringify(grant.targetOrigins)
  ) {
    await auditRedemption(dependencies.db, { body, targetOrigin, outcome: 'denied', errorCode: 'POLICY_DRIFT' });
    return sourceApiError('凭据策略与绑定快照不一致，必须重新绑定。', 409, { errorCode: 'POLICY_DRIFT' });
  }
  const secret = dependencies.resolveSecret(policy.secretEnv);
  if (!secret) {
    await auditRedemption(dependencies.db, { body, targetOrigin, outcome: 'failed', errorCode: 'AUTH_REQUIRED' });
    return sourceApiError('credential provider 当前不可用。', 503, {
      errorCode: 'AUTH_REQUIRED',
      retryable: true,
    });
  }
  try {
    const result = await fetchSourceThroughBroker({
      url: body.url,
      secretHeader: { name: policy.headerName, value: `${policy.prefix}${secret}` },
      sensitiveValues: [secret, `${policy.prefix}${secret}`],
      conditional: {
        etag: typeof body.conditional?.etag === 'string' ? body.conditional.etag.slice(0, 500) : undefined,
        lastModified: typeof body.conditional?.lastModified === 'string'
          ? body.conditional.lastModified.slice(0, 500)
          : undefined,
      },
    });
    await auditRedemption(dependencies.db, { body, targetOrigin, outcome: 'succeeded' });
    return Response.json(result);
  } catch (error) {
    const safe = error instanceof SourceEgressError
      ? {
          message: error.message,
          code: error.code,
          retryable: error.retryable,
          retryAfterSeconds: error.retryAfterSeconds,
        }
      : { message: 'broker 请求失败。', code: 'NETWORK', retryable: true, retryAfterSeconds: undefined };
    await auditRedemption(dependencies.db, { body, targetOrigin, outcome: 'failed', errorCode: safe.code });
    return sourceApiError(safe.message, safe.retryable ? 503 : 422, {
      errorCode: asSourceApiErrorCode(safe.code, 'NETWORK'),
      retryable: safe.retryable,
      retryAfterSeconds: safe.retryAfterSeconds,
    });
  }
}
