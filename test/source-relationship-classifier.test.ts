import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOriginRelationship } from '../lib/source-relationship-classifier.ts';

const article = {
  url: 'https://news.example.com/a',
  title: '公司公告',
  summary: '完整内容',
  author: '编辑部',
};

void test('relationship classifier only marks an explicitly registered publisher host original', () => {
  assert.deepEqual(classifyOriginRelationship(article, { website: 'https://news.example.com' }), {
    relationship: 'original', confidence: 95, reason: 'publisher-host-match',
  });
  assert.equal(classifyOriginRelationship(article, {}).relationship, 'unknown');
});

void test('repost and syndication markers take precedence over publisher host', () => {
  assert.equal(classifyOriginRelationship({ ...article, summary: '转载自其他媒体' }, { website: 'news.example.com' }).relationship, 'repost');
  assert.equal(classifyOriginRelationship({ ...article, summary: '经授权转载' }, { website: 'news.example.com' }).relationship, 'syndicated');
});
