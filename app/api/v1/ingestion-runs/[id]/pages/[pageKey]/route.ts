import { POST as commitIngestionPayload } from '@/app/api/v1/ingestion-runs/[id]/commit/route';
import { stableHash } from '@/lib/hash';
import { sourceApiError } from '@/lib/source-api-error';

const MAX_BODY_BYTES = 10_000_000;

/**
 * URL 中的 pageKey 是幂等身份；请求体只描述页面内容和前后 checkpoint。
 * 这里生成服务端内容哈希后复用原子提交实现，客户端不能自报或覆盖哈希。
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; pageKey: string }> },
) {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return sourceApiError('单页采集提交不能超过 10 MB。', 413);
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return sourceApiError('请求体必须是 JSON 对象。', 400);
  }
  const { id, pageKey } = await context.params;
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(pageKey)) {
    return sourceApiError('pageKey 格式无效。', 422);
  }
  const { pageKey: _ignoredPageKey, pageContentHash: _ignoredHash, ...pageBody } = body;
  const forwarded = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({
      ...pageBody,
      pageKey,
      pageContentHash: stableHash(pageBody),
    }),
  });
  return commitIngestionPayload(forwarded, {
    params: Promise.resolve({ id }),
  });
}
