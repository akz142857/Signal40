import assert from 'node:assert/strict';
import test from 'node:test';
import {
  halfLifeScore,
  saturatingScore,
  scoreBreakdownFromFeatures,
  SCORE_WEIGHTS,
  SCORING_PARAMETERS,
  SCORING_VERSION,
  weightedScore,
  baselineScore,
  type ScoreFeatures,
} from '../lib/topic-scoring.ts';
import {
  EMBEDDING_CLUSTER_THRESHOLD,
  MINIMUM_INDEPENDENT_EVIDENCE,
  runPipeline,
} from '../lib/domain.ts';
import { DEFAULT_RELEVANCE_THRESHOLD } from '../lib/topic-domains.ts';
import { sampleArticles } from './fixtures/sample-articles.ts';

const baseFeatures: ScoreFeatures = {
  independentSourceCount: 0,
  recentArticleCount: 0,
  numericMentionCount: 0,
  sourceQualityAverage: 0,
  freshestAgeHours: 0,
  domainRelevance: 0,
};

void test('权重之和是 1，否则综合分的量纲就不是 0–100', () => {
  const total = Object.values(SCORE_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `权重之和 ${total}`);
});

void test('可解释性的零点是实测基线，完全跑题拿 0 分而不是四十多分', () => {
  // 余弦没有真零点：无关文本的余弦中位数在本项目语料上就有 0.228。
  // 用 saturatingScore 会让这个值拿到 41 分，把判别区间压掉一半。
  const { explainabilityBaselineRelevance: baseline, explainabilityFullRelevance: full } =
    SCORING_PARAMETERS;
  assert.ok(full > baseline);
  assert.equal(baselineScore(baseline, baseline, full), 0);
  assert.equal(baselineScore(baseline - 0.1, baseline, full), 0);
  assert.equal(baselineScore(full, baseline, full), 100);
  assert.equal(baselineScore(full + 0.3, baseline, full), 100);
  assert.equal(baselineScore((baseline + full) / 2, baseline, full), 50);
  // 满分点与聚类阈值同源：两个数都来自同一份标定，各自漂移会让「算进领域」
  // 和「讲的是同一件事」落在两套互相解释不了的口径上。
  assert.equal(full, EMBEDDING_CLUSTER_THRESHOLD);
  // 领域自己的阈值只做门禁，不参与打分归一——否则阈值定得松的领域普遍拿高分。
  assert.ok(DEFAULT_RELEVANCE_THRESHOLD > 0 && DEFAULT_RELEVANCE_THRESHOLD < 1);
});

void test('共振的半饱和点与证据门禁的最低独立证据数一致', () => {
  // 两个数各自漂移会让「刚够门禁」的选题落在一个没人解释得清的分数上。
  assert.equal(
    SCORING_PARAMETERS.resonanceHalfSaturationSources,
    MINIMUM_INDEPENDENT_EVIDENCE,
  );
});

void test('计数为 0 得 0 分，半饱和点得 50 分，再往上单调不超 100', () => {
  assert.equal(saturatingScore(0, 3), 0);
  assert.equal(saturatingScore(-1, 3), 0);
  assert.equal(saturatingScore(3, 3), 50);
  const curve = [1, 2, 3, 6, 12, 60].map((count) => saturatingScore(count, 3));
  for (let i = 1; i < curve.length; i += 1) assert.ok(curve[i] > curve[i - 1]);
  assert.ok(curve.at(-1)! <= 100);
});

void test('时效分按半衰期衰减，永远落在 0–100，不会被截断成负数', () => {
  const { freshnessHalfLifeHours: half } = SCORING_PARAMETERS;
  assert.equal(halfLifeScore(0, half), 100);
  assert.equal(halfLifeScore(half, half), 50);
  assert.equal(halfLifeScore(half * 2, half), 25);
  // 旧口径是 100 - 小时数 * 8，超过 12.5 小时就得靠 clamp 兜底，整整一天的新闻全挤在 0 分。
  assert.ok(halfLifeScore(24, half) > 0);
  assert.ok(halfLifeScore(240, half) >= 0);
});

void test('同一份事实在不同运行里得到同一个分：分数可跨运行比较', () => {
  // 编排器是跨运行 ORDER BY score DESC 取选题的；若分数只在一次运行内可比，
  // 「一批烂选题里最不烂的那条」会永远排在最前面。
  const features: ScoreFeatures = {
    ...baseFeatures,
    independentSourceCount: 3,
    numericMentionCount: 2,
    sourceQualityAverage: 92,
    freshestAgeHours: 1,
    domainRelevance: 0.45,
  };
  assert.deepEqual(
    scoreBreakdownFromFeatures(features),
    scoreBreakdownFromFeatures({ ...features }),
  );
  const weaker = scoreBreakdownFromFeatures({ ...features, independentSourceCount: 1 });
  assert.ok(weightedScore(scoreBreakdownFromFeatures(features)) > weightedScore(weaker));
});

void test('一个独立来源都没有的选题，共振拿 0 分而不是中间分', () => {
  const breakdown = scoreBreakdownFromFeatures(baseFeatures);
  assert.equal(breakdown.resonance, 0);
  assert.equal(breakdown.velocity, 0);
  assert.equal(breakdown.numericImpact, 0);
  assert.equal(breakdown.explainability, 0);
});

void test('流水线产出的分项都在 0–100，综合分与权重一致', () => {
  const now = new Date('2026-09-08T02:00:00.000Z');
  const topics = runPipeline(sampleArticles(now), now);
  assert.ok(topics.length > 0);
  for (const topic of topics) {
    for (const [key, value] of Object.entries(topic.scoreBreakdown)) {
      assert.ok(
        Number.isInteger(value) && value >= 0 && value <= 100,
        `${key} = ${value}`,
      );
    }
    assert.equal(topic.score, weightedScore(topic.scoreBreakdown));
    // 热度是「最近一小时新增篇数」，界面上那个数得有单位。
    assert.ok(Number.isInteger(topic.heatChange) && topic.heatChange >= 0);
  }
});

void test('评分口径带版本号，换口径后旧分数不会被当成可比', () => {
  assert.ok(Number.isInteger(SCORING_VERSION) && SCORING_VERSION >= 2);
});
