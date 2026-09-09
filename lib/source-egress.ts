import dns from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import { assertPublicHttpUrl } from './source-adapters.ts';
import { isPrivateIpAddress } from './net-guard.ts';

export class SourceEgressError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code: string, options: { retryable?: boolean; retryAfterSeconds?: number } = {}) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

function parseRetryAfter(value: string | null, now = new Date()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds));
  const at = new Date(value).valueOf();
  return Number.isFinite(at) ? Math.min(86_400, Math.max(0, Math.ceil((at - now.valueOf()) / 1000))) : undefined;
}

export type SourceEgressResult = {
  url: string;
  contentType: string;
  text: string;
  byteCount: number;
  requestCount: number;
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
};

export function assertNoSensitiveReflection(text: string, sensitiveValues: string[]) {
  if (sensitiveValues.some((value) => value.length >= 4 && text.includes(value))) {
    throw new SourceEgressError('上游响应疑似回显凭据，响应已丢弃。', 'UPSTREAM_SECRET_REFLECTION');
  }
}

/**
 * Node 控制面内的 DNS-pinned、有界 GET。secret header 只发给初始 origin；
 * 任何跨 origin 重定向都会永久剥离它，即使随后又跳回原站。
 */
export async function fetchSourceThroughBroker(input: {
  url: string;
  secretHeader: { name: string; value: string };
  sensitiveValues?: string[];
  conditional?: { etag?: string; lastModified?: string };
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}): Promise<SourceEgressResult> {
  let url: string;
  try { url = assertPublicHttpUrl(input.url); }
  catch (error) { throw new SourceEgressError(error instanceof Error ? error.message : '来源 URL 不安全。', 'SSRF_BLOCKED'); }
  const initialOrigin = new URL(url).origin;
  let credentialAllowed = true;
  let requestCount = 0;
  const maxBytes = Math.min(Math.max(input.maxBytes ?? 5_000_000, 1), 5_000_000);
  const maxRedirects = Math.min(Math.max(input.maxRedirects ?? 3, 0), 3);

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const parsed = new URL(url);
    let addresses: Array<{ address: string; family: number }>;
    try { addresses = await dns.lookup(parsed.hostname, { all: true, order: 'verbatim' }); }
    catch { throw new SourceEgressError('来源 DNS 解析失败。', 'NETWORK', { retryable: true }); }
    if (!addresses.length || addresses.some(({ address }) => isPrivateIpAddress(address))) {
      throw new SourceEgressError('来源 DNS 解析到私有或保留网络。', 'SSRF_BLOCKED');
    }
    const pinned = addresses[0];
    const dispatcher = new Agent({
      connect: { lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family) },
    });
    const headers: Record<string, string> = {
      accept: 'application/json, application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.1',
      'user-agent': 'Signal40-Credential-Broker/1.0',
    };
    if (input.conditional?.etag) headers['if-none-match'] = input.conditional.etag;
    if (input.conditional?.lastModified) headers['if-modified-since'] = input.conditional.lastModified;
    if (credentialAllowed && parsed.origin === initialOrigin) headers[input.secretHeader.name] = input.secretHeader.value;
    try {
      let response: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        response = await undiciFetch(url, {
          method: 'GET', redirect: 'manual', headers,
          signal: AbortSignal.timeout(Math.min(Math.max(input.timeoutMs ?? 20_000, 1_000), 30_000)),
          dispatcher,
        });
      } catch (error) {
        if (error instanceof SourceEgressError) throw error;
        throw new SourceEgressError('来源网络请求失败。', 'NETWORK', { retryable: true });
      }
      requestCount += 1;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new SourceEgressError('来源重定向缺少 Location。', 'SCHEMA_CHANGED');
        let nextUrl: string;
        try { nextUrl = assertPublicHttpUrl(new URL(location, url).toString()); }
        catch (error) { throw new SourceEgressError(error instanceof Error ? error.message : '来源重定向目标不安全。', 'SSRF_BLOCKED'); }
        if (new URL(nextUrl).origin !== parsed.origin) credentialAllowed = false;
        url = nextUrl;
        await response.body?.cancel();
        continue;
      }
      if (response.status === 304) {
        assertNoSensitiveReflection(
          [response.headers.get('content-type'), response.headers.get('etag'), response.headers.get('last-modified')].filter(Boolean).join('\n'),
          input.sensitiveValues ?? [input.secretHeader.value],
        );
        return {
          url, contentType: response.headers.get('content-type') ?? '', text: '', byteCount: 0,
          requestCount, notModified: true, etag: response.headers.get('etag') ?? input.conditional?.etag ?? null,
          lastModified: response.headers.get('last-modified') ?? input.conditional?.lastModified ?? null,
        };
      }
      if (response.status === 429) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'));
        throw new SourceEgressError('来源请求受限：HTTP 429。', 'RATE_LIMITED', { retryable: true, retryAfterSeconds });
      }
      if (response.status === 401 || response.status === 403) throw new SourceEgressError(`来源需要重新授权：HTTP ${response.status}。`, 'AUTH_REQUIRED');
      if (response.status >= 500) throw new SourceEgressError(`来源上游暂时不可用：HTTP ${response.status}。`, 'NETWORK', { retryable: true });
      if (!response.ok) throw new SourceEgressError(`来源请求不受支持：HTTP ${response.status}。`, 'PERMANENT_UNSUPPORTED');
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > maxBytes) throw new SourceEgressError(`来源响应超过 ${maxBytes} bytes。`, 'PAYLOAD_LIMIT');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new SourceEgressError(`来源响应超过 ${maxBytes} bytes。`, 'PAYLOAD_LIMIT');
      const text = new TextDecoder().decode(bytes);
      assertNoSensitiveReflection(
        [response.headers.get('content-type'), response.headers.get('etag'), response.headers.get('last-modified'), text].filter(Boolean).join('\n'),
        input.sensitiveValues ?? [input.secretHeader.value],
      );
      return {
        url, contentType: response.headers.get('content-type') ?? '', text,
        byteCount: bytes.byteLength, requestCount, notModified: false,
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
      };
    } finally {
      await dispatcher.close();
    }
  }
  throw new SourceEgressError(`来源重定向次数超过 ${maxRedirects} 次。`, 'REDIRECT_LIMIT');
}
