import assert from 'node:assert/strict';
import test from 'node:test';

import {
  projectPublicCheckpointCutover,
  projectPublicDeletionRequest,
  projectPublicHttpUrl,
  projectPublicSourceRecord,
  projectPublicSourceRun,
  projectPublicSourceTestRecord,
  publicSourceErrorMessage,
} from '../lib/source-public-projection.ts';

const forbiddenMaterial = [
  'credential_opaque_secret',
  'cursor-secret',
  'checkpoint-secret',
  'object/secret-key',
  'upstream-secret-body',
  'https://internal.example/secret',
];

void test('actor source projection is an exact allowlist and strips execution material', () => {
  const projected = projectPublicSourceRecord({
    id: 'source-1',
    name: 'Market source',
    adapter: 'http',
    platform: 'http_json',
    lifecycle_status: 'enabled',
    health_status: 'healthy',
    rights_status: 'approved',
    enabled: 1,
    version: 3,
    owner_team_id: 'default',
    business_owner_id: 'owner-1',
    schedule_cron: '*/15 * * * *',
    checkpoint: 'checkpoint-secret',
    checkpoint_json: { cursor: 'cursor-secret' },
    checkpoint_version: 8,
    active_run_id: 'run-internal',
    last_error: 'upstream-secret-body',
    last_error_code: 'NETWORK',
    last_error_detail_redacted: 'https://internal.example/secret',
    rate_limit_per_minute: 30,
    cost_micros_per_request: 10,
    estimated_requests_per_run: 2,
    monthly_budget_micros: 1000,
    budget_soft_limit_percent: 80,
    schedule_priority: 60,
    auto_throttle_enabled: 1,
    effective_schedule_multiplier: 2,
    schedule_throttle_reason: 'budget_soft_limit',
    schedule_throttle_recovery_at: '2026-10-01T00:00:00.000Z',
    retention_mode: 'metadata',
    retention_days: 30,
    config_json: {
      sourceType: 'market',
      url: 'https://api.example.com/feed?format=json&api_key=credential_opaque_secret#cursor-secret',
      mapping: { items: 'data.items', title: 'headline', secret: 'credential_opaque_secret' },
      pagination: { mode: 'cursor', cursorPath: 'next.cursor', secret: 'cursor-secret' },
      credentialRef: 'credential_opaque_secret',
    },
    locator_json: { objectKey: 'object/secret-key' },
    capabilities_json: { rawBody: 'upstream-secret-body' },
  });

  assert.deepEqual(Object.keys(projected).sort(), [
    'autoThrottleEnabled', 'budgetSoftLimitPercent', 'businessOwnerId',
    'checkpointVersion', 'consecutiveFailures', 'costMicrosPerRequest',
    'createdAt', 'deletionRequestId',
    'deletionStatus', 'pendingRightsRequestId', 'pendingRightsRequestedBy',
    'effectiveScheduleMultiplier', 'enabled', 'estimatedRequestsPerRun', 'hasActiveRun',
    'healthStatus', 'id', 'lastSuccessAt', 'lastTestedAt',
    'lifecycleStatus', 'monthlyBudgetMicros', 'name', 'nextRunAt', 'ownerTeamId',
    'platform', 'publicConfig', 'publicErrorCode', 'publicErrorMessage',
    'rateLimitPerMinute', 'retention', 'rightsStatus', 'scheduleCron',
    'schedulePriority', 'scheduleThrottleReason', 'scheduleThrottleRecoveryAt', 'updatedAt',
    'version', 'adapter', 'publisherEntityId',
  ].sort());
  assert.equal(projected.hasActiveRun, true);
  assert.equal(projected.publicErrorMessage, '来源网络暂时不可用。');
  assert.equal(
    (projected.publicConfig as { url?: string }).url,
    'https://api.example.com/feed?format=json',
  );
  const serialized = JSON.stringify(projected);
  for (const secret of forbiddenMaterial) assert.equal(serialized.includes(secret), false, secret);
});

void test('test, run, cutover, and deletion projections omit internal identifiers and payloads', () => {
  const testRecord = projectPublicSourceTestRecord({
    id: 'test-1',
    source_config_id: 'source-internal',
    job_id: 'job-internal',
    config_hash: 'config-internal',
    status: 'succeeded',
    preview: [{
      title: 'Result',
      url: 'https://example.com/item?token=credential_opaque_secret#fragment',
      publishedAt: '2026-09-09T00:00:00Z',
      raw: 'upstream-secret-body',
    }],
    capabilities: {
      conditionalRequests: true,
      finalUrl: 'https://example.com/final?signature=credential_opaque_secret',
      etag: 'cursor-secret',
    },
    created_by: 'admin-internal',
  });
  const run = projectPublicSourceRun({
    id: 'run-1', status: 'failed', quarantine_status: 'none', trigger: 'manual',
    accepted_count: 0, rejected_count: 1, duplicate_count: 0,
    created_at: '2026-09-09T00:00:00Z', error_code: 'SCHEMA_CHANGED',
    credential_ref: 'credential_opaque_secret', checkpoint_after_json: { cursor: 'cursor-secret' },
    error_json: { body: 'upstream-secret-body' },
  });
  const cutover = projectPublicCheckpointCutover({
    id: 'cutover-1', source_config_id: 'source-1', scope: 'live', status: 'pending',
    source_version: 2, checkpoint_version_before: 8,
    checkpoint_before_json: { cursor: 'cursor-secret' },
    checkpoint_after_json: { cursor: 'checkpoint-secret' },
  });
  const deletion = projectPublicDeletionRequest({
    id: 'delete-1', source_version: 2, status: 'deleting', initialized_at: '2026-09-09T00:00:00Z',
    summary_json: { objectKey: 'object/secret-key' }, last_error_redacted: 'upstream-secret-body',
  });
  const serialized = JSON.stringify({ testRecord, run, cutover, deletion });
  for (const secret of forbiddenMaterial) assert.equal(serialized.includes(secret), false, secret);
  assert.deepEqual(Object.keys(run), [
    'id', 'status', 'quarantineStatus', 'trigger', 'acceptedCount',
    'rejectedCount', 'duplicateCount', 'createdAt', 'finishedAt',
    'errorCode', 'errorMessage',
  ]);
});

void test('public URL projection removes userinfo, fragments, and sensitive query names', () => {
  assert.equal(
    projectPublicHttpUrl('https://user:pass@example.com/feed?format=json&access_token=secret&X-Amz-Signature=signed#debug'),
    'https://example.com/feed?format=json',
  );
});

void test('connector rollout changes have a stable public error without internal detail', () => {
  assert.equal(
    publicSourceErrorMessage('CONNECTOR_ROLLOUT_CHANGED'),
    '来源连接器发布范围已变更，本次结果未被接纳。',
  );
});

void test('social source projection exposes only bounded discovery settings', () => {
  const projected = projectPublicSourceRecord({
    id: 'source-social', name: '聚大模型前言', adapter: 'social', platform: 'wechat',
    lifecycle_status: 'draft', health_status: 'unknown', rights_status: 'pending',
    enabled: 0, version: 1, config_json: {
      sourceType: 'social', discoveryMode: 'opencli', accountName: '聚大模型前言',
      searchLimit: 20, browserCookie: 'must-not-leak',
    },
  });
  assert.deepEqual(projected.publicConfig, {
    sourceType: 'social', discoveryMode: 'opencli', accountName: '聚大模型前言',
    searchLimit: 20, mapping: {},
  });
  assert.equal(JSON.stringify(projected).includes('must-not-leak'), false);
  assert.equal(publicSourceErrorMessage('OPENCLI_UNAVAILABLE')?.includes('OpenCLI'), true);
});
