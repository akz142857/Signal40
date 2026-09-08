import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeArticles,
  runPipeline,
  type ArticleInput,
} from '../lib/domain.ts';
import { sampleArticles } from '../lib/sample-data.ts';
import { createVideoProject } from '../lib/video-project.ts';
import { parseArticleImport } from '../lib/import.ts';

const now = new Date('2026-09-08T02:00:00.000Z');

void test('normalization removes exact URL and title duplicates', () => {
  const input = sampleArticles(now)[0];
  assert.equal(normalizeArticles([input, { ...input }]).length, 1);
});

void test('multi-source DRAM reports become one candidate', () => {
  const topics = runPipeline(sampleArticles(now), now);
  const dram = topics.find((topic) => topic.keywords.includes('dram'));
  assert.ok(dram);
  assert.ok(dram.sourceCount >= 3);
  assert.equal(dram.gate.passed, true);
  assert.equal(
    dram.articles.some((article) => article.title.includes('84.84%')),
    false,
  );
});

void test('the repeated 84.84% figure forms a separate evidence cluster', () => {
  const topics = runPipeline(sampleArticles(now), now);
  const margin = topics.find((topic) => topic.title.includes('84.84%'));
  assert.ok(margin);
  assert.equal(margin.sourceCount, 2);
  assert.equal(margin.gate.passed, true);
});

void test('adding an independent source increases resonance', () => {
  const inputs = sampleArticles(now).filter(
    (article) =>
      article.title.toLowerCase().includes('dram') ||
      article.summary?.toLowerCase().includes('dram'),
  );
  const twoSources = runPipeline(inputs.slice(0, 2), now)[0];
  const fourSources = runPipeline(inputs, now)[0];
  assert.ok(
    fourSources.scoreBreakdown.resonance > twoSources.scoreBreakdown.resonance,
  );
});

void test('a social-only candidate cannot enter video production', () => {
  const input: ArticleInput[] = [
    {
      source: '单一财经号',
      sourceType: 'social',
      title: '某概念突然升温 30%',
      summary: '未经原始来源核验。',
      url: 'https://example.com/social-only',
      publishedAt: now.toISOString(),
    },
  ];
  const topic = runPipeline(input, now)[0];
  assert.equal(topic.gate.passed, false);
  assert.throws(
    () => createVideoProject(topic),
    /has not passed the evidence gate/,
  );
});

void test('automatic evidence is insufficient without editorial approval', () => {
  const topic = runPipeline(sampleArticles(now), now).find(
    (candidate) => candidate.gate.passed,
  );
  assert.ok(topic);
  assert.throws(
    () => createVideoProject(topic),
    /has not been approved by an editor/,
  );
});

void test('verified candidate produces a 45-second vertical video contract', () => {
  const topic = runPipeline(sampleArticles(now), now).find(
    (candidate) => candidate.gate.passed,
  );
  assert.ok(topic);
  const project = createVideoProject({
    ...topic,
    verificationStatus: 'verified',
  });
  assert.equal(project.render.durationSeconds, 45);
  assert.equal(project.render.width, 1080);
  assert.equal(project.render.height, 1920);
  assert.ok(project.sources.length >= 2);
});

void test('JSON and quoted CSV imports use the same article contract', () => {
  const article = sampleArticles(now)[0];
  assert.equal(
    parseArticleImport(JSON.stringify({ articles: [article] }), now).length,
    1,
  );
  const csv = `source,sourceType,title,url,publishedAt,summary\n"财经,来源",media,"标题,含逗号",https://example.com/csv,2026-09-08T01:00:00Z,摘要`;
  const parsed = parseArticleImport(csv, now);
  assert.equal(parsed[0].source, '财经,来源');
  assert.equal(parsed[0].title, '标题,含逗号');
});

void test('imports reject unsafe URLs and future timestamps', () => {
  const article = sampleArticles(now)[0];
  assert.throws(
    () =>
      parseArticleImport(
        JSON.stringify([{ ...article, url: 'javascript:alert(1)' }]),
        now,
      ),
    /HTTP/,
  );
  assert.throws(
    () =>
      parseArticleImport(
        JSON.stringify([{ ...article, publishedAt: '2026-09-09T02:00:00Z' }]),
        now,
      ),
    /不能晚于/,
  );
});

void test('imports accept up to 100 records and reject larger batches', () => {
  const article = sampleArticles(now)[0];
  const records = Array.from({ length: 100 }, (_, index) => ({
    ...article,
    title: `${article.title} ${index}`,
    url: `https://example.com/batch/${index}`,
  }));
  assert.equal(parseArticleImport(JSON.stringify(records), now).length, 100);
  assert.throws(
    () =>
      parseArticleImport(
        JSON.stringify([
          ...records,
          { ...records[0], url: 'https://example.com/batch/100' },
        ]),
        now,
      ),
    /最多导入 100/,
  );
});
