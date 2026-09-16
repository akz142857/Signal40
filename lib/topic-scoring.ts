/**
 * 选题评分：把可数事实映射成 0–100 的分项。
 *
 * 为什么单独成一个模块：分项的数值以前是写死在打分函数里的字面量
 * （`44 + 数字个数 * 18` 这类），既说不出每个数从哪来，也没法审计——
 * 而 `topics.score` 是有实权的：自动化策略的 `minTopicScore` 用它决定
 * 哪条选题自动建项目。决定生产的数必须能追到出处。
 *
 * 两条原则：
 *
 * 1. **每个分项只由一个可数事实驱动**，参数只剩「多少算一半分」这一个，
 *    带单位、带含义、能写进文档，而不是一串没有出处的乘数。
 * 2. **跨运行可比**：同一份事实在任何一次运行里都得到同一个分。
 *    曾考虑改成「同一次运行内的分位排名」，但 `lib/orchestrator.ts` 是跨运行
 *    按 `ORDER BY t.score DESC` 取选题的，分位排名会让「一批烂选题里最不烂的那条」
 *    永远接近满分——在无人值守的链路上，这正是最不能出的错。
 *
 * 改这里的任何参数都必须同时提升 `SCORING_VERSION`，版本号随选题落库，
 * 这样两次运行的分数能不能直接比较是可判定的，而不是靠猜。
 */

/** 评分口径版本。改动参数、权重或分项定义都要 +1。 */
export const SCORING_VERSION = 2;

export type ScoreBreakdown = {
  resonance: number;
  velocity: number;
  numericImpact: number;
  sourceQuality: number;
  freshness: number;
  explainability: number;
};

/** 打分的全部输入：每一项都是能在文章上数出来的事实。 */
export type ScoreFeatures = {
  /** 通过独立性判定的证据来源数。 */
  independentSourceCount: number;
  /** 最近一小时内发布的文章数。 */
  recentArticleCount: number;
  /** 标题与摘要里出现的数字/金额个数。 */
  numericMentionCount: number;
  /** 各文章来源类型可信度的平均值，本身已经是 0–100。 */
  sourceQualityAverage: number;
  /** 最新一篇文章的小时龄。 */
  freshestAgeHours: number;
  /** 命中主题词表的词数。 */
  lexiconHitCount: number;
};

/**
 * 每个参数的含义都是「这个计数到多少时，该分项给 50 分」，
 * 或者「过多久时效分减半」。曲线单调、有界、不需要 clamp 兜底。
 */
export const SCORING_PARAMETERS = {
  /** 独立证据来源数到 2 时共振 50 分——与证据门禁的最低独立证据数同一个数。 */
  resonanceHalfSaturationSources: 2,
  /** 一小时内新增 2 篇时增速 50 分。 */
  velocityHalfSaturationArticles: 2,
  /** 出现 3 个数字/金额时冲击力 50 分。 */
  numericHalfSaturationMentions: 3,
  /** 命中 3 个词表词时可解释性 50 分。 */
  explainabilityHalfSaturationTerms: 3,
  /** 每过 12 小时时效分减半。 */
  freshnessHalfLifeHours: 12,
} as const;

/** 综合分的权重，六项之和必须是 1。 */
export const SCORE_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  resonance: 0.25,
  velocity: 0.2,
  numericImpact: 0.15,
  sourceQuality: 0.2,
  freshness: 0.1,
  explainability: 0.1,
};

/**
 * 计数 → 分数：0 个就是 0 分，到半饱和点是 50 分，之后递减增益逼近 100。
 *
 * 0 必须落在 0 分：一条「一个独立来源都没有」的选题不该因为别的候选更差而拿到中间分。
 */
export function saturatingScore(count: number, halfSaturation: number) {
  if (!(count > 0)) return 0;
  return Math.round(100 * (1 - 0.5 ** (count / halfSaturation)));
}

/** 小时龄 → 时效分：按半衰期衰减，永远为正，不会像线性扣分那样一天后变成负数再被截断。 */
export function halfLifeScore(ageHours: number, halfLifeHours: number) {
  return Math.round(100 * 0.5 ** (Math.max(0, ageHours) / halfLifeHours));
}

export function scoreBreakdownFromFeatures(features: ScoreFeatures): ScoreBreakdown {
  const params = SCORING_PARAMETERS;
  return {
    resonance: saturatingScore(
      features.independentSourceCount,
      params.resonanceHalfSaturationSources,
    ),
    velocity: saturatingScore(
      features.recentArticleCount,
      params.velocityHalfSaturationArticles,
    ),
    numericImpact: saturatingScore(
      features.numericMentionCount,
      params.numericHalfSaturationMentions,
    ),
    sourceQuality: Math.round(Math.min(100, Math.max(0, features.sourceQualityAverage))),
    freshness: halfLifeScore(features.freshestAgeHours, params.freshnessHalfLifeHours),
    explainability: saturatingScore(
      features.lexiconHitCount,
      params.explainabilityHalfSaturationTerms,
    ),
  };
}

export function weightedScore(breakdown: ScoreBreakdown) {
  const total = (Object.keys(SCORE_WEIGHTS) as (keyof ScoreBreakdown)[]).reduce(
    (sum, key) => sum + breakdown[key] * SCORE_WEIGHTS[key],
    0,
  );
  return Math.round(Math.min(100, Math.max(0, total)));
}
