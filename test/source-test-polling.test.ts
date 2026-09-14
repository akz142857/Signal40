import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pollSourceTest,
  sourceTestFailureMessage,
  SOURCE_TEST_POLL_BUDGET_MS,
} from '../lib/source-test-polling.ts';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

void test('失败的测试带上公开错误码和文案，而不是一句通用失败', () => {
  assert.equal(
    sourceTestFailureMessage({
      status: 'failed',
      preview: [],
      errorCode: 'SSRF_BLOCKED',
      errorMessage: '来源地址未通过网络安全检查。',
    }),
    '来源地址未通过网络安全检查。（SSRF_BLOCKED）',
  );
  assert.equal(
    sourceTestFailureMessage({
      status: 'failed',
      preview: [],
      errorCode: 'NETWORK',
    }),
    '连接测试失败：NETWORK。',
  );
  assert.equal(
    sourceTestFailureMessage({ status: 'failed', preview: [] }),
    '连接测试失败。',
  );
});

void test('结果在旧的 30 秒窗口之后落库仍然能被等到', async () => {
  const clock = fakeClock();
  let calls = 0;
  const outcome = await pollSourceTest({
    sourceId: 'source_1',
    testId: 'test_1',
    headers: {},
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async () => {
      calls += 1;
      // 真实环境里失败在第 30.25 秒才写回，按次数计的旧实现正好错过。
      return calls <= 30
        ? jsonResponse({ test: { status: 'queued', preview: [] } })
        : jsonResponse({
            test: {
              status: 'failed',
              preview: [],
              errorCode: 'SSRF_BLOCKED',
              errorMessage: '来源地址未通过网络安全检查。',
            },
          });
    },
  });
  assert.deepEqual(outcome, {
    status: 'failed',
    message: '来源地址未通过网络安全检查。（SSRF_BLOCKED）',
  });
  assert.equal(calls, 31);
});

void test('成功时返回预览条目', async () => {
  const clock = fakeClock();
  const outcome = await pollSourceTest({
    sourceId: 'source_1',
    testId: 'test_1',
    headers: { 'x-signal-role': 'admin' },
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async (_input, init) => {
      assert.deepEqual((init as RequestInit).headers, {
        'x-signal-role': 'admin',
      });
      return jsonResponse({
        test: {
          status: 'succeeded',
          preview: [
            {
              title: '条目',
              url: 'https://example.com/a',
              publishedAt: '2026-09-14T00:00:00.000Z',
            },
          ],
        },
      });
    },
  });
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(
    outcome.status === 'succeeded' ? outcome.preview.length : -1,
    1,
  );
});

void test('预算耗尽返回 pending，而不是伪装成失败或永远等待', async () => {
  const clock = fakeClock();
  const outcome = await pollSourceTest({
    sourceId: 'source_1',
    testId: 'test_1',
    headers: {},
    budgetMs: 5_000,
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async () =>
      jsonResponse({ test: { status: 'queued', preview: [] } }),
  });
  assert.deepEqual(outcome, { status: 'pending' });
});

void test('测试已过期直接结束等待', async () => {
  const clock = fakeClock(10_000);
  const outcome = await pollSourceTest({
    sourceId: 'source_1',
    testId: 'test_1',
    headers: {},
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: async () =>
      jsonResponse({
        test: {
          status: 'queued',
          preview: [],
          expiresAt: new Date(5_000).toISOString(),
        },
      }),
  });
  assert.deepEqual(outcome, {
    status: 'failed',
    message: '本次测试已过期，请重新测试。',
  });
});

void test('非 2xx 响应抛出可读错误', async () => {
  const clock = fakeClock();
  await assert.rejects(
    pollSourceTest({
      sourceId: 'source_1',
      testId: 'test_1',
      headers: {},
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: async () =>
        jsonResponse({ error: '当前角色无权查看来源测试。' }, 403),
    }),
    /当前角色无权查看来源测试。/,
  );
});

void test('默认预算大于单次抓取超时', () => {
  assert.ok(SOURCE_TEST_POLL_BUDGET_MS > 30_000);
});
