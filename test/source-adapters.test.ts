import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicHttpUrl, mapHttpJson, mapHttpJsonPage, parseRssFeed, validateSourceConfig } from '../lib/source-adapters.ts';

void test('RSS adapter reads RSS and Atom records into one article contract', () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[铜价上涨 5%]]></title><link>https://example.com/copper</link><description>库存下降</description><pubDate>Tue, 08 Sep 2026 01:00:00 GMT</pubDate></item></channel></rss>`;
  const articles = parseRssFeed(rss, { name: '测试 RSS', sourceType: 'market' });
  assert.equal(articles.length, 1);
  assert.equal(articles[0].title, '铜价上涨 5%');
  assert.equal(articles[0].publishedAt, '2026-09-08T01:00:00.000Z');
});

void test('HTTP JSON adapter supports explicit field mappings', () => {
  const articles = mapHttpJson({ data: [{ headline: '财报发布', href: 'https://example.com/filing', time: '2026-09-08T01:00:00Z' }] }, { name: '公告', adapter: 'http', sourceType: 'filing', url: 'https://example.com/api', rightsStatus: 'approved', mapping: { items: 'data', title: 'headline', url: 'href', publishedAt: 'time' } });
  assert.equal(articles[0].title, '财报发布');
});

void test('Atom adapter supports namespaces, xml:base, alternate links, and named authors', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://example.com/news/"><entry><id>story-1</id><title>Quarterly results</title><link rel="self" href="feed-entry.xml"/><link rel="alternate" href="results"/><updated>2026-09-08T01:00:00Z</updated><author><name>Alice</name></author><summary>Revenue increased</summary></entry></feed>`;
  const articles = parseRssFeed(atom, { name: 'Investor news', sourceType: 'company' });
  assert.equal(articles.length, 1);
  assert.equal(articles[0].id, 'story-1');
  assert.equal(articles[0].url, 'https://example.com/news/results');
  assert.equal(articles[0].author, 'Alice');
});

void test('RSS adapter rejects malformed XML and DOCTYPE declarations', () => {
  assert.throws(
    () => parseRssFeed('<rss><channel><item></channel></rss>', { name: 'Broken', sourceType: 'media' }),
    /XML 格式无效/,
  );
  assert.throws(
    () => parseRssFeed('<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss/>', { name: 'Unsafe', sourceType: 'media' }),
    /DOCTYPE/,
  );
});

void test('HTTP JSON adapter isolates invalid items without exposing raw payloads', () => {
  const page = mapHttpJsonPage({ items: [
    { id: 'ok-1', title: 'Valid', url: 'https://example.com/valid', publishedAt: '2026-09-08T01:00:00Z' },
    { id: 'bad-1', title: 'Invalid', url: 'https://example.com/invalid', publishedAt: 'secret-value-not-a-date', secret: 'must-not-leak' },
  ] }, { name: 'API', adapter: 'http', sourceType: 'media', url: 'https://example.com/api', rightsStatus: 'approved' });
  assert.equal(page.articles.length, 1);
  assert.equal(page.rejections.length, 1);
  assert.equal(page.rejections[0].platformItemId, 'bad-1');
  assert.equal(page.rejections[0].payloadHash.length, 64);
  assert.doesNotMatch(page.rejections[0].detailRedacted, /secret-value|must-not-leak/);
});

void test('HTTP JSON adapter emits a strict tombstone without fabricated article fields', () => {
  const page = mapHttpJsonPage({ items: [{
    id: 'deleted-1',
    operation: 'tombstone',
    removedAt: '2026-09-08T02:00:00Z',
    title: 'must not be consumed',
    url: 'https://example.com/must-not-be-consumed',
  }] }, {
    name: 'API',
    adapter: 'http',
    namespace: 'http_json',
    connectorId: 'http-json-v2',
    connectorVersion: '2',
    sourceType: 'media',
    url: 'https://example.com/api',
    rightsStatus: 'approved',
    mapping: { kind: 'operation', deletedAt: 'removedAt' },
  });
  assert.equal(page.articles.length, 0);
  assert.equal(page.rejections.length, 0);
  assert.deepEqual(page.items[0], {
    kind: 'tombstone',
    namespace: 'http_json',
    platformItemId: 'deleted-1',
    deletedAt: '2026-09-08T02:00:00.000Z',
    provenance: {
      connectorId: 'http-json-v2',
      connectorVersion: '2',
      observedAt: '2026-09-08T02:00:00.000Z',
    },
    identityStrategy: 'platform_id',
    identityConfidence: 'high',
  });
});

void test('HTTP JSON adapter rejects an oversized page instead of silently dropping tail items', () => {
  const items = Array.from({ length: 101 }, (_, index) => ({ id: String(index), title: `Item ${index}`, url: `https://example.com/${index}`, publishedAt: '2026-09-08T01:00:00Z' }));
  assert.throws(
    () => mapHttpJsonPage({ items }, { name: 'API', adapter: 'http', sourceType: 'media', url: 'https://example.com/api', rightsStatus: 'approved' }),
    /单页不能超过 100 条/,
  );
});

void test('source adapters reject SSRF targets and unapproved rights', () => {
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1/admin'), /私有网络/);
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /HTTP/);
  assert.throws(() => assertPublicHttpUrl('https://example.com:8443/feed'), /标准 HTTP/);
  assert.throws(() => assertPublicHttpUrl('https://user:password@example.com/feed'), /用户凭据/);
  assert.throws(() => assertPublicHttpUrl('https://example.com/feed#access_token=secret'), /fragment/);
  assert.throws(() => assertPublicHttpUrl('https://example.com/feed?api_key=secret'), /敏感 query/);
  assert.throws(() => assertPublicHttpUrl('https://example.com/feed?X-Amz-Signature=secret'), /敏感 query/);
  assert.equal(assertPublicHttpUrl('https://example.com/feed?format=json'), 'https://example.com/feed?format=json');
  const result = validateSourceConfig({ name: '未授权源', adapter: 'rss', sourceType: 'media', url: 'https://example.com/rss', rightsStatus: 'pending' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('rightsStatus')));
  assert.equal(validateSourceConfig({ name: '暂停来源', adapter: 'rss', sourceType: 'media', url: 'https://example.com/rss', rightsStatus: 'pending' }, false).valid, true);
});
