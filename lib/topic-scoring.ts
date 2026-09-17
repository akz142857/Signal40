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

/**
 * 评分口径版本。改动参数、权重或分项定义都要 +1。
 *
 * 3：可解释性分项从「命中中文财经词表的词数」换成「与主题领域中心向量的余弦」。
 *   词表命中数把语言混进了可解释性——英文选题命中不了中文词，于是无论内容多清晰
 *   都拿 0 分，而这个分项本来要回答的是「这条选题讲得清不清楚、属不属于我们做的事」。
 * 4：余弦不再走 `saturatingScore`。那条曲线的契约是「计数的 0 是真实的 0」，
 *   而余弦没有真零点：本项目实测无关文本的余弦中位数就有 0.228（见
 *   `lib/domain.ts` 的 `EMBEDDING_CLUSTER_THRESHOLD` 注释），套进去会让完全跑题的
 *   选题拿到 41 分，判别区间被压到 41–80，再乘 0.1 权重后全体差不到 4 分。
 *   改成以实测基线为零点的线性映射。
 */
export const SCORING_VERSION = 4;

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
  /**
   * 与最接近的主题领域中心向量的余弦，0–1。
   *
   * 没有配领域、或者选题还没算出向量时是 0——和「算过了、确实跑题」同分。
   * 这在**排序**上是可以接受的：两种情况都不该排在已经判定属于生产范围的选题前面。
   * 「判定不了」和「判定为跑题」的区别由 `lib/topic-quality.ts` 的 domainStatus
   * 承担，那里是门禁，必须分得清。
   */
  domainRelevance: number;
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
  /**
   * 可解释性的零点：本项目语料上无关文本两两余弦的中位数。
   *
   * 这个数不是选来好看的，是 `scripts/calibrate-embedding-threshold.ts` 在 200 篇
   * 真实文章、19900 对上测出来的（p50 = 0.228）。低于它等于「和这个领域没关系」，
   * 该拿 0 分。换模型或换语料要重跑标定并同步改这里。
   */
  explainabilityBaselineRelevance: 0.228,
  /**
   * 可解释性的满分点：到这个余弦算「明确属于这个领域」。
   *
   * 取 0.62 与 `EMBEDDING_CLUSTER_THRESHOLD` 同源——那是同一份标定数据里
   * 「讲的是同一件事」的分界。取固定值而不是各领域自己的阈值：分数要跨运行、
   * 跨领域可比，用每个领域自己的阈值归一会让「阈值定得松的领域」普遍拿高分。
   */
  explainabilityFullRelevance: 0.62,
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

/**
 * 有基线的量 → 分数：基线及以下 0 分，满分点及以上 100 分，中间线性。
 *
 * 余弦这类量不能用 `saturatingScore`：那条曲线假设「0 就是没有」，
 * 而任意两段自然语言之间的余弦都有一个不低的基线，套进去会让"完全无关"
 * 也拿到四十多分，把整个分项的判别区间压掉一半。
 */
export function baselineScore(value: number, baseline: number, full: number) {
  if (!(full > baseline)) return 0;
  const normalized = (value - baseline) / (full - baseline);
  return Math.round(100 * Math.min(1, Math.max(0, normalized)));
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
    explainability: baselineScore(
      features.domainRelevance,
      params.explainabilityBaselineRelevance,
      params.explainabilityFullRelevance,
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
