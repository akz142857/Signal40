import { responseErrorText } from './response-error.ts';

/**
 * 等待连接测试结果的墙钟预算。
 *
 * 单次抓取自带 30s 超时，作业失败还会退避重试，因此预算必须明显大于一次抓取。
 * 曾经的「30 次 × 1s」在 Worker 一切正常时也会提前放弃：结果 30.25s 落库，
 * 界面 30.0s 就不再看了，于是永远停在转圈上。
 */
export const SOURCE_TEST_POLL_BUDGET_MS = 180_000;

export type SourceTestPreviewItem = {
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
  summary?: string;
};

export type SourceTestRecord = {
  status: string;
  preview: SourceTestPreviewItem[];
  errorCode?: string | null;
  errorMessage?: string | null;
  expiresAt?: string | null;
};

export type SourceTestOutcome =
  | { status: 'succeeded'; preview: SourceTestPreviewItem[] }
  | { status: 'failed'; message: string }
  | { status: 'pending' };

/**
 * 把公开投影的 `errorCode` / `errorMessage` 拼成一句可读的失败原因。
 *
 * 投影里从来没有 `error_detail_redacted` 字段，界面照着那个名字取值只会拿到
 * undefined，于是所有失败都退化成同一句「连接测试失败。」，SSRF_BLOCKED
 * 这类真正说明问题的原因反而看不见。
 */
export function sourceTestFailureMessage(test: SourceTestRecord) {
  const detail = test.errorMessage?.trim();
  const code = test.errorCode?.trim();
  if (detail) return code ? `${detail}（${code}）` : detail;
  return code ? `连接测试失败：${code}。` : '连接测试失败。';
}

/**
 * 轮询连接测试直到出结果。
 *
 * `pending` 不是失败，只是这轮没等到结论；调用方必须把它呈现成可重试状态，
 * 不能继续显示「正在验证」。
 */
export async function pollSourceTest(options: {
  sourceId: string;
  testId: string;
  headers: Record<string, string>;
  budgetMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}): Promise<SourceTestOutcome> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const doFetch = options.fetchImpl ?? fetch;
  const deadline = now() + (options.budgetMs ?? SOURCE_TEST_POLL_BUDGET_MS);
  while (now() < deadline) {
    const response = await doFetch(
      `/api/v1/source-configs/${encodeURIComponent(options.sourceId)}/tests/${encodeURIComponent(options.testId)}`,
      { cache: 'no-store', headers: options.headers },
    );
    if (!response.ok) throw new Error(await responseErrorText(response));
    const payload = (await response.json()) as { test: SourceTestRecord };
    if (payload.test.status === 'succeeded')
      return { status: 'succeeded', preview: payload.test.preview };
    if (payload.test.status === 'failed')
      return {
        status: 'failed',
        message: sourceTestFailureMessage(payload.test),
      };
    const expiresAt = payload.test.expiresAt
      ? Date.parse(payload.test.expiresAt)
      : Number.NaN;
    if (Number.isFinite(expiresAt) && now() > expiresAt)
      return { status: 'failed', message: '本次测试已过期，请重新测试。' };
    await sleep(1_000);
  }
  return { status: 'pending' };
}
