import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeArticles, runPipeline, type ArticleInput } from '../lib/domain.ts';
import { sampleArticles } from '../lib/sample-data.ts';
import { createVideoProject } from '../lib/video-project.ts';

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
  assert.equal(dram.articles.some((article) => article.title.includes('84.84%')), false);
});

void test('the repeated 84.84% figure forms a separate evidence cluster', () => {
  const topics = runPipeline(sampleArticles(now), now);
  const margin = topics.find((topic) => topic.title.includes('84.84%'));
  assert.ok(margin);
  assert.equal(margin.sourceCount, 2);
  assert.equal(margin.gate.passed, true);
});

void test('adding an independent source increases resonance', () => {
  const inputs = sampleArticles(now).filter((article) => article.title.toLowerCase().includes('dram') || article.summary?.toLowerCase().includes('dram'));
  const twoSources = runPipeline(inputs.slice(0, 2), now)[0];
  const fourSources = runPipeline(inputs, now)[0];
  assert.ok(fourSources.scoreBreakdown.resonance > twoSources.scoreBreakdown.resonance);
});

void test('a social-only candidate cannot enter video production', () => {
  const input: ArticleInput[] = [{
    source: '单一财经号', sourceType: 'social', title: '某概念突然升温 30%', summary: '未经原始来源核验。',
    url: 'https://example.com/social-only', publishedAt: now.toISOString(),
  }];
  const topic = runPipeline(input, now)[0];
  assert.equal(topic.gate.passed, false);
  assert.throws(() => createVideoProject(topic), /has not passed the evidence gate/);
});

void test('verified candidate produces a 45-second vertical video contract', () => {
  const topic = runPipeline(sampleArticles(now), now).find((candidate) => candidate.gate.passed);
  assert.ok(topic);
  const project = createVideoProject(topic);
  assert.equal(project.render.durationSeconds, 45);
  assert.equal(project.render.width, 1080);
  assert.equal(project.render.height, 1920);
  assert.ok(project.sources.length >= 2);
});
