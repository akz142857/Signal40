import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Agent, fetch as undiciFetch } from 'undici';
import type { ProjectRecord } from '../lib/control-plane.ts';
import { isPrivateIpAddress } from '../lib/net-guard.ts';
import { mapHttpJsonPage, parsePublicWebPage, parseRssFeed, assertPublicHttpUrl, type HttpJsonPaginationConfig, type SourceConfigInput, type SourceItemRejection } from '../lib/source-adapters.ts';
import { validateArticleInput, type ArticleInput } from '../lib/domain.ts';
import { sha256Hex } from '../lib/hash.ts';
import { sourceItemEventAt, type NormalizedSourceItem } from '../lib/source-normalized-item.ts';
import {
  advanceHttpJsonPagination,
  buildHttpJsonPageUrl,
  filterIncrementalSourceItems,
  filterPagedIncrementalSourceItems,
  initialHttpJsonPageState,
  normalizeHttpJsonPagination,
  parseRetryAfterSeconds,
} from '../lib/source-pagination.ts';
import { resolveWorkerEnvironment } from '../lib/workload-env.ts';
import { openCliSocialArgs, parseOpenCliSocialSearch } from '../lib/opencli-social.ts';

// 控制面地址：优先 SIGNAL40_CONTROL_URL，否则按本机 PORT 推导。
// Worker 与控制面通常同机开发，端口只在 .env 里配一次。
const resolvedWorkerEnvironment = resolveWorkerEnvironment({
  ...process.env,
  SIGNAL40_CONTROL_URL: process.env.SIGNAL40_CONTROL_URL || (process.env.PORT ? `http://localhost:${process.env.PORT}` : ''),
});
const controlUrl = resolvedWorkerEnvironment.controlUrl;
const openAiApiKey = process.env.OPENAI_API_KEY;
const workerProfile = resolvedWorkerEnvironment.profile;
const workerToken = resolvedWorkerEnvironment.token;
const profileWorkerId = workerProfile === 'source'
  ? process.env.SIGNAL40_SOURCE_WORKER_ID
  : workerProfile === 'render'
    ? process.env.SIGNAL40_RENDER_WORKER_ID
    : process.env.SIGNAL40_WORKER_ID;
const workerId = profileWorkerId || `${workerProfile}-${os.hostname()}`;
const requiredWorkerToken = workerToken;

const workerHeaders = { 'content-type': 'application/json', 'x-worker-token': requiredWorkerToken };

function leasedProjectUrl(job: WorkerJob) {
  if (!job.project_id) throw new Error('作业缺少 project_id。');
  const query = new URLSearchParams({
    jobId: job.id,
    workerId,
    leaseEpoch: String(job.lease_epoch),
  });
  return `${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}?${query}`;
}

function leasedAssetHeaders(job: WorkerJob, headers: Record<string, string>) {
  return {
    ...headers,
    'x-worker-token': requiredWorkerToken,
    'x-job-id': job.id,
    'x-worker-id': workerId,
    'x-lease-epoch': String(job.lease_epoch),
  };
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function ingestionCommitJson<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const text = await response.text();
  let payload: { error?: unknown; errorCode?: unknown } = {};
  try { payload = JSON.parse(text) as typeof payload; }
  catch { /* Fall through to a bounded generic error. */ }
  const message = typeof payload.error === 'string' ? payload.error.slice(0, 500) : `采集提交失败：HTTP ${response.status}`;
  if (payload.errorCode === 'RIGHTS_BLOCKED') throw new TerminalJobError(message, 'RIGHTS_BLOCKED');
  if (payload.errorCode === 'CONNECTOR_DISABLED') throw new TerminalJobError(message, 'CONNECTOR_DISABLED');
  throw new Error(`${response.status} ${message}`);
}

/** 不可重试的失败（例如自动 QC 未通过）：重试只会重复烧掉同样的渲染成本。 */
class TerminalJobError extends Error {
  readonly errorCode: string;
  constructor(message: string, errorCode = 'SCHEMA_CHANGED') {
    super(message);
    this.errorCode = errorCode;
  }
}

class RetryableJobError extends Error {
  readonly errorCode: string;
  readonly retryDelaySeconds?: number;
  constructor(message: string, errorCode = 'NETWORK', retryDelaySeconds?: number) {
    super(message);
    this.errorCode = errorCode;
    this.retryDelaySeconds = retryDelaySeconds;
  }
}

/**
 * 上游（OpenAI / YouTube）错误只保留状态码和截断后的消息，
 * 不把响应体原样写进作业错误与日志，避免回显上游返回的敏感内容。
 */
async function describeUpstream(label: string, response: Response) {
  const text = await response.text().catch(() => '');
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
    const candidate = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (typeof candidate === 'string') message = candidate;
  } catch { /* 非 JSON 响应，按纯文本截断处理 */ }
  return `${label}：HTTP ${response.status} ${message.replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/** 作业 ID 会被拼进临时文件名与上传文件名，纵深防御地拒绝非常规字符。 */
function assertSafeJobId(id: string) {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error('作业 ID 含非法字符。');
  return id;
}

async function runQc(videoPath: string, projectPath: string) {
  return new Promise<{ status: string; checks: unknown[] }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', path.resolve('scripts/media-qc.ts'), videoPath, projectPath]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('exit', () => {
      try { resolve(JSON.parse(output) as { status: string; checks: unknown[] }); }
      catch { reject(new Error(`无法解析 QC 输出：${output.slice(-2000)}`)); }
    });
  });
}

async function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    let error = '';
    child.stderr.on('data', (data) => { error += String(data); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} 失败：${error.slice(-1500)}`)));
  });
}

type WorkerJob = { id: string; kind: string; project_id: string | null; lease_epoch: number; payload: Record<string, unknown> };

type AlignmentWord = { word: string; start: number; end: number };

function captionChunks(text: string, maxCharacters = 18) {
  const clauses = text.match(/.*?[，。！？；：,.!?;:]|.+$/g)?.map((item) => item.trim()).filter(Boolean) ?? [text];
  return clauses.flatMap((clause) => {
    const characters = Array.from(clause);
    const result: string[] = [];
    for (let index = 0; index < characters.length; index += maxCharacters) result.push(characters.slice(index, index + maxCharacters).join(''));
    return result;
  });
}

function buildCaptions(lines: ProjectRecord['project']['script']['lines'], durationMs: number, alignment: AlignmentWord[] = []) {
  const weighted = lines.map((line) => ({ ...line, chunks: captionChunks(line.text), weight: Math.max(1, Array.from(line.text).length) }));
  const totalWeight = weighted.reduce((sum, line) => sum + line.weight, 0);
  let cursor = 0;
  return weighted.flatMap((line) => {
    const lineDuration = durationMs * line.weight / totalWeight;
    const chunkWeight = line.chunks.reduce((sum, chunk) => sum + Math.max(1, Array.from(chunk).length), 0);
    return line.chunks.map((text) => {
      const startRatio = cursor / durationMs;
      const proportionalDuration = lineDuration * Math.max(1, Array.from(text).length) / chunkWeight;
      cursor += proportionalDuration;
      const endRatio = cursor / durationMs;
      const startWord = alignment[Math.min(alignment.length - 1, Math.floor(startRatio * alignment.length))];
      const endWord = alignment[Math.min(alignment.length - 1, Math.max(0, Math.ceil(endRatio * alignment.length) - 1))];
      const startMs = startWord ? Math.round(startWord.start * 1000) : Math.round(cursor - proportionalDuration);
      const endMs = endWord ? Math.round(endWord.end * 1000) : Math.round(cursor);
      return {
        startMs: Math.max(0, startMs),
        endMs: Math.min(durationMs, Math.max(startMs + 120, endMs)),
        text,
        lineId: line.id,
        granularity: 'sentence' as const,
        style: line.id.includes('takeaway') ? 'disclaimer' as const : 'default' as const,
        safeArea: { left: 72, right: 72, top: 160, bottom: 280 },
        manuallyEdited: false,
      };
    });
  });
}

type SourceCheckpoint = {
  schemaVersion?: unknown;
  connector?: unknown;
  connectorVersion?: unknown;
  paginationMode?: unknown;
  etag?: unknown;
  lastModified?: unknown;
  lastFetchOutcome?: unknown;
  watermark?: unknown;
  tieBreakerIds?: unknown;
  cursor?: unknown;
  pageNumber?: unknown;
  sinceWatermark?: unknown;
  runWatermark?: unknown;
  runTieBreakerIds?: unknown;
  mode?: unknown;
  range?: unknown;
  maxItems?: unknown;
  completed?: unknown;
  acceptedThrough?: unknown;
  fingerprints?: unknown;
};

type RuntimeSource = {
  id: string;
  name: string;
  adapter: string;
  platform: string;
  enabled: boolean;
  rights_status: string;
  config_hash: string;
  rate_limit_per_minute: number;
  retention_mode: 'metadata' | 'raw';
  retention_days: number;
  config: {
    sourceType: SourceConfigInput['sourceType'];
    url?: string;
    mapping?: Record<string, string>;
    pagination?: HttpJsonPaginationConfig;
    discoveryMode?: 'opencli' | 'rss';
    accountName?: string;
    searchLimit?: number;
  };
};

async function fetchOpenCliSocial(source: RuntimeSource) {
  if (source.platform !== 'wechat' && source.platform !== 'xiaohongshu') {
    throw new TerminalJobError('OpenCLI 社交连接器只支持微信和小红书。');
  }
  const accountName = source.config.accountName?.trim();
  if (!accountName) throw new TerminalJobError('OpenCLI 社交来源缺少账号名称。');
  const platformMaximum = source.platform === 'wechat' ? 10 : 20;
  const limit = Math.max(1, Math.min(platformMaximum, source.config.searchLimit ?? platformMaximum));
  const executable = process.env.SIGNAL40_OPENCLI_BIN?.trim() || 'opencli';
  const args = openCliSocialArgs(source.platform, accountName, limit);
  return new Promise<{ articles: ArticleInput[]; raw: string; byteCount: number }>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new RetryableJobError('OpenCLI 查询超过 90 秒。', 'OPENCLI_TIMEOUT', 300)));
    }, 90_000);
    child.stdout.on('data', (data) => {
      stdout += String(data);
      if (Buffer.byteLength(stdout) > 5_000_000) {
        child.kill('SIGTERM');
        finish(() => reject(new TerminalJobError('OpenCLI 输出超过 5 MB。', 'PAYLOAD_LIMIT')));
      }
    });
    child.stderr.resume();
    child.on('error', (error: NodeJS.ErrnoException) => finish(() => reject(
      error.code === 'ENOENT'
        ? new TerminalJobError('OpenCLI 未安装；请在来源 Worker 主机安装 opencli，或设置 SIGNAL40_OPENCLI_BIN。', 'OPENCLI_UNAVAILABLE')
        : new RetryableJobError(`OpenCLI 启动失败：${error.message.slice(0, 200)}`, 'OPENCLI_UNAVAILABLE', 300),
    )));
    child.on('exit', (code) => finish(() => {
      if (code !== 0) {
        if (code === 77) return reject(new TerminalJobError('OpenCLI 需要登录或授权。', 'OPENCLI_AUTH_REQUIRED'));
        if (code === 69 || code === 78) return reject(new TerminalJobError('OpenCLI 或 Browser Bridge 尚未就绪。', 'OPENCLI_UNAVAILABLE'));
        return reject(new RetryableJobError(`OpenCLI 查询失败（退出码 ${code}）。`, 'NETWORK', 300));
      }
      let payload: unknown;
      try { payload = JSON.parse(stdout) as unknown; }
      catch { return reject(new TerminalJobError('OpenCLI 没有返回有效 JSON。', 'SCHEMA_CHANGED')); }
      resolve({
        articles: parseOpenCliSocialSearch(payload, {
          platform: source.platform as 'wechat' | 'xiaohongshu',
          name: source.name,
          sourceType: source.config.sourceType,
          accountName,
        }),
        raw: stdout,
        byteCount: Buffer.byteLength(stdout),
      });
    }));
  });
}

async function fetchPublicSource(initialUrl: string, checkpoint: SourceCheckpoint = {}) {
  let url: string;
  try { url = assertPublicHttpUrl(initialUrl); }
  catch (error) { throw new TerminalJobError(error instanceof Error ? error.message : '来源 URL 不安全。', 'SSRF_BLOCKED'); }
  let requestCount = 0;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const hostname = new URL(url).hostname;
    const addresses = await dns.lookup(hostname, { all: true, order: 'verbatim' });
    if (!addresses.length || addresses.some(({ address }) => isPrivateIpAddress(address))) throw new TerminalJobError('来源 DNS 解析到私有或保留网络。', 'SSRF_BLOCKED');
    const pinned = addresses[0];
    // DNS 校验结果直接注入实际 socket lookup；Host 与 TLS SNI 仍使用原始域名，
    // 避免“先校验、fetch 再解析”留下 DNS rebinding/TOCTOU 窗口。
    const dispatcher = new Agent({
      connect: {
        // Node 20+ 默认打开 autoSelectFamily，socket 会以 all:true 调用 lookup 并要求数组回调；
        // 只回字符串会被判成 ERR_INVALID_IP_ADDRESS，连接还没建立就失败。
        lookup: (_hostname, options, callback) => (
          options.all
            ? callback(null, [{ address: pinned.address, family: pinned.family }])
            : callback(null, pinned.address, pinned.family)
        ),
      },
    });
    const headers: Record<string, string> = {
      accept: 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.1',
      'user-agent': 'Signal40-Ingestion/1.0',
    };
    if (typeof checkpoint.etag === 'string' && checkpoint.etag) headers['if-none-match'] = checkpoint.etag;
    if (typeof checkpoint.lastModified === 'string' && checkpoint.lastModified) headers['if-modified-since'] = checkpoint.lastModified;
    try {
      const response = await undiciFetch(url, {
        redirect: 'manual',
        headers,
        signal: AbortSignal.timeout(20_000),
        dispatcher,
      });
      requestCount += 1;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new TerminalJobError('来源重定向缺少 Location。', 'SCHEMA_CHANGED');
        try { url = assertPublicHttpUrl(new URL(location, url).toString()); }
        catch (error) { throw new TerminalJobError(error instanceof Error ? error.message : '来源重定向目标不安全。', 'SSRF_BLOCKED'); }
        continue;
      }
      if (response.status === 304) {
        return {
          url,
          contentType: response.headers.get('content-type') ?? '',
          text: '',
          byteCount: 0,
          requestCount,
          notModified: true,
          etag: response.headers.get('etag') ?? (typeof checkpoint.etag === 'string' ? checkpoint.etag : null),
          lastModified: response.headers.get('last-modified') ?? (typeof checkpoint.lastModified === 'string' ? checkpoint.lastModified : null),
        };
      }
      if (response.status === 429) {
        const retryAfter = parseRetryAfterSeconds(response.headers.get('retry-after'));
        throw new RetryableJobError(
          retryAfter === null ? '来源请求受限：HTTP 429。' : `来源请求受限：HTTP 429，${retryAfter} 秒后重试。`,
          'RATE_LIMITED',
          retryAfter ?? undefined,
        );
      }
      if (response.status === 401 || response.status === 403) throw new TerminalJobError(`公开来源拒绝访问：HTTP ${response.status}。`, 'PERMANENT_UNSUPPORTED');
      if (response.status >= 500) throw new RetryableJobError(`来源上游暂时不可用：HTTP ${response.status}。`);
      if (!response.ok) throw new TerminalJobError(`来源请求不受支持：HTTP ${response.status}。`, 'PERMANENT_UNSUPPORTED');
      const declaredLength = Number(response.headers.get('content-length') ?? 0);
      if (declaredLength > 5_000_000) throw new TerminalJobError('来源响应超过 5 MB。', 'PAYLOAD_LIMIT');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 5_000_000) throw new TerminalJobError('来源响应超过 5 MB。', 'PAYLOAD_LIMIT');
      return {
        url,
        contentType: response.headers.get('content-type') ?? '',
        text: new TextDecoder().decode(bytes),
        byteCount: bytes.byteLength,
        requestCount,
        notModified: false,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };
    } finally {
      await dispatcher.close();
    }
  }
  throw new TerminalJobError('来源重定向次数超过 3 次。', 'REDIRECT_LIMIT');
}

async function workPagedHttpJsonIngestion(
  job: WorkerJob,
  source: RuntimeSource,
  config: SourceConfigInput,
  ingestionRunId: string,
  initialCheckpoint: SourceCheckpoint,
) {
  const recoveryUrl = new URL(`${controlUrl}/api/v1/ingestion-runs/${encodeURIComponent(ingestionRunId)}/pages`);
  recoveryUrl.searchParams.set('jobId', job.id);
  recoveryUrl.searchParams.set('workerId', workerId);
  recoveryUrl.searchParams.set('leaseEpoch', String(job.lease_epoch));
  const recovery = await json<{
    pageCount: number;
    nextPageOrdinal: number;
    lastPageKey: string | null;
    finalPageCommitted: boolean;
    resumeCheckpointJson: SourceCheckpoint;
    totals: {
      fetchedCount: number;
      acceptedCount: number;
      rejectedCount: number;
      duplicateCount: number;
      requestCount: number;
      byteCount: number;
    };
  }>(await fetch(recoveryUrl, { headers: workerHeaders }));
  let pageOrdinal = recovery.nextPageOrdinal;
  let lastPageKey = recovery.lastPageKey;
  let checkpointBefore = recovery.pageCount > 0
    ? recovery.resumeCheckpointJson
    : initialCheckpoint;
  const totals = { ...recovery.totals };

  if (!recovery.finalPageCommitted) {
    const pagination = normalizeHttpJsonPagination(source.config.pagination);
    let state = initialHttpJsonPageState(pagination, checkpointBefore);
    const runBoundary = {
      watermark: typeof checkpointBefore.runWatermark === 'string'
        ? checkpointBefore.runWatermark
        : checkpointBefore.watermark,
      tieBreakerIds: Array.isArray(checkpointBefore.runTieBreakerIds)
        ? checkpointBefore.runTieBreakerIds
        : checkpointBefore.tieBreakerIds,
    };
    const sinceWatermark = typeof checkpointBefore.sinceWatermark === 'string'
      ? checkpointBefore.sinceWatermark
      : checkpointBefore.watermark;
    const seenCursors = new Set<string>(state.cursor ? [state.cursor] : []);
    const backfillRange = checkpointBefore.mode === 'backfill'
      && checkpointBefore.range && typeof checkpointBefore.range === 'object'
      && !Array.isArray(checkpointBefore.range)
      ? checkpointBefore.range as { from?: unknown; to?: unknown }
      : null;
    const backfillFrom = backfillRange && typeof backfillRange.from === 'string'
      ? new Date(backfillRange.from).valueOf()
      : Number.NaN;
    const backfillTo = backfillRange && typeof backfillRange.to === 'string'
      ? new Date(backfillRange.to).valueOf()
      : Number.NaN;
    if (backfillRange && (!Number.isFinite(backfillFrom) || !Number.isFinite(backfillTo) || backfillFrom >= backfillTo)) {
      throw new TerminalJobError('补采时间范围无效。');
    }
    const backfillMaxItems = backfillRange && Number.isInteger(checkpointBefore.maxItems)
      ? Math.max(1, Math.min(100, Number(checkpointBefore.maxItems)))
      : 100;

    for (let pageIndex = 0; pageIndex < pagination.maxPages; pageIndex += 1) {
      const pageUrl = buildHttpJsonPageUrl(
        source.config.url!,
        pagination,
        pagination.mode === 'since' ? { ...checkpointBefore, watermark: sinceWatermark } : checkpointBefore,
        state,
      );
      const response = await fetchPublicSource(
        pageUrl,
        pageIndex === 0 && pagination.mode === 'none' ? checkpointBefore : {},
      );
      let payload: unknown = {};
      let page = { articles: [] as ArticleInput[], items: [] as NormalizedSourceItem[], rejections: [] as SourceItemRejection[], fetchedCount: 0 };
      if (!response.notModified) {
        if (!response.contentType.toLowerCase().includes('json')) {
          throw new TerminalJobError('HTTP 适配器要求 JSON Content-Type。');
        }
        try { payload = JSON.parse(response.text) as unknown; }
        catch { throw new TerminalJobError('HTTP JSON 响应不是有效 JSON。'); }
        try { page = mapHttpJsonPage(payload, { ...config, url: response.url }); }
        catch (error) { throw new TerminalJobError(error instanceof Error ? error.message : 'HTTP JSON 字段映射失败。'); }
      }

      const rejections = [...page.rejections];
      let validArticles = page.articles.filter((article, index) => {
        const issue = validateArticleInput(article);
        if (!issue) return true;
        rejections.push({
          itemIndex: index,
          platformItemId: article.id ?? null,
          errorCode: 'INVALID_ITEM',
          detailRedacted: issue.slice(0, 200),
          payloadHash: sha256Hex(JSON.stringify(article)),
        });
        return false;
      });
      let validItems = page.items.filter((item) => item.kind === 'tombstone'
        || validArticles.some((article) => article.url.replace(/#.*$/, '') === item.url.replace(/#.*$/, '')));
      if (backfillRange) {
        const remaining = Math.max(0, backfillMaxItems - totals.acceptedCount);
        validItems = validItems.filter((item) => {
          const eventAt = new Date(sourceItemEventAt(item)).valueOf();
          return eventAt >= backfillFrom && eventAt < backfillTo;
        }).slice(0, remaining);
        const acceptedUrls = new Set(validItems.filter((item) => item.kind === 'upsert').map((item) => item.url.replace(/#.*$/, '')));
        validArticles = validArticles.filter((article) => acceptedUrls.has(article.url.replace(/#.*$/, '')));
      }

      let checkpoint = validItems.map(sourceItemEventAt).sort().at(-1)
        ?? (typeof checkpointBefore.watermark === 'string' ? checkpointBefore.watermark : null);
      let tieBreakerIds = Array.isArray(checkpointBefore.tieBreakerIds)
        ? checkpointBefore.tieBreakerIds.filter((value): value is string => typeof value === 'string')
        : [];
      let skippedCount = 0;
      if (!backfillRange) {
        // 后续页常按时间倒序，不能用第一页已推进的最新 watermark 过滤，
        // 否则会漏掉“比旧水位新、但比第一页旧”的合法条目。接纳始终对比
        // 本轮最初边界，checkpoint 汇总则对比当前已提交边界。
        const incremental = filterPagedIncrementalSourceItems(validItems, runBoundary, {
          watermark: checkpointBefore.watermark,
          tieBreakerIds: checkpointBefore.tieBreakerIds,
        });
        skippedCount = incremental.skippedCount;
        validItems = incremental.items;
        const acceptedUrls = new Set(validItems.filter((item) => item.kind === 'upsert').map((item) => item.url.replace(/#.*$/, '')));
        validArticles = validArticles.filter((article) => acceptedUrls.has(article.url.replace(/#.*$/, '')));
        checkpoint = incremental.watermark;
        tieBreakerIds = incremental.tieBreakerIds;
      }

      let shouldContinue = false;
      let nextCursor: string | null = state.cursor;
      if (!response.notModified) {
        let advance: ReturnType<typeof advanceHttpJsonPagination>;
        try {
          advance = advanceHttpJsonPagination({
            pagination,
            payload,
            state,
            fetchedCount: page.fetchedCount,
            seenCursors,
          });
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error && error.code === 'CURSOR_LOOP'
            ? 'CURSOR_LOOP'
            : 'SCHEMA_CHANGED';
          throw new TerminalJobError(error instanceof Error ? error.message : '分页状态无效。', code);
        }
        state = advance.state;
        nextCursor = advance.cursor;
        shouldContinue = advance.shouldContinue;
      }
      const reachedBackfillLimit = Boolean(backfillRange && totals.acceptedCount + validItems.length >= backfillMaxItems);
      // maxPages 是一次运行的资源上限；保存 cursor 后正常终结，由下一次运行续采，
      // 不把一个合法的大来源误判成永久分页错误。
      const finalPage = response.notModified || !shouldContinue || reachedBackfillLimit || pageIndex === pagination.maxPages - 1;
      const upstreamComplete = response.notModified || !shouldContinue || reachedBackfillLimit;
      const checkpointJson: SourceCheckpoint = backfillRange ? {
        ...checkpointBefore,
        connector: source.adapter,
        connectorVersion: '2',
        completed: finalPage && (!shouldContinue || reachedBackfillLimit),
        acceptedThrough: checkpoint,
        watermark: checkpoint,
        cursor: nextCursor,
        etag: response.etag,
        lastModified: response.lastModified,
        lastFetchOutcome: response.notModified ? 'not_modified' : 'modified',
      } : {
        schemaVersion: 2,
        connector: source.adapter,
        connectorVersion: '2',
        paginationMode: pagination.mode,
        watermark: checkpoint,
        tieBreakerIds,
        cursor: nextCursor,
        pageNumber: pagination.mode === 'page'
          ? (upstreamComplete ? pagination.startPage : state.pageNumber)
          : undefined,
        sinceWatermark: pagination.mode === 'since'
          ? (upstreamComplete ? checkpoint : sinceWatermark)
          : undefined,
        runWatermark: upstreamComplete ? undefined : runBoundary.watermark,
        runTieBreakerIds: upstreamComplete ? undefined : runBoundary.tieBreakerIds,
        etag: response.etag,
        lastModified: response.lastModified,
        lastFetchOutcome: response.notModified ? 'not_modified' : 'modified',
      };
      const pageKey = `page-${pageOrdinal}`;
      const committed = await ingestionCommitJson<{
        acceptedCount: number;
        rejectedCount: number;
        duplicateCount: number;
        fetchedCount: number;
        requestCount: number;
        byteCount: number;
      }>(await fetch(`${controlUrl}/api/v1/ingestion-runs/${encodeURIComponent(ingestionRunId)}/pages/${encodeURIComponent(pageKey)}`, {
        method: 'PUT',
        headers: workerHeaders,
        body: JSON.stringify({
          jobId: job.id,
          workerId,
          leaseEpoch: job.lease_epoch,
          pageOrdinal,
          finalPage,
          checkpointBeforeJson: checkpointBefore,
          items: validItems,
          fetchedCount: page.fetchedCount,
          skippedCount,
          checkpoint,
          checkpointJson,
          rejections,
          requestCount: response.requestCount,
          byteCount: response.byteCount,
        }),
      }));
      totals.fetchedCount += committed.fetchedCount;
      totals.acceptedCount += committed.acceptedCount;
      totals.rejectedCount += committed.rejectedCount;
      totals.duplicateCount += committed.duplicateCount;
      totals.requestCount += committed.requestCount;
      totals.byteCount += committed.byteCount;
      lastPageKey = pageKey;
      pageOrdinal += 1;
      checkpointBefore = checkpointJson;
      if (finalPage) break;
    }
  }

  if (!lastPageKey || pageOrdinal < 1) throw new Error('逐页采集未形成可终结页面。');
  return ingestionCommitJson(await fetch(`${controlUrl}/api/v1/ingestion-runs/${encodeURIComponent(ingestionRunId)}/complete`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({
      jobId: job.id,
      workerId,
      leaseEpoch: job.lease_epoch,
      pageCount: pageOrdinal,
      lastPageKey,
      ...totals,
    }),
  }));
}

async function workIngestion(job: WorkerJob) {
  const sourceConfigId = typeof job.payload.sourceConfigId === 'string' ? job.payload.sourceConfigId : '';
  const ingestionRunId = typeof job.payload.ingestionRunId === 'string' ? job.payload.ingestionRunId : '';
  if (!sourceConfigId || !ingestionRunId) throw new Error('采集作业缺少 sourceConfigId 或 ingestionRunId。');
  const { source } = await json<{ source: RuntimeSource }>(await fetch(`${controlUrl}/api/v1/worker/source-configs/${encodeURIComponent(sourceConfigId)}`, { headers: { 'x-worker-token': requiredWorkerToken } }));
  if (!source.enabled || source.rights_status !== 'approved') throw new Error('来源未启用或授权未批准。');
  if (!['rss', 'http', 'web', 'social'].includes(source.adapter)) throw new Error(`后台 Worker 暂不支持 ${source.adapter} 适配器自动拉取。`);
  if (source.adapter === 'social' && !['opencli', 'rss'].includes(source.config.discoveryMode ?? '')) throw new Error('社交来源缺少有效发现方式。');
  if (source.adapter !== 'social' && !source.config.url) throw new Error('来源缺少 URL。');
  if (source.adapter === 'social' && source.config.discoveryMode === 'rss' && !source.config.url) throw new Error('社交 RSS 来源缺少 Feed URL。');
  const checkpointBefore = job.payload.checkpointJson && typeof job.payload.checkpointJson === 'object' && !Array.isArray(job.payload.checkpointJson)
    ? job.payload.checkpointJson as SourceCheckpoint
    : {};
  const config: SourceConfigInput = {
    name: source.name,
    adapter: source.adapter as 'rss' | 'http' | 'web' | 'social',
    sourceType: source.config.sourceType,
    url: source.config.url,
    rightsStatus: 'approved',
    mapping: source.config.mapping,
    pagination: source.config.pagination,
    discoveryMode: source.config.discoveryMode,
    accountName: source.config.accountName,
    searchLimit: source.config.searchLimit,
    rateLimitPerMinute: source.rate_limit_per_minute,
    retention: { mode: source.retention_mode, days: source.retention_days },
    namespace: source.platform || source.adapter,
    connectorId: typeof job.payload.connectorId === 'string' ? job.payload.connectorId : `${source.adapter}-v1`,
    connectorVersion: typeof job.payload.connectorVersion === 'string' ? job.payload.connectorVersion : '1',
  };
  if (source.adapter === 'http' && source.retention_mode === 'metadata' && job.payload.shadow !== true) {
    return workPagedHttpJsonIngestion(job, source, config, ingestionRunId, checkpointBefore);
  }
  let articles: ArticleInput[] = [];
  let normalizedItems: NormalizedSourceItem[] = [];
  const rejections: SourceItemRejection[] = [];
  let fetchedCount = 0;
  let requestCount = 0;
  let byteCount = 0;
  let responseEtag: string | null = null;
  let responseLastModified: string | null = null;
  let responseContentType = 'application/json';
  let notModified = false;
  const rawPages: string[] = [];
  let paginationCursor: string | null = null;
  let paginationMode: HttpJsonPaginationConfig['mode'] = 'none';
  if (source.adapter === 'social' && source.config.discoveryMode === 'opencli') {
    const response = await fetchOpenCliSocial(source);
    articles = response.articles;
    fetchedCount = articles.length;
    requestCount = 1;
    byteCount = response.byteCount;
    responseContentType = 'application/json';
    rawPages.push(response.raw);
  } else if (source.adapter === 'rss' || source.adapter === 'web' || source.adapter === 'social') {
    const response = await fetchPublicSource(source.config.url!, checkpointBefore);
    requestCount = response.requestCount;
    byteCount = response.byteCount;
    responseEtag = response.etag;
    responseLastModified = response.lastModified;
    responseContentType = response.contentType || 'application/xml';
    notModified = response.notModified;
    if (!response.notModified) {
      rawPages.push(response.text);
      articles = source.adapter === 'rss' || source.adapter === 'social'
        ? parseRssFeed(response.text, { ...config, url: response.url })
        : parsePublicWebPage(response.text, { ...config, url: response.url }, new Date().toISOString());
      fetchedCount = articles.length;
    }
  } else {
    const pagination = normalizeHttpJsonPagination(source.config.pagination);
    paginationMode = pagination.mode;
    let state = initialHttpJsonPageState(pagination, checkpointBefore);
    paginationCursor = state.cursor;
    const seenCursors = new Set<string>(state.cursor ? [state.cursor] : []);
    for (let pageIndex = 0; pageIndex < pagination.maxPages; pageIndex += 1) {
      const pageUrl = buildHttpJsonPageUrl(source.config.url!, pagination, checkpointBefore, state);
      const response = await fetchPublicSource(pageUrl, pageIndex === 0 && pagination.mode === 'none' ? checkpointBefore : {});
      requestCount += response.requestCount;
      byteCount += response.byteCount;
      responseEtag = response.etag;
      responseLastModified = response.lastModified;
      responseContentType = response.contentType || 'application/json';
      if (byteCount > 10_000_000) throw new TerminalJobError('HTTP JSON 单次运行响应超过 10 MB。', 'PAYLOAD_LIMIT');
      if (response.notModified) {
        notModified = true;
        break;
      }
      if (!response.contentType.toLowerCase().includes('json')) throw new TerminalJobError('HTTP 适配器要求 JSON Content-Type。');
      let payload: unknown;
      try { payload = JSON.parse(response.text) as unknown; }
      catch { throw new TerminalJobError('HTTP JSON 响应不是有效 JSON。'); }
      rawPages.push(response.text);
      let page: ReturnType<typeof mapHttpJsonPage>;
      try { page = mapHttpJsonPage(payload, { ...config, url: response.url }); }
      catch (error) { throw new TerminalJobError(error instanceof Error ? error.message : 'HTTP JSON 字段映射失败。'); }
      const itemOffset = fetchedCount;
      articles.push(...page.articles);
      normalizedItems.push(...page.items);
      rejections.push(...page.rejections.map((rejection) => ({ ...rejection, itemIndex: rejection.itemIndex + itemOffset })));
      fetchedCount += page.fetchedCount;
      if (fetchedCount > 1_000) throw new TerminalJobError('HTTP JSON 单次运行条目超过 1000 条。', 'PAGINATION_LIMIT');

      let advance: ReturnType<typeof advanceHttpJsonPagination>;
      try { advance = advanceHttpJsonPagination({ pagination, payload, state, fetchedCount: page.fetchedCount, seenCursors }); }
      catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && error.code === 'CURSOR_LOOP' ? 'CURSOR_LOOP' : 'SCHEMA_CHANGED';
        throw new TerminalJobError(error instanceof Error ? error.message : '分页状态无效。', code);
      }
      const { shouldContinue } = advance;
      state = advance.state;
      paginationCursor = advance.cursor;
      if (!shouldContinue) break;
      if (pageIndex === pagination.maxPages - 1) throw new TerminalJobError(`HTTP JSON 超过配置的 ${pagination.maxPages} 页上限。`, 'PAGINATION_LIMIT');
    }
  }
  const backfillRange = checkpointBefore.mode === 'backfill'
    && checkpointBefore.range && typeof checkpointBefore.range === 'object'
    && !Array.isArray(checkpointBefore.range)
    ? checkpointBefore.range as { from?: unknown; to?: unknown }
    : null;
  if (backfillRange) {
    const from = typeof backfillRange.from === 'string' ? new Date(backfillRange.from).valueOf() : Number.NaN;
    const to = typeof backfillRange.to === 'string' ? new Date(backfillRange.to).valueOf() : Number.NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new TerminalJobError('补采时间范围无效。');
    const maxItems = Number.isInteger(checkpointBefore.maxItems)
      ? Math.max(1, Math.min(100, Number(checkpointBefore.maxItems)))
      : 100;
    if (source.adapter === 'http') {
      normalizedItems = normalizedItems.filter((item) => {
        const eventAt = new Date(sourceItemEventAt(item)).valueOf();
        return eventAt >= from && eventAt < to;
      }).slice(0, maxItems);
      const acceptedUrls = new Set(normalizedItems.filter((item) => item.kind === 'upsert').map((item) => item.url.replace(/#.*$/, '')));
      articles = articles.filter((article) => acceptedUrls.has(article.url.replace(/#.*$/, '')));
    } else {
      articles = articles
        .filter((article) => {
          const publishedAt = new Date(article.publishedAt).valueOf();
          return publishedAt >= from && publishedAt < to;
        })
        .slice(0, maxItems);
    }
  }
  let validArticles = articles.filter((article, index) => {
    const issue = validateArticleInput(article);
    if (!issue) return true;
    rejections.push({
      itemIndex: index,
      platformItemId: article.id ?? null,
      errorCode: 'INVALID_ITEM',
      detailRedacted: issue.slice(0, 200),
      payloadHash: sha256Hex(JSON.stringify(article)),
    });
    return false;
  });
  if (source.adapter === 'http') {
    const validUrls = new Set(validArticles.map((article) => article.url.replace(/#.*$/, '')));
    normalizedItems = normalizedItems.filter((item) => item.kind === 'tombstone' || validUrls.has(item.url.replace(/#.*$/, '')));
  }
  let checkpoint = (source.adapter === 'http' ? normalizedItems.map(sourceItemEventAt) : validArticles.map((article) => article.publishedAt)).sort().at(-1)
    ?? (typeof checkpointBefore.watermark === 'string' ? checkpointBefore.watermark : null);
  let tieBreakerIds = Array.isArray(checkpointBefore.tieBreakerIds)
    ? checkpointBefore.tieBreakerIds.filter((value): value is string => typeof value === 'string')
    : [];
  let skippedCount = 0;
  if (!backfillRange && source.adapter === 'http') {
    const incremental = filterIncrementalSourceItems(normalizedItems, checkpointBefore);
    skippedCount = normalizedItems.length - incremental.items.length;
    normalizedItems = incremental.items;
    const acceptedUrls = new Set(normalizedItems.filter((item) => item.kind === 'upsert').map((item) => item.url.replace(/#.*$/, '')));
    validArticles = validArticles.filter((article) => acceptedUrls.has(article.url.replace(/#.*$/, '')));
    checkpoint = incremental.watermark;
    tieBreakerIds = incremental.tieBreakerIds;
  }
  let fingerprints = Array.isArray(checkpointBefore.fingerprints)
    ? checkpointBefore.fingerprints.filter((value): value is string => typeof value === 'string').slice(-500)
    : [];
  if (!backfillRange && source.adapter === 'social') {
    const previous = new Set(fingerprints);
    const current = validArticles.map((article) => sha256Hex([
      // OpenCLI 的部分搜索结果没有发布时间，此时解析器会使用观察时间。
      // 指纹不包含该回退字段，避免同一搜索结果在每次轮询时被当成新文章。
      article.url, article.title, article.summary, article.author,
    ].join('\u0000')));
    const fresh = validArticles.filter((_article, index) => !previous.has(current[index]));
    skippedCount += validArticles.length - fresh.length;
    validArticles = fresh;
    fingerprints = [...new Set([...fingerprints, ...current])].slice(-500);
  }
  const checkpointJson = backfillRange ? {
    ...checkpointBefore,
    connector: source.adapter,
    connectorVersion: source.adapter === 'http' ? '2' : '1',
    completed: true,
    acceptedThrough: checkpoint,
    cursor: paginationCursor,
    etag: responseEtag,
    lastModified: responseLastModified,
    lastFetchOutcome: notModified ? 'not_modified' : 'modified',
    ...(source.adapter === 'social' ? { fingerprints } : {}),
  } : {
    schemaVersion: source.adapter === 'http' ? 2 : 1,
    connector: source.adapter,
    connectorVersion: source.adapter === 'http' ? '2' : '1',
    paginationMode,
    watermark: checkpoint,
    tieBreakerIds,
    cursor: paginationCursor,
    etag: responseEtag,
    lastModified: responseLastModified,
    lastFetchOutcome: notModified ? 'not_modified' : 'modified',
    ...(source.adapter === 'social' ? { fingerprints } : {}),
  };
  let rawObjectKey: string | null = null;
  if (source.retention_mode === 'raw' && !notModified && rawPages.length) {
    const rawBody = rawPages.length === 1 ? rawPages[0] : `{"schemaVersion":1,"pages":[${rawPages.join(',')}]}`;
    const rawUpload = await json<{ objectKey: string }>(await fetch(`${controlUrl}/api/v1/ingestion-runs/${encodeURIComponent(ingestionRunId)}/raw`, {
      method: 'PUT',
      headers: {
        'content-type': responseContentType,
        'x-worker-token': requiredWorkerToken,
        'x-job-id': job.id,
        'x-worker-id': workerId,
        'x-lease-epoch': String(job.lease_epoch),
      },
      body: rawBody,
    }));
    rawObjectKey = rawUpload.objectKey;
  }
  return ingestionCommitJson(await fetch(`${controlUrl}/api/v1/ingestion-runs/${encodeURIComponent(ingestionRunId)}/commit`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({
      jobId: job.id,
      workerId,
      leaseEpoch: job.lease_epoch,
      ...(source.adapter === 'http' ? { items: normalizedItems } : { articles: validArticles }),
      fetchedCount,
      skippedCount,
      checkpoint,
      checkpointJson,
      rawObjectKey,
      ...(source.adapter !== 'http' ? { origins: validArticles.map((article) => ({
        namespace: source.platform || source.adapter,
        platformItemId: article.id || sha256Hex(article.url),
        url: article.url,
      })) } : {}),
      rejections,
      requestCount,
      byteCount,
      notModified,
    }),
  }));
}

async function workSourceTest(job: WorkerJob) {
  const sourceConfigId = typeof job.payload.sourceConfigId === 'string' ? job.payload.sourceConfigId : '';
  const testId = typeof job.payload.testId === 'string' ? job.payload.testId : '';
  const configHash = typeof job.payload.configHash === 'string' ? job.payload.configHash : '';
  if (!sourceConfigId || !testId || !configHash) throw new Error('来源测试作业字段不完整。');
  const { source } = await json<{ source: RuntimeSource }>(await fetch(`${controlUrl}/api/v1/worker/source-configs/${encodeURIComponent(sourceConfigId)}`, {
    headers: { 'x-worker-token': requiredWorkerToken },
  }));
  if (source.config_hash !== configHash) throw new TerminalJobError('来源配置已在测试排队期间变更。');
  if (!['rss', 'http', 'web', 'social'].includes(source.adapter)) throw new TerminalJobError(`连接器不支持测试 ${source.adapter}。`);
  if (source.adapter === 'social' && !['opencli', 'rss'].includes(source.config.discoveryMode ?? '')) throw new TerminalJobError('社交来源缺少有效发现方式。');
  if (source.adapter !== 'social' && !source.config.url) throw new TerminalJobError('来源缺少 URL。');
  if (source.adapter === 'social' && source.config.discoveryMode === 'rss' && !source.config.url) throw new TerminalJobError('社交 RSS 来源缺少 Feed URL。');
  if (source.adapter === 'social' && source.config.discoveryMode === 'opencli') {
    const result = await fetchOpenCliSocial(source);
    const preview = result.articles.filter((article) => validateArticleInput(article) === null).slice(0, 5);
    if (!preview.length) throw new TerminalJobError('OpenCLI 查询成功，但没有解析出有效内容；请核对账号名称和浏览器登录状态。');
    return json(await fetch(
      `${controlUrl}/api/v1/source-configs/${encodeURIComponent(sourceConfigId)}/tests/${encodeURIComponent(testId)}/complete`,
      {
        method: 'POST', headers: workerHeaders,
        body: JSON.stringify({
          jobId: job.id, workerId, leaseEpoch: job.lease_epoch, configHash, preview,
          capabilities: { discoveryMode: 'opencli', accountName: source.config.accountName },
        }),
      },
    ));
  }
  const testUrl = source.adapter === 'http'
    ? buildHttpJsonPageUrl(
        source.config.url!,
        normalizeHttpJsonPagination(source.config.pagination),
        {},
        initialHttpJsonPageState(normalizeHttpJsonPagination(source.config.pagination), {}),
      )
    : source.config.url!;
  const response = await fetchPublicSource(testUrl, {});
  const sourceConfig: SourceConfigInput = {
    name: source.name,
    adapter: source.adapter as 'rss' | 'http' | 'web' | 'social',
    sourceType: source.config.sourceType,
    url: response.url,
    rightsStatus: 'approved',
    mapping: source.config.mapping,
    pagination: source.config.pagination,
    rateLimitPerMinute: source.rate_limit_per_minute,
    retention: { mode: source.retention_mode, days: source.retention_days },
  };
  let articles: ArticleInput[];
  try {
    if (source.adapter === 'rss' || source.adapter === 'social') {
      articles = parseRssFeed(response.text, sourceConfig);
    } else if (source.adapter === 'web') {
      articles = parsePublicWebPage(response.text, { ...sourceConfig, url: response.url });
    } else {
      if (!response.contentType.toLowerCase().includes('json')) throw new Error('HTTP 适配器要求 JSON Content-Type。');
      articles = mapHttpJsonPage(JSON.parse(response.text), sourceConfig).articles;
    }
  } catch (error) {
    throw new TerminalJobError(error instanceof Error ? error.message : '来源内容格式无法解析。');
  }
  const preview = articles.filter((article) => validateArticleInput(article) === null).slice(0, 5);
  if (!preview.length) throw new TerminalJobError('来源可以访问，但没有解析出含标题、URL 和发布时间的有效条目。');
  return json(await fetch(
    `${controlUrl}/api/v1/source-configs/${encodeURIComponent(sourceConfigId)}/tests/${encodeURIComponent(testId)}/complete`,
    {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({
        jobId: job.id,
        workerId,
        leaseEpoch: job.lease_epoch,
        configHash,
        preview,
        capabilities: {
          conditionalRequests: Boolean(response.etag || response.lastModified),
          contentType: response.contentType,
          finalUrl: response.url,
        },
      }),
    },
  ));
}

async function workTopicRecompute(job: WorkerJob) {
  const derivationKey = typeof job.payload.derivationKey === 'string'
    ? job.payload.derivationKey
    : '';
  if (!derivationKey) throw new TerminalJobError('主题重算作业缺少 derivationKey。');
  return json(await fetch(`${controlUrl}/api/v1/pipeline/recompute`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({ jobId: job.id, workerId, leaseEpoch: job.lease_epoch, derivationKey }),
  }));
}

async function workVoice(job: WorkerJob) {
  if (!job.project_id) throw new Error('配音作业缺少 project_id。');
  if (!openAiApiKey) throw new Error('OPENAI_API_KEY 未配置，不能执行云端配音。');
  const projectPayload = await json<{ project: ProjectRecord }>(await fetch(leasedProjectUrl(job), { headers: { 'x-worker-token': requiredWorkerToken } }));
  const project = projectPayload.project.project;
  if (typeof job.payload.scriptHash !== 'string') throw new Error('配音作业缺少 scriptHash。');
  const textInput = project.script.lines.map((line) => line.text).join('\n');
  if (!textInput.trim() || textInput.length > 4096) throw new Error('配音文本必须为 1–4096 个字符。');
  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const voice = process.env.OPENAI_TTS_VOICE || 'coral';
  const pronunciationHints = Object.entries(Object.assign({}, ...project.script.lines.map((line) => line.pronunciationHints)) as Record<string, string>);
  const pronunciationInstruction = pronunciationHints.length ? `读音要求：${pronunciationHints.map(([term, pronunciation]) => `${term} 读作 ${pronunciation}`).join('；')}。` : '';
  const speech = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${openAiApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, input: textInput, response_format: 'mp3', instructions: `使用清晰、克制、可信的普通话新闻播报语气，数字读法准确，避免营销腔。${pronunciationInstruction}` }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!speech.ok) throw new Error(await describeUpstream('OpenAI 配音失败', speech));
  const audio = await speech.arrayBuffer();
  if (audio.byteLength < 1000) throw new Error('OpenAI 返回了空音频。');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voice.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', 'zh');
  const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${openAiApiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
  if (!transcriptionResponse.ok) throw new Error(await describeUpstream('字幕对齐失败', transcriptionResponse));
  const transcription = await json<{ duration?: number; words?: AlignmentWord[] }>(transcriptionResponse);
  const alignment = (transcription.words ?? []).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  const durationMs = Math.round(1000 * (transcription.duration ?? alignment.at(-1)?.end ?? 0));
  if (durationMs < 500) throw new Error('字幕对齐未返回有效音频时长。');
  const upload = await json<{ asset: { id: string } }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/assets`, {
    method: 'POST',
    headers: leasedAssetHeaders(job, { 'content-type': 'audio/mpeg', 'x-filename': encodeURIComponent(`${assertSafeJobId(job.id)}.mp3`), 'x-asset-role': 'voice-output', 'x-rights-status': 'cleared', 'x-rights-note': encodeURIComponent(`OpenAI ${model} built-in voice ${voice}`) }),
    body: audio,
  }));
  return json(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/voice-tracks`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({ jobId: job.id, workerId, leaseEpoch: job.lease_epoch, assetId: upload.asset.id, provider: `openai:${model}`, fallbackProvider: project.audio.fallbackProvider, voice, speed: project.audio.speed, pronunciationDictionary: Object.fromEntries(pronunciationHints), estimatedCostMicros: 0, durationMs, alignment, captions: buildCaptions(project.script.lines, durationMs, alignment), scriptVersion: project.script.version, scriptHash: job.payload.scriptHash }),
  }));
}

async function downloadMedia(objectKey: string) {
  const response = await fetch(`${controlUrl}/api/v1/media?objectKey=${encodeURIComponent(objectKey)}`, { headers: { 'x-worker-token': requiredWorkerToken } });
  if (!response.ok) throw new Error(`媒体下载失败：${response.status} ${await response.text()}`);
  return { bytes: await response.arrayBuffer(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
}

async function uploadYouTube(input: { bytes: ArrayBuffer; contentType: string; title: string; description: string; tags: string[]; privacyStatus: string; cover?: { bytes: ArrayBuffer; contentType: string } | null }) {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) throw new Error('YOUTUBE_ACCESS_TOKEN 未配置。');
  const allowPublic = process.env.SIGNAL40_ALLOW_PUBLIC_PUBLISH === 'true';
  const privacyStatus = allowPublic ? input.privacyStatus : 'private';
  const metadata = JSON.stringify({ snippet: { title: input.title, description: input.description, tags: input.tags, categoryId: '25' }, status: { privacyStatus, selfDeclaredMadeForKids: false } });
  const session = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(input.bytes.byteLength), 'x-upload-content-type': input.contentType },
    body: metadata,
    signal: AbortSignal.timeout(30_000),
  });
  if (!session.ok) throw new Error(await describeUpstream('YouTube 上传会话创建失败', session));
  const location = session.headers.get('location');
  if (!location) throw new Error('YouTube 未返回续传会话 URL。');
  let offset = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const remaining = input.bytes.slice(offset);
    const response = await fetch(location, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': input.contentType, 'content-length': String(remaining.byteLength), 'content-range': `bytes ${offset}-${input.bytes.byteLength - 1}/${input.bytes.byteLength}` },
      body: remaining,
      signal: AbortSignal.timeout(180_000),
    });
    if (response.ok) {
      const video = await json<{ id?: string }>(response);
      if (!video.id) throw new Error('YouTube 上传完成但未返回视频 ID。');
      if (input.cover) {
        const thumbnail = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(video.id)}&uploadType=media`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': input.cover.contentType }, body: input.cover.bytes, signal: AbortSignal.timeout(60_000),
        });
        if (!thumbnail.ok) throw new Error(await describeUpstream('YouTube 封面上传失败', thumbnail));
      }
      return { externalId: video.id, finalUrl: `https://www.youtube.com/watch?v=${video.id}`, privacyStatus };
    }
    if (response.status === 308) {
      const range = response.headers.get('range');
      offset = range ? Number(range.split('-').at(-1)) + 1 : 0;
      continue;
    }
    if (![500, 502, 503, 504].includes(response.status)) throw new Error(await describeUpstream('YouTube 上传失败', response));
  }
  throw new Error('YouTube 上传在 6 次恢复尝试后仍未完成。');
}

async function deleteYouTube(externalId: string) {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) throw new Error('YOUTUBE_ACCESS_TOKEN 未配置。');
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(externalId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(await describeUpstream('YouTube 下架失败', response));
  return { withdrawn: true, externalId };
}

async function authorizeLegalWithdrawal(job: WorkerJob) {
  if (typeof job.payload.deletionRequestId !== 'string' || typeof job.payload.deletionItemId !== 'string') return;
  const response = await fetch(
    `${controlUrl}/api/v1/worker/legal-deletion-withdrawals/${encodeURIComponent(job.id)}/authorize`,
    {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ workerId, leaseEpoch: job.lease_epoch }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (response.ok) return;
  let payload: { error?: unknown; errorCode?: unknown; retryAfterSeconds?: unknown } = {};
  try { payload = await response.json() as typeof payload; }
  catch { /* Use the bounded fallback below. */ }
  const message = typeof payload.error === 'string'
    ? payload.error.slice(0, 500)
    : `外部撤回执行授权失败：HTTP ${response.status}。`;
  const errorCode = typeof payload.errorCode === 'string' ? payload.errorCode : 'POLICY_DRIFT';
  if (['LEGAL_HOLD_ACTIVE', 'LEASE_LOST', 'POLICY_DRIFT'].includes(errorCode)) {
    throw new RetryableJobError(
      message,
      errorCode,
      Number.isInteger(payload.retryAfterSeconds) ? Number(payload.retryAfterSeconds) : 60,
    );
  }
  throw new TerminalJobError(message, errorCode);
}

async function workPublish(job: WorkerJob) {
  if (!job.project_id || typeof job.payload.publishJobId !== 'string' || typeof job.payload.channel !== 'string') throw new Error('发布作业字段不完整。');
  if (job.payload.operation === 'withdraw') {
    await authorizeLegalWithdrawal(job);
    if (job.payload.channel === 'youtube' && typeof job.payload.externalId === 'string') return deleteYouTube(job.payload.externalId);
    if (job.payload.channel === 'package' && !job.payload.externalId) return { withdrawn: true, externalId: null, localOnly: true };
    throw new TerminalJobError(`渠道 ${job.payload.channel} 没有已验证的外部删除实现。`, 'PERMANENT_UNSUPPORTED');
  }
  if (!job.payload.asset || typeof job.payload.asset !== 'object') throw new Error('发布作业缺少成片资产。');
  const asset = job.payload.asset as { objectKey?: unknown; sha256?: unknown; byteSize?: unknown };
  if (typeof asset.objectKey !== 'string') throw new Error('发布作业缺少成片对象键。');
  const title = typeof job.payload.title === 'string' ? job.payload.title : '';
  const description = typeof job.payload.description === 'string' ? job.payload.description : '';
  const channel = job.payload.channel;
  let completion: { externalId?: string; finalUrl?: string; manifest?: unknown; platformResponse?: unknown };
  if (channel === 'package') {
    completion = { manifest: { schemaVersion: '1.0', projectId: job.project_id, snapshotHash: job.payload.snapshotHash, accountId: job.payload.accountId, title, description, tags: job.payload.tags, cover: job.payload.coverAsset, video: asset, sources: job.payload.sources, createdAt: new Date().toISOString(), mediaEndpoint: `/api/v1/media?objectKey=${encodeURIComponent(asset.objectKey)}` } };
  } else if (channel === 'youtube') {
    await renewLeaseNow(job);
    const media = await downloadMedia(asset.objectKey);
    const coverAsset = job.payload.coverAsset && typeof job.payload.coverAsset === 'object' ? job.payload.coverAsset as { objectKey?: unknown } : null;
    const cover = coverAsset && typeof coverAsset.objectKey === 'string' ? await downloadMedia(coverAsset.objectKey) : null;
    const uploaded = await uploadYouTube({ bytes: media.bytes, contentType: media.contentType, title, description, tags: Array.isArray(job.payload.tags) ? job.payload.tags.filter((tag): tag is string => typeof tag === 'string') : [], privacyStatus: typeof job.payload.privacyStatus === 'string' ? job.payload.privacyStatus : 'private', cover });
    completion = {
      externalId: uploaded.externalId,
      finalUrl: uploaded.finalUrl,
      platformResponse: { privacyStatus: uploaded.privacyStatus, accountId: job.payload.accountId ?? null },
    };
  } else {
    throw new Error(`不支持发布渠道 ${channel}。`);
  }
  return json(await fetch(`${controlUrl}/api/v1/publish-jobs/${encodeURIComponent(job.payload.publishJobId)}/complete`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ jobId: job.id, workerId, leaseEpoch: job.lease_epoch, channel, ...completion }) }));
}

async function workRender(job: WorkerJob) {
  // 延迟加载让 source-only 镜像不需要携带 Chromium/FFmpeg/Remotion 组合代码。
  const { renderProject } = await import('./render.ts');
  if (!job.project_id) throw new Error('渲染作业缺少 project_id。');
  const profile = job.kind === 'preview' ? 'preview' : 'final';
  const projectPayload = await json<{ project: ProjectRecord }>(await fetch(leasedProjectUrl(job), { headers: { 'x-worker-token': requiredWorkerToken } }));
  const renderProjectInput = structuredClone(projectPayload.project.project);
  if (renderProjectInput.audio.objectKey?.startsWith('projects/')) {
    const media = await downloadMedia(renderProjectInput.audio.objectKey);
    renderProjectInput.audio.objectKey = `data:${media.contentType};base64,${Buffer.from(media.bytes).toString('base64')}`;
  }
  if (renderProjectInput.audio.music?.objectKey.startsWith('projects/')) {
    const music = await downloadMedia(renderProjectInput.audio.music.objectKey);
    renderProjectInput.audio.music.objectKey = `data:${music.contentType};base64,${Buffer.from(music.bytes).toString('base64')}`;
  }
  const jobId = assertSafeJobId(job.id);
  // QC 校验的必须是控制面里的原始项目，不是渲染用的改写版：
  // 下面会把 audio.objectKey 换成 data: URI 供 Remotion 加载，那会改变
  // computeRenderSnapshotHash 的输入，拿改写版去校验快照哈希必然失败。
  const canonicalProject = projectPayload.project.project;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'signal40-render-'));
  const videoPath = path.join(directory, `${jobId}.mp4`);
  const coverPath = path.join(directory, `${jobId}-cover.jpg`);
  const projectPath = path.join(directory, `${jobId}.project.json`);
  try {
    await fs.writeFile(projectPath, JSON.stringify(canonicalProject));
    await renderProject(renderProjectInput, videoPath, { profile });
    const qc = profile === 'final' ? await runQc(videoPath, projectPath) : null;
    const bytes = await fs.readFile(videoPath);
    const upload = await json<{ asset: { id: string; objectKey: string; sha256: string } }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/assets`, {
      method: 'POST',
      headers: leasedAssetHeaders(job, { 'content-type': 'video/mp4', 'x-filename': encodeURIComponent(`${jobId}.mp4`), 'x-asset-role': profile === 'preview' ? 'preview-output' : 'render-output', 'x-rights-status': 'cleared', 'x-rights-note': encodeURIComponent(profile === 'preview' ? 'Signal 40 Render Worker 低码率预览资产' : 'Signal 40 Render Worker 正式成片资产') }),
      body: bytes,
    }));
    if (profile === 'preview') return { asset: upload.asset, profile, snapshotHash: renderProjectInput.render.snapshotHash };
    if (qc!.status !== 'passed') {
      // 自动 QC 未通过：先落 QC 报告（G6 依赖它），再让作业以终态失败结束。
      // 不抽封面、不把作业标成功——否则运维和工作台会以为成片可用。
      await json(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/qc-reports`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ renderJobId: job.id, workerId, leaseEpoch: job.lease_epoch, status: qc!.status, checks: qc!.checks }) }));
      const failed = (qc!.checks as Array<{ code?: unknown; passed?: unknown }>).filter((check) => check.passed === false).map((check) => String(check.code)).slice(0, 12);
      throw new TerminalJobError(`自动 QC 未通过：${failed.join('、') || qc!.status}`);
    }
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '2', '-y', coverPath]);
    const coverBytes = await fs.readFile(coverPath);
    const cover = await json<{ asset: { id: string; objectKey: string; sha256: string } }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/assets`, {
      method: 'POST',
      headers: leasedAssetHeaders(job, { 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent(`${jobId}-cover.jpg`), 'x-asset-role': 'render-output', 'x-rights-status': 'cleared', 'x-rights-note': encodeURIComponent('Signal 40 Render Worker 从成片抽取的封面') }),
      body: coverBytes,
    }));
    await json(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/qc-reports`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ renderJobId: job.id, workerId, leaseEpoch: job.lease_epoch, status: qc!.status, checks: qc!.checks }) }));
    return { asset: upload.asset, cover: cover.asset, qc };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function work(job: WorkerJob) {
  if (job.kind === 'ingestion') {
    if (job.payload.operation === 'source_test') return workSourceTest(job);
    if (job.payload.operation === 'topic_recompute') return workTopicRecompute(job);
    return workIngestion(job);
  }
  if (job.kind === 'voice') return workVoice(job);
  if (job.kind === 'preview' || job.kind === 'render') return workRender(job);
  if (job.kind === 'publish') return workPublish(job);
  throw new Error(`Worker 不支持 ${job.kind} 作业。`);
}

async function finish(jobId: string, leaseEpoch: number, payload: Record<string, unknown>) {
  await json(await fetch(`${controlUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/finish`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ ...payload, leaseEpoch }) }));
}

const LEASE_SECONDS = 900;
const HEARTBEAT_INTERVAL_MS = 120_000;

async function renewLeaseNow(job: WorkerJob) {
  await json(await fetch(`${controlUrl}/api/v1/jobs/${encodeURIComponent(job.id)}/heartbeat`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({ workerId, leaseEpoch: job.lease_epoch, leaseSeconds: LEASE_SECONDS }),
  }));
}
/** 这个 Worker 能处理的作业类型；同时用于租约请求和心跳上报。 */
const WORKER_KINDS = workerProfile === 'source'
  ? ['ingestion']
  : workerProfile === 'render'
    ? ['voice', 'preview', 'render', 'publish']
    : ['ingestion', 'voice', 'preview', 'render', 'publish'];
const WORKER_CAPABILITIES = workerProfile === 'render' ? [] : ['source:rss', 'source:http-json', 'source:web', 'source:social', 'source:pipeline'];
const WORKER_CAPABILITY_PROTOCOL_VERSIONS: Record<string, number> =
  workerProfile === 'render'
    ? {}
    : {
        'source:rss': 1,
        'source:http-json': 2,
        'source:web': 1,
        'source:social': 1,
        'source:pipeline': 1,
      };
/** 空闲轮询每 2 秒一次，心跳没必要跟着那么密；控制面按 90 秒判定离线。 */
const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
let lastWorkerHeartbeatAt = 0;

/**
 * 向控制面上报「我在线、我能处理这些类型」。
 *
 * 空闲时也要报：界面正是靠它区分「作业在排队」和「根本没人会执行」，
 * 后者没有这条信息就只能干等。上报失败不影响领取作业，下一轮再报。
 */
async function reportWorkerHeartbeat() {
  if (Date.now() - lastWorkerHeartbeatAt < WORKER_HEARTBEAT_INTERVAL_MS) return;
  lastWorkerHeartbeatAt = Date.now();
  try {
    const response = await fetch(`${controlUrl}/api/v1/workers`, {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ workerId, hostname: os.hostname(), kinds: WORKER_KINDS, capabilities: WORKER_CAPABILITIES, capabilityProtocolVersions: WORKER_CAPABILITY_PROTOCOL_VERSIONS, version: process.env.SIGNAL40_WORKER_VERSION || `node-${process.version}` }),
    });
    if (!response.ok) process.stderr.write(`心跳上报失败 HTTP ${response.status}\n`);
  } catch (error) {
    process.stderr.write(`心跳上报异常：${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * 执行期间周期性续约。渲染可能远超一次租约时长，不续约的话租约到期后
 * 另一个 Worker 会重复领取同一作业，白烧一次渲染并可能产出重复资产。
 */
function startHeartbeat(jobId: string, leaseEpoch: number) {
  const timer = setInterval(() => {
    void fetch(`${controlUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/heartbeat`, {
      method: 'POST',
      headers: workerHeaders,
      body: JSON.stringify({ workerId, leaseEpoch, leaseSeconds: LEASE_SECONDS }),
    }).then((response) => {
      if (!response.ok) process.stderr.write(`${jobId}: 续约失败 HTTP ${response.status}\n`);
    }).catch((error: unknown) => {
      process.stderr.write(`${jobId}: 续约请求异常 ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function main() {
  process.stdout.write(`Signal 40 ${workerProfile} Worker ${workerId} connected to ${controlUrl}\n`);
  await reportWorkerHeartbeat();
  // 注册心跳与作业租约心跳相互独立；长渲染期间也必须保持“在线”，否则控制台会误报孤儿作业。
  const workerHeartbeat = setInterval(() => { void reportWorkerHeartbeat(); }, WORKER_HEARTBEAT_INTERVAL_MS);
  workerHeartbeat.unref?.();
  for (;;) {
    const response = await fetch(`${controlUrl}/api/v1/jobs/lease`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ workerId, kinds: WORKER_KINDS, capabilities: WORKER_CAPABILITIES, capabilityProtocolVersions: WORKER_CAPABILITY_PROTOCOL_VERSIONS, maxPayloadSchemaVersion: 2, leaseSeconds: LEASE_SECONDS }) });
    if (response.status === 204) { await new Promise((resolve) => setTimeout(resolve, 2000)); continue; }
    const { job } = await json<{ job: WorkerJob }>(response);
    const stopHeartbeat = startHeartbeat(job.id, job.lease_epoch);
    try {
      const startedAt = Date.now();
      const result = await work(job);
      const measuredResult = result && typeof result === 'object' ? { ...result, durationMs: Date.now() - startedAt } : { value: result, durationMs: Date.now() - startedAt };
      stopHeartbeat();
      await finish(job.id, job.lease_epoch, { workerId, succeeded: true, result: measuredResult });
    } catch (error) {
      stopHeartbeat();
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${job.id}: ${message}\n`);
      try {
        await finish(job.id, job.lease_epoch, {
          workerId,
          succeeded: false,
          error: message,
          errorCode: error instanceof TerminalJobError || error instanceof RetryableJobError ? error.errorCode : 'NETWORK',
          retryDelaySeconds: error instanceof RetryableJobError ? error.retryDelaySeconds : undefined,
          terminal: error instanceof TerminalJobError,
        });
      } catch (finishError) {
        // Kill switch、legal hold 或 lease takeover 会主动 fence 旧执行。
        // 这时完成写回被 409 拒绝是预期行为，Worker 必须继续服务下一项而不是退出。
        process.stderr.write(`${job.id}: 完成写回被拒绝 ${finishError instanceof Error ? finishError.message : String(finishError)}\n`);
      }
    }
  }
}

await main();
