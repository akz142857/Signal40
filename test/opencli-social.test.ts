import assert from 'node:assert/strict';
import test from 'node:test';
import { openCliSocialArgs, parseOpenCliSocialSearch } from '../lib/opencli-social.ts';
import { sourceConnectorByPlatform } from '../lib/source-connectors/registry.ts';

void test('OpenCLI WeChat search results map to validated articles', () => {
  const articles = parseOpenCliSocialSearch({ data: [{
    title: 'Semantica：开源知识图谱框架',
    url: 'https://mp.weixin.qq.com/s/example',
    summary: '文章摘要',
    author: '聚大模型前言',
    publish_time: '2小时前',
  }] }, {
    platform: 'wechat', name: '聚大模型前言', sourceType: 'social', accountName: '聚大模型前言',
  }, '2026-09-09T10:00:00.000Z');
  assert.equal(articles.length, 1);
  assert.equal(articles[0].author, '聚大模型前言');
  assert.equal(articles[0].publishedAt, '2026-09-09T08:00:00.000Z');
  assert.equal(articles[0].url, 'https://mp.weixin.qq.com/s/example');
});

void test('OpenCLI Xiaohongshu nested notes derive canonical public URLs and deduplicate', () => {
  const row = { id: 'note-1', note_card: { display_title: '新品观察', desc: '描述', user: { nickname: '品牌号' } }, create_time: 1788948000 };
  const articles = parseOpenCliSocialSearch({ data: { items: [row, row] } }, {
    platform: 'xiaohongshu', name: '品牌号', sourceType: 'social', accountName: '品牌号',
  });
  assert.equal(articles.length, 1);
  assert.equal(articles[0].url, 'https://www.xiaohongshu.com/explore/note-1');
  assert.equal(articles[0].author, '品牌号');
});

void test('OpenCLI search never fabricates a publisher from the query', () => {
  const [article] = parseOpenCliSocialSearch([{ title: '候选文章', url: 'https://mp.weixin.qq.com/s/candidate' }], {
    platform: 'wechat', name: '目标公众号', sourceType: 'social', accountName: '目标公众号',
  }, '2026-09-09T10:00:00.000Z');
  assert.equal(article.author, '');
});

void test('OpenCLI command arguments do not invoke a shell', () => {
  assert.deepEqual(openCliSocialArgs('wechat', '账号; touch /tmp/nope', 20), [
    'weixin', 'search', '账号; touch /tmp/nope', '--limit', '20', '--format', 'json',
  ]);
});

void test('social connector releases route both discovery modes to the social worker', () => {
  for (const platform of ['wechat', 'xiaohongshu']) {
    const connector = sourceConnectorByPlatform(platform);
    assert.equal(connector?.adapter, 'social');
    assert.equal(connector?.requiredCapability, 'source:social');
    assert.equal(connector?.supports.backfill, false);
  }
});
