import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceApiError, sourceErrorCodeFor } from '../lib/source-api-error.ts';

void test('source API errors always carry a stable machine-readable code', async () => {
  assert.equal(sourceErrorCodeFor(400, '请求体必须是 JSON。'), 'BAD_JSON');
  assert.equal(sourceErrorCodeFor(400, 'Idempotency-Key 必填。'), 'IDEMPOTENCY_REQUIRED');
  assert.equal(sourceErrorCodeFor(403, '无权操作。'), 'FORBIDDEN');
  assert.equal(sourceErrorCodeFor(404, '来源不存在。'), 'NOT_FOUND');
  assert.equal(sourceErrorCodeFor(409, '版本冲突：当前版本为 3。'), 'VERSION_CONFLICT');
  assert.equal(sourceErrorCodeFor(409, 'Idempotency-Key 已用于其他操作。'), 'IDEMPOTENCY_CONFLICT');
  assert.equal(sourceErrorCodeFor(409, '当前状态不能操作。'), 'STATE_CONFLICT');
  assert.equal(sourceErrorCodeFor(422, '字段无效。'), 'VALIDATION_ERROR');

  const budget = sourceApiError('来源月预算已用尽。', 429, {
    errorCode: 'BUDGET_EXCEEDED',
  });
  assert.equal((await budget.json() as { errorCode: string }).errorCode, 'BUDGET_EXCEEDED');

  const response = sourceApiError('稍后重试。', 503, {
    errorCode: 'NETWORK',
    retryable: true,
    retryAfterSeconds: 30,
  });
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.match(String(body.correlationId), /^[0-9a-f-]{36}$/);
  delete body.correlationId;
  assert.deepEqual(body, {
    error: '稍后重试。',
    errorCode: 'NETWORK',
    retryable: true,
    retryAfterSeconds: 30,
  });

  const redacted = await sourceApiError(
    '上游 https://example.com/feed?api_key=secret 无法访问。',
    503,
  ).json() as { error: string };
  assert.equal(redacted.error.includes('secret'), false);
});
