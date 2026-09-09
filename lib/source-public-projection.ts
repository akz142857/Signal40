type PublicPreviewItem = {
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
  summary?: string;
};

type PublicTestCapabilities = {
  conditionalRequests?: boolean;
  contentType?: string;
  finalUrl?: string;
};

const SOURCE_TYPES = new Set(['social', 'media', 'market', 'filing', 'company']);
const PUBLIC_MAPPING_KEYS = new Set([
  'items',
  'id',
  'title',
  'url',
  'publishedAt',
  'summary',
  'author',
]);
const PUBLIC_PAGINATION_KEYS = new Set([
  'mode',
  'maxPages',
  'pageParameter',
  'startPage',
  'pageSizeParameter',
  'pageSize',
  'cursorParameter',
  'cursorPath',
  'sinceParameter',
  'hasMorePath',
]);
const SENSITIVE_QUERY_NAME = /(?:^|[-_.])(access|auth|credential|key|pass(?:word)?|secret|sig(?:nature)?|token)(?:$|[-_.])/i;

const PUBLIC_ERROR_MESSAGES: Record<string, string> = {
  RIGHTS_BLOCKED: '来源使用权当前无效，采集已停止。',
  RATE_LIMITED: '来源请求受限，系统会按退避策略重试。',
  BUDGET_EXCEEDED: '来源已达到预算上限。',
  CONNECTOR_DISABLED: '来源连接器当前已停用。',
  CONNECTOR_ROLLOUT_CHANGED: '来源连接器发布范围已变更，本次结果未被接纳。',
  CONNECTOR_UNAVAILABLE: '来源连接器当前不可用。',
  LEASE_LOST: '采集执行权已失效，结果未被接纳。',
  POLICY_DRIFT: '来源策略在运行期间发生变化，结果未被接纳。',
  SSRF_BLOCKED: '来源地址未通过网络安全检查。',
  NETWORK: '来源网络暂时不可用。',
  SCHEMA_CHANGED: '来源数据结构发生变化，需要重新测试。',
  PAYLOAD_LIMIT: '来源响应超过安全限制。',
  REDIRECT_LIMIT: '来源重定向超过安全限制。',
  UPSTREAM_SECRET_REFLECTION: '来源响应未通过敏感信息检查。',
  STORAGE_ERROR: '来源数据暂时无法安全保存。',
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function storedRecord(value: unknown): Record<string, unknown> | null {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== 'string') return null;
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maxLength: number) {
  return typeof value === 'string' ? value.slice(0, maxLength) : undefined;
}

function safeString(value: unknown, maxLength = 500) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).slice(0, maxLength)
    : '';
}

export function projectPublicHttpUrl(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = '';
    url.password = '';
    url.hash = '';
    const queryKeys: string[] = [];
    url.searchParams.forEach((_value, key) => queryKeys.push(key));
    for (const key of queryKeys) {
      if (SENSITIVE_QUERY_NAME.test(key) || key.toLowerCase().startsWith('x-amz-')) {
        url.searchParams.delete(key);
      }
    }
    return url.toString().slice(0, 2_000);
  } catch {
    return undefined;
  }
}

function integer(value: unknown, minimum = 0) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(number) && number >= minimum ? number : minimum;
}

function nullableString(value: unknown, maxLength = 500) {
  return value === null || value === undefined
    ? null
    : boundedString(value, maxLength)?.trim() || null;
}

function publicMapping(value: unknown) {
  const input = record(value);
  const output: Record<string, string> = {};
  if (!input) return output;
  for (const [key, candidate] of Object.entries(input)) {
    if (
      PUBLIC_MAPPING_KEYS.has(key) &&
      typeof candidate === 'string' &&
      /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(candidate)
    ) {
      output[key] = candidate.slice(0, 256);
    }
  }
  return output;
}

function publicPagination(value: unknown) {
  const input = record(value);
  if (!input) return undefined;
  const output: Record<string, string | number> = {};
  for (const [key, candidate] of Object.entries(input)) {
    if (!PUBLIC_PAGINATION_KEYS.has(key)) continue;
    if (key === 'mode' && ['none', 'page', 'cursor', 'since'].includes(String(candidate))) {
      output.mode = String(candidate);
    } else if (typeof candidate === 'number' && Number.isInteger(candidate)) {
      output[key] = candidate;
    } else if (
      typeof candidate === 'string' &&
      /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(candidate)
    ) {
      output[key] = candidate.slice(0, 256);
    }
  }
  return Object.keys(output).length ? output : undefined;
}

export function projectPublicSourceConfig(value: unknown) {
  const input = storedRecord(value);
  if (!input) return {};
  const output: Record<string, unknown> = {};
  if (typeof input.sourceType === 'string' && SOURCE_TYPES.has(input.sourceType)) {
    output.sourceType = input.sourceType;
  }
  const url = projectPublicHttpUrl(input.url);
  if (url) output.url = url;
  output.mapping = publicMapping(input.mapping);
  const pagination = publicPagination(input.pagination);
  if (pagination) output.pagination = pagination;
  return output;
}

export function publicSourceErrorMessage(errorCode: unknown) {
  if (typeof errorCode !== 'string' || !errorCode) return null;
  return PUBLIC_ERROR_MESSAGES[errorCode] ?? '来源最近一次运行失败，请查看受限运维日志。';
}

export function projectPublicSourceRecord(row: Record<string, unknown>) {
  return {
    id: safeString(row.id, 200),
    name: boundedString(row.name, 160)?.trim() ?? '',
    adapter: safeString(row.adapter, 50),
    platform: safeString(row.platform, 100),
    lifecycleStatus: safeString(row.lifecycle_status, 100),
    healthStatus: safeString(row.health_status, 100),
    rightsStatus: safeString(row.rights_status, 100),
    enabled: Boolean(row.enabled),
    version: integer(row.version, 1),
    ownerTeamId: nullableString(row.owner_team_id, 200),
    businessOwnerId: nullableString(row.business_owner_id, 200),
    publisherEntityId: nullableString(row.publisher_entity_id, 200),
    scheduleCron: nullableString(row.schedule_cron, 200),
    checkpointVersion: integer(row.checkpoint_version),
    nextRunAt: nullableString(row.next_run_at, 100),
    lastSuccessAt: nullableString(row.last_success_at, 100),
    lastTestedAt: nullableString(row.last_tested_at, 100),
    publicErrorCode: nullableString(row.last_error_code, 100),
    publicErrorMessage: publicSourceErrorMessage(row.last_error_code),
    consecutiveFailures: integer(row.consecutive_failures),
    hasActiveRun: Boolean(row.active_run_id),
    deletionStatus: nullableString(row.deletion_status, 100),
    deletionRequestId: nullableString(row.deletion_request_id, 200),
    pendingRightsRequestId: nullableString(row.pending_rights_request_id, 200),
    pendingRightsRequestedBy: nullableString(row.pending_rights_requested_by, 200),
    rateLimitPerMinute: integer(row.rate_limit_per_minute, 1),
    costMicrosPerRequest: integer(row.cost_micros_per_request),
    estimatedRequestsPerRun: integer(row.estimated_requests_per_run, 1),
    monthlyBudgetMicros: integer(row.monthly_budget_micros),
    budgetSoftLimitPercent: integer(row.budget_soft_limit_percent),
    schedulePriority: integer(row.schedule_priority ?? 50),
    autoThrottleEnabled:
      row.auto_throttle_enabled === undefined
        ? true
        : Boolean(row.auto_throttle_enabled),
    effectiveScheduleMultiplier: integer(
      row.effective_schedule_multiplier,
      1,
    ),
    scheduleThrottleReason: nullableString(
      row.schedule_throttle_reason,
      100,
    ),
    scheduleThrottleRecoveryAt: nullableString(
      row.schedule_throttle_recovery_at,
      100,
    ),
    retention: {
      mode: row.retention_mode === 'raw' ? 'raw' : 'metadata',
      days: integer(row.retention_days, 1),
    },
    publicConfig: projectPublicSourceConfig(row.config_json),
    createdAt: nullableString(row.created_at, 100),
    updatedAt: nullableString(row.updated_at, 100),
  };
}

export function projectPublicSourceRun(row: Record<string, unknown>) {
  return {
    id: safeString(row.id, 200),
    status: safeString(row.status, 100),
    quarantineStatus: safeString(row.quarantine_status, 100) || 'none',
    trigger: safeString(row.trigger, 100),
    acceptedCount: integer(row.accepted_count),
    rejectedCount: integer(row.rejected_count),
    duplicateCount: integer(row.duplicate_count),
    createdAt: nullableString(row.created_at, 100),
    finishedAt: nullableString(row.finished_at, 100),
    errorCode: nullableString(row.error_code, 100),
    errorMessage: publicSourceErrorMessage(row.error_code),
  };
}

export function projectPublicSourceTestRecord(row: Record<string, unknown>) {
  return {
    id: safeString(row.id, 200),
    status: safeString(row.status, 100),
    preview: projectPublicSourceTestPreview(row.preview),
    capabilities: projectPublicSourceTestCapabilities(row.capabilities),
    errorCode: nullableString(row.error_code, 100),
    errorMessage: publicSourceErrorMessage(row.error_code),
    expiresAt: nullableString(row.expires_at, 100),
    createdAt: nullableString(row.created_at, 100),
    finishedAt: nullableString(row.finished_at, 100),
  };
}

export function projectPublicCheckpointCutover(row: Record<string, unknown>) {
  return {
    id: safeString(row.id, 200),
    sourceConfigId: safeString(row.source_config_id, 200),
    scope: safeString(row.scope, 50),
    status: safeString(row.status, 50),
    sourceVersion: integer(row.source_version, 1),
    checkpointVersionBefore: integer(row.checkpoint_version_before),
    requestedBy: nullableString(row.requested_by, 200),
    approvedBy: nullableString(row.approved_by, 200),
    reason: nullableString(row.reason, 500),
    decisionNote: nullableString(row.decision_note, 500),
    createdAt: nullableString(row.created_at, 100),
    decidedAt: nullableString(row.decided_at, 100),
    appliedAt: nullableString(row.applied_at, 100),
  };
}

export function projectPublicDeletionRequest(row: Record<string, unknown>) {
  return {
    id: safeString(row.id, 200),
    sourceVersion: integer(row.source_version, 1),
    status: safeString(row.status, 100),
    stage: row.initialized_at ? 'executing' : 'requested',
    receiptHash: nullableString(row.receipt_hash, 128),
    errorMessage: row.last_error_redacted
      ? '删除流程存在未完成步骤，请查看受限运维记录。'
      : null,
    createdAt: nullableString(row.created_at, 100),
    updatedAt: nullableString(row.updated_at, 100),
    completedAt: nullableString(row.completed_at, 100),
  };
}

/**
 * Worker preview payloads cross a trust boundary before an administrator sees
 * them. Persist only the five fields used by the UI; arbitrary upstream or
 * connector fields (including object keys and credential material) are
 * discarded even when an old or compromised Worker submits them.
 */
export function projectPublicSourceTestPreview(value: unknown): PublicPreviewItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((candidate) => {
    const item = record(candidate);
    const title = boundedString(item?.title, 500)?.trim();
    const url = projectPublicHttpUrl(item?.url);
    const publishedAt = boundedString(item?.publishedAt, 100);
    if (!title || !url || !publishedAt || Number.isNaN(new Date(publishedAt).valueOf())) return [];
    const projected: PublicPreviewItem = {
      title,
      url,
      publishedAt: new Date(publishedAt).toISOString(),
    };
    const author = boundedString(item?.author, 200)?.trim();
    const summary = boundedString(item?.summary, 2_000)?.trim();
    if (author) projected.author = author;
    if (summary) projected.summary = summary;
    return [projected];
  });
}

/** Keep the browser-visible connector capability summary deliberately small. */
export function projectPublicSourceTestCapabilities(value: unknown): PublicTestCapabilities {
  const input = record(value);
  if (!input) return {};
  const projected: PublicTestCapabilities = {};
  if (typeof input.conditionalRequests === 'boolean') {
    projected.conditionalRequests = input.conditionalRequests;
  }
  const contentType = boundedString(input.contentType, 500)?.trim();
  const finalUrl = projectPublicHttpUrl(input.finalUrl);
  if (contentType) projected.contentType = contentType;
  if (finalUrl) projected.finalUrl = finalUrl;
  return projected;
}
