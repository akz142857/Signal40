import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceHttpJsonPagination,
  buildHttpJsonPageUrl,
  filterIncrementalArticles,
  filterPagedIncrementalArticles,
  initialHttpJsonPageState,
  normalizeHttpJsonPagination,
  paginationHasMore,
  paginationNextCursor,
  parseRetryAfterSeconds,
} from '../lib/source-pagination.ts';
import { validateSourceConfig } from '../lib/source-adapters.ts';

const article = (id: string, publishedAt: string) => ({
  id,
  source: 'API',
  sourceType: 'media' as const,
  title: `Story ${id}`,
  url: `https://example.com/${id}`,
  publishedAt,
});

void test('HTTP JSON pagination builds bounded page, cursor, and since requests', () => {
  const page = normalizeHttpJsonPagination({ mode: 'page', pageParameter: 'p', startPage: 0, pageSizeParameter: 'count', pageSize: 25, maxPages: 4 });
  assert.equal(buildHttpJsonPageUrl('https://api.example.com/news?lang=zh', page, {}, { pageNumber: 2, cursor: null }), 'https://api.example.com/news?lang=zh&p=2&count=25');

  const cursor = normalizeHttpJsonPagination({ mode: 'cursor', cursorPath: 'meta.next', cursorParameter: 'after', pageSize: 50 });
  const cursorState = initialHttpJsonPageState(cursor, { cursor: 'opaque/token' });
  assert.equal(buildHttpJsonPageUrl('https://api.example.com/news', cursor, {}, cursorState), 'https://api.example.com/news?after=opaque%2Ftoken&limit=50');

  const since = normalizeHttpJsonPagination({ mode: 'since', sinceParameter: 'updated_after', pageSize: 10 });
  assert.match(buildHttpJsonPageUrl('https://api.example.com/news', since, { watermark: '2026-09-08T01:00:00.000Z' }, { pageNumber: 1, cursor: null }), /updated_after=2026-09-08T01%3A00%3A00.000Z/);
});

void test('HTTP JSON pagination reads cursor and hasMore without accepting structured values', () => {
  const payload = { meta: { next: 42, hasMore: 'false' } };
  assert.equal(paginationNextCursor(payload, 'meta.next'), '42');
  assert.equal(paginationHasMore(payload, 'meta.hasMore'), false);
  assert.throws(() => paginationNextCursor({ meta: { next: {} } }, 'meta.next'), /字符串或数字/);
});

void test('pagination advances pages and rejects a repeated opaque cursor', () => {
  const page = normalizeHttpJsonPagination({ mode: 'page', pageSize: 2 });
  const pageAdvance = advanceHttpJsonPagination({
    pagination: page, payload: {}, state: { pageNumber: 1, cursor: null }, fetchedCount: 2, seenCursors: new Set(),
  });
  assert.equal(pageAdvance.shouldContinue, true);
  assert.equal(pageAdvance.state.pageNumber, 2);
  assert.equal(initialHttpJsonPageState(page, { pageNumber: 7 }).pageNumber, 7);

  const cursor = normalizeHttpJsonPagination({ mode: 'cursor', cursorPath: 'meta.next' });
  const seenCursors = new Set(['cursor-a']);
  assert.throws(() => advanceHttpJsonPagination({
    pagination: cursor,
    payload: { meta: { next: 'cursor-a' } },
    state: { pageNumber: 1, cursor: 'cursor-a' },
    fetchedCount: 1,
    seenCursors,
  }), /重复 cursor/);
  const completed = advanceHttpJsonPagination({
    pagination: cursor,
    payload: { meta: { next: null } },
    state: { pageNumber: 1, cursor: 'cursor-a' },
    fetchedCount: 1,
    seenCursors: new Set(['cursor-a']),
  });
  assert.equal(completed.shouldContinue, false);
  assert.equal(completed.cursor, null);
});

void test('incremental watermark keeps same-timestamp identities and admits late ties once', () => {
  const checkpoint = { watermark: '2026-09-08T01:00:00.000Z', tieBreakerIds: ['old-a'] };
  const result = filterIncrementalArticles([
    article('older', '2026-09-08T00:59:00.000Z'),
    article('old-a', '2026-09-08T01:00:00.000Z'),
    article('late-b', '2026-09-08T01:00:00.000Z'),
    article('new-c', '2026-09-08T02:00:00.000Z'),
    article('new-d', '2026-09-08T02:00:00.000Z'),
  ], checkpoint);
  assert.deepEqual(result.articles.map((item) => item.id), ['late-b', 'new-c', 'new-d']);
  assert.equal(result.watermark, '2026-09-08T02:00:00.000Z');
  assert.deepEqual(result.tieBreakerIds, ['new-c', 'new-d']);

  const tieOnly = filterIncrementalArticles([article('late-b', '2026-09-08T01:00:00.000Z')], checkpoint);
  assert.deepEqual(tieOnly.tieBreakerIds, ['late-b', 'old-a']);
});

void test('descending later pages compare admission to the run boundary without moving checkpoint backwards', () => {
  const secondPage = [
    article('middle-b', '2026-09-08T02:00:00.000Z'),
    article('old-a', '2026-09-08T01:00:00.000Z'),
  ];
  const result = filterPagedIncrementalArticles(
    secondPage,
    { watermark: '2026-09-08T01:00:00.000Z', tieBreakerIds: ['old-a'] },
    { watermark: '2026-09-08T03:00:00.000Z', tieBreakerIds: ['newest-c'] },
  );
  assert.deepEqual(result.articles.map((item) => item.id), ['middle-b']);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.watermark, '2026-09-08T03:00:00.000Z');
  assert.deepEqual(result.tieBreakerIds, ['newest-c']);
});

void test('Retry-After supports seconds and HTTP dates with a one-day cap', () => {
  const now = Date.parse('2026-09-08T01:00:00.000Z');
  assert.equal(parseRetryAfterSeconds('45', now), 45);
  assert.equal(parseRetryAfterSeconds('Tue, 08 Sep 2026 01:02:00 GMT', now), 120);
  assert.equal(parseRetryAfterSeconds('999999', now), 86_400);
  assert.equal(parseRetryAfterSeconds('invalid', now), null);
});

void test('source config rejects unsafe or incomplete pagination contracts', () => {
  const base = { name: 'API', adapter: 'http' as const, sourceType: 'media' as const, url: 'https://api.example.com/news', rightsStatus: 'approved' as const };
  assert.equal(validateSourceConfig({ ...base, pagination: { mode: 'cursor', cursorPath: 'meta.next', maxPages: 10 } }).valid, true);
  assert.equal(validateSourceConfig({ ...base, pagination: { mode: 'cursor' } }).valid, false);
  assert.equal(validateSourceConfig({ ...base, pagination: { mode: 'page', pageParameter: 'bad parameter' } }).valid, false);
  assert.equal(validateSourceConfig({ ...base, pagination: { mode: 'page', maxPages: 21 } }).valid, false);
});
