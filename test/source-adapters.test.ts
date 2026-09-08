import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPublicHttpUrl, mapHttpJson, parseRssFeed, validateSourceConfig } from '../lib/source-adapters.ts';

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

void test('source adapters reject SSRF targets and unapproved rights', () => {
  assert.throws(() => assertPublicHttpUrl('http://127.0.0.1/admin'), /私有网络/);
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /HTTP/);
  const result = validateSourceConfig({ name: '未授权源', adapter: 'rss', sourceType: 'media', url: 'https://example.com/rss', rightsStatus: 'restricted' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('rightsStatus')));
  assert.equal(validateSourceConfig({ name: '暂停来源', adapter: 'rss', sourceType: 'media', url: 'https://example.com/rss', rightsStatus: 'restricted' }, false).valid, true);
});
