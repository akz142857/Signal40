import type { ArticleInput } from './domain.ts';
import { assertPublicHttpUrl, readJsonPath, type HttpJsonPaginationConfig } from './source-adapters.ts';
import { sourceItemEventAt, type NormalizedSourceItem } from './source-normalized-item.ts';

export type HttpJsonCheckpoint = {
  schemaVersion?: unknown;
  watermark?: unknown;
  tieBreakerIds?: unknown;
  cursor?: unknown;
  pageNumber?: unknown;
};

export type HttpJsonPageState = {
  pageNumber: number;
  cursor: string | null;
};

export class SourcePaginationError extends Error {
  readonly code: 'CURSOR_LOOP' | 'SCHEMA_CHANGED';
  constructor(message: string, code: 'CURSOR_LOOP' | 'SCHEMA_CHANGED') {
    super(message);
    this.code = code;
  }
}

export function normalizeHttpJsonPagination(input?: HttpJsonPaginationConfig): Required<Pick<HttpJsonPaginationConfig, 'mode' | 'maxPages' | 'pageParameter' | 'startPage' | 'pageSizeParameter' | 'pageSize' | 'cursorParameter' | 'sinceParameter'>> & Pick<HttpJsonPaginationConfig, 'cursorPath' | 'hasMorePath'> {
  return {
    mode: input?.mode ?? 'none',
    maxPages: input?.maxPages ?? 10,
    pageParameter: input?.pageParameter ?? 'page',
    startPage: input?.startPage ?? 1,
    pageSizeParameter: input?.pageSizeParameter ?? 'limit',
    pageSize: input?.pageSize ?? 100,
    cursorParameter: input?.cursorParameter ?? 'cursor',
    cursorPath: input?.cursorPath,
    sinceParameter: input?.sinceParameter ?? 'since',
    hasMorePath: input?.hasMorePath,
  };
}

export function initialHttpJsonPageState(pagination: ReturnType<typeof normalizeHttpJsonPagination>, checkpoint: HttpJsonCheckpoint): HttpJsonPageState {
  return {
    pageNumber: pagination.mode === 'page' && Number.isInteger(checkpoint.pageNumber)
      ? Math.max(pagination.startPage, Number(checkpoint.pageNumber))
      : pagination.startPage,
    cursor: pagination.mode === 'cursor' && typeof checkpoint.cursor === 'string' && checkpoint.cursor
      ? checkpoint.cursor
      : null,
  };
}

export function buildHttpJsonPageUrl(
  baseUrl: string,
  pagination: ReturnType<typeof normalizeHttpJsonPagination>,
  checkpoint: HttpJsonCheckpoint,
  state: HttpJsonPageState,
) {
  const url = new URL(assertPublicHttpUrl(baseUrl));
  if (pagination.mode === 'page') url.searchParams.set(pagination.pageParameter, String(state.pageNumber));
  if ((pagination.mode === 'cursor' || pagination.mode === 'since') && state.cursor) {
    url.searchParams.set(pagination.cursorParameter, state.cursor);
  }
  if (pagination.mode === 'since' && typeof checkpoint.watermark === 'string' && checkpoint.watermark) {
    url.searchParams.set(pagination.sinceParameter, checkpoint.watermark);
  }
  if (pagination.mode !== 'none') url.searchParams.set(pagination.pageSizeParameter, String(pagination.pageSize));
  return assertPublicHttpUrl(url.toString());
}

export function paginationHasMore(payload: unknown, path?: string) {
  if (!path) return null;
  const value = readJsonPath(payload, path);
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false' || value === null) return false;
  throw new Error(`分页字段 ${path} 必须是布尔值。`);
}

export function paginationNextCursor(payload: unknown, path?: string) {
  if (!path) return null;
  const value = readJsonPath(payload, path);
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`游标字段 ${path} 必须是字符串或数字。`);
  return String(value);
}

export function advanceHttpJsonPagination(input: {
  pagination: ReturnType<typeof normalizeHttpJsonPagination>;
  payload: unknown;
  state: HttpJsonPageState;
  fetchedCount: number;
  seenCursors: Set<string>;
}) {
  const { pagination, payload, state, fetchedCount, seenCursors } = input;
  let hasMore: boolean | null;
  try { hasMore = paginationHasMore(payload, pagination.hasMorePath); }
  catch (error) { throw new SourcePaginationError(error instanceof Error ? error.message : '分页 hasMore 字段无效。', 'SCHEMA_CHANGED'); }
  if (pagination.mode === 'page') {
    const shouldContinue = fetchedCount > 0 && (hasMore ?? fetchedCount >= pagination.pageSize);
    return {
      shouldContinue,
      state: shouldContinue ? { ...state, pageNumber: state.pageNumber + 1 } : state,
      cursor: state.cursor,
    };
  }
  if (pagination.mode === 'cursor' || (pagination.mode === 'since' && pagination.cursorPath)) {
    let nextCursor: string | null;
    try { nextCursor = paginationNextCursor(payload, pagination.cursorPath); }
    catch (error) { throw new SourcePaginationError(error instanceof Error ? error.message : '分页 cursor 字段无效。', 'SCHEMA_CHANGED'); }
    const shouldContinue = hasMore !== false && nextCursor !== null;
    if (!shouldContinue || !nextCursor) return {
      shouldContinue: false,
      state: { ...state, cursor: null },
      cursor: null,
    };
    if (seenCursors.has(nextCursor)) throw new SourcePaginationError('HTTP JSON 上游返回重复 cursor，已停止以防无限循环。', 'CURSOR_LOOP');
    seenCursors.add(nextCursor);
    return { shouldContinue: true, state: { ...state, cursor: nextCursor }, cursor: nextCursor };
  }
  return { shouldContinue: false, state, cursor: state.cursor };
}

export function parseRetryAfterSeconds(value: string | null, now = Date.now()) {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.min(86_400, Math.ceil(numeric));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(86_400, Math.max(0, Math.ceil((timestamp - now) / 1000)));
}

function articleIdentity(article: ArticleInput) {
  return article.id?.trim() || article.url;
}

function sourceItemIdentity(item: NormalizedSourceItem) {
  return `${item.namespace}:${item.platformItemId}`;
}

export function filterIncrementalSourceItems(items: NormalizedSourceItem[], checkpoint: HttpJsonCheckpoint) {
  const previousWatermark = typeof checkpoint.watermark === 'string' && Number.isFinite(new Date(checkpoint.watermark).valueOf())
    ? new Date(checkpoint.watermark).toISOString()
    : null;
  const previousIds = new Set(Array.isArray(checkpoint.tieBreakerIds)
    ? checkpoint.tieBreakerIds.filter((value): value is string => typeof value === 'string')
    : []);
  const accepted = items.filter((item) => {
    const eventAt = sourceItemEventAt(item);
    if (!previousWatermark) return true;
    if (eventAt > previousWatermark) return true;
    return eventAt === previousWatermark && !previousIds.has(sourceItemIdentity(item));
  });
  const newest = [previousWatermark, ...accepted.map(sourceItemEventAt)]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const tieBreakerIds = newest
    ? Array.from(new Set([
        ...(newest === previousWatermark ? previousIds : []),
        ...accepted.filter((item) => sourceItemEventAt(item) === newest).map(sourceItemIdentity),
      ])).sort()
    : [];
  return { items: accepted, watermark: newest, tieBreakerIds };
}

export function filterPagedIncrementalSourceItems(
  items: NormalizedSourceItem[],
  runBoundary: HttpJsonCheckpoint,
  currentCheckpoint: HttpJsonCheckpoint,
) {
  const admitted = filterIncrementalSourceItems(items, runBoundary);
  const checkpoint = filterIncrementalSourceItems(admitted.items, currentCheckpoint);
  return {
    items: admitted.items,
    skippedCount: items.length - admitted.items.length,
    watermark: checkpoint.watermark,
    tieBreakerIds: checkpoint.tieBreakerIds,
  };
}

/**
 * 以发布时间水位 + 同时间戳条目身份组成稳定增量边界。这样新补发条目即使
 * 与上次最后一条拥有相同 publishedAt，也不会因为只比较时间而永久漏采。
 */
export function filterIncrementalArticles(articles: ArticleInput[], checkpoint: HttpJsonCheckpoint) {
  const previousWatermark = typeof checkpoint.watermark === 'string' && Number.isFinite(new Date(checkpoint.watermark).valueOf())
    ? new Date(checkpoint.watermark).toISOString()
    : null;
  const previousIds = new Set(Array.isArray(checkpoint.tieBreakerIds)
    ? checkpoint.tieBreakerIds.filter((value): value is string => typeof value === 'string')
    : []);
  const accepted = articles.filter((article) => {
    if (!previousWatermark) return true;
    if (article.publishedAt > previousWatermark) return true;
    return article.publishedAt === previousWatermark && !previousIds.has(articleIdentity(article));
  });
  const newest = [previousWatermark, ...accepted.map((article) => article.publishedAt)]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const tieBreakerIds = newest
    ? Array.from(new Set([
        ...(newest === previousWatermark ? previousIds : []),
        ...accepted.filter((article) => article.publishedAt === newest).map(articleIdentity),
      ])).sort()
    : [];
  return { articles: accepted, watermark: newest, tieBreakerIds };
}

/**
 * 多页 API 常按时间倒序：接纳判断必须对比本轮最初水位，而 checkpoint 汇总
 * 必须对比已经提交的最新水位。把两者混用会静默丢掉第二页及后续页的合法条目。
 */
export function filterPagedIncrementalArticles(
  articles: ArticleInput[],
  runBoundary: HttpJsonCheckpoint,
  currentCheckpoint: HttpJsonCheckpoint,
) {
  const admitted = filterIncrementalArticles(articles, runBoundary);
  const checkpoint = filterIncrementalArticles(admitted.articles, currentCheckpoint);
  return {
    articles: admitted.articles,
    skippedCount: articles.length - admitted.articles.length,
    watermark: checkpoint.watermark,
    tieBreakerIds: checkpoint.tieBreakerIds,
  };
}
