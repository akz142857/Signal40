import {
  similarity,
  tokensFor,
  type Article,
  type TopicCandidate,
  type TopicQuality,
} from './domain.ts';
import {
  EMBEDDING_VERSION,
  meanVector,
  pairwiseCosine,
  usableEmbedding,
} from './embedding.ts';
import {
  domainConfigHash,
  evaluateDomainRelevance,
  type DomainRelevance,
  type TopicDomain,
} from './topic-domains.ts';

/**
 * 选题质量度量——自动建项目的前置条件。
 *
 * 实测发现当前聚类在英文来源上会把上百篇文章并成一个话题，
 * 三条声明的「证据」指向同一批文章、没有区分度。只看来源数看不出这一点：
 * 来源数越多分越高，恰恰是簇失效时最高。
 *
 * 因此这里度量三件事，任何一项不达标都判定为「不可自动化」：
 *
 * 1. 簇内主题一致性——文章两两之间的语义余弦分布，而不是来源数；
 * 2. 声明与证据的对应唯一性——同一批证据同时支撑多条声明，说明证据没有真正绑定到声明；
 * 3. 领域相关性——选题落不落在 `topic_domains` 配置的生产范围内。
 *
 * 第 1 和第 3 项原先是词元口径：中文按 2-gram 切、英文按裸词切，领域靠 18 个
 * 中文财经词的子串命中。那套办法把「这是什么语言」混进了「这讲的是什么」——
 * 英文选题命中不了中文词表，于是无论内容是什么都被判为跑题。现在两项都改成
 * 同一个语义余弦口径（`lib/embedding.ts`），语言不再进入判定。
 *
 * **没有可用向量时 fail closed**：判定不了不等于达标。聚类可以在缺向量时退回
 * 词元口径（分组变差是可接受的降级），但「能不能自动生产」这一条不允许降级——
 * 那会让一个没被度量过的选题走进无人值守的生产链路。
 *
 * 判定结果只决定「能不能自动建项目」。不达标的选题照常进人工待办箱，
 * 人依旧可以手工建项目——这是自动化的闸门，不是选题的判决。
 */

/**
 * 质量口径版本。
 *
 * 2.0.0 起一致性与领域相关性改用语义向量。
 * 2.1.0 起语义口径要求**全簇**都有当前口径向量，而不只是抽样内那 40 篇。
 * 2.2.0 起聚类改为质心 + 全连接判据并新增簇间合并（见 `lib/domain.ts`
 *   的 `clusterArticles`）。簇的成员变了，2.1.0 及更早的判定是对另一批文章下的，
 *   必须重算而不是沿用。
 */
export const TOPIC_QUALITY_VERSION = 'signal40-topic-quality/2.2.0';

/**
 * 簇内两两语义余弦的中位数下限。
 *
 * 比 `EMBEDDING_CLUSTER_THRESHOLD`（0.62）低。历史上的理由是「聚类只保证每篇
 * 文章与簇代表的余弦达标，成员之间可以比这更远」；改成全连接判据之后，走语义
 * 路径进来的成员两两都不低于 0.62，这条理由对它们已经不成立。
 *
 * 保留 0.55 不动，因为它守的是另外两种成员：词元路径进来的（判据根本不看向量），
 * 以及入簇时还没算出向量、下一轮才补上的。这两类的两两余弦可以低于聚类阈值，
 * 一致性下限仍然是它们唯一的闸。
 *
 * 取值本身来自标定语料：同题簇的成员两两余弦落在 0.6–0.9，聚类失效的簇落在
 * 0.2–0.4，0.55 在这两团之间。
 */
export const MIN_SEMANTIC_COHERENCE = 0.55;
/** 声明↔证据对应唯一性下限：1 表示每条声明各有一批独有证据。 */
export const MIN_EVIDENCE_DISTINCTNESS = 0.5;
/** 超过这个规模又没有足够一致性的簇，基本可以确定是聚类失效而不是热点。 */
export const MAX_COHERENT_CLUSTER_SIZE = 25;
/** 一致性抽样上限：两两比较是 O(n²)，大簇只取最新的这些文章。 */
const COHERENCE_SAMPLE_SIZE = 40;

export type TopicLanguage = TopicQuality['language'];
export type { TopicQuality } from './domain.ts';

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 语言判定。
 *
 * **不再是门禁**，只作为落库的观测值：运营看「这批选题都是什么语言」时有个数，
 * 以及领域中心向量配错语言时能从这里看出端倪。判定生产范围的是领域相关性。
 */
export function detectLanguage(text: string): TopicLanguage {
  const han = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = han + latin;
  if (!total) return 'unknown';
  const hanRatio = han / total;
  if (hanRatio >= 0.6) return 'zh';
  if (hanRatio <= 0.1) return 'en';
  return 'mixed';
}

/**
 * 声明↔证据对应唯一性：1 减去两两声明证据集合的平均 Jaccard 相似度。
 * 只有一条声明时没有可比对象，按 1 处理。
 */
export function evidenceDistinctness(
  claims: ReadonlyArray<{ evidenceIds: readonly string[] }>,
) {
  const sets = claims.map((claim) => new Set(claim.evidenceIds));
  if (sets.length < 2) return sets.length === 1 && sets[0].size ? 1 : 0;
  const overlaps: number[] = [];
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      const union = new Set([...sets[left], ...sets[right]]);
      if (!union.size) {
        overlaps.push(1);
        continue;
      }
      let intersection = 0;
      for (const value of sets[left])
        if (sets[right].has(value)) intersection += 1;
      overlaps.push(intersection / union.size);
    }
  }
  return 1 - overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length;
}

/**
 * 按 `createProjectV2` 的规则推演出候选声明与它们的证据集合。
 *
 * 建项目时声明取前 3 篇原始来源文章、证据挂上簇内全部文章——
 * 想知道「自动建出来的项目证据有没有区分度」，就必须按同一条规则推演，
 * 而不是另立一套评估口径。
 */
function candidateClaims(articles: readonly Article[]) {
  return articles
    .filter((article) =>
      ['filing', 'company', 'market'].includes(article.sourceType),
    )
    .slice(0, 3)
    .map((article, index) => ({
      id: `claim_${index + 1}`,
      sourceArticleId: article.id,
      evidenceIds: articles.map((source) => source.id),
    }));
}

export type TopicQualityOptions = {
  /** 可用于判定领域相关性的领域配置；空数组表示一个领域都没配。 */
  domains?: readonly TopicDomain[];
  /** 当前嵌入模型；文章向量、领域中心向量都必须是这个模型算出来的才可比。 */
  embeddingModel?: string;
  embeddingVersion?: number;
};

export function assessTopicQuality(
  topic: Pick<TopicCandidate, 'articles' | 'sourceCount'>,
  now = new Date(),
  options: TopicQualityOptions = {},
): TopicQuality {
  const articles = topic.articles;
  const sample = articles.slice(0, COHERENCE_SAMPLE_SIZE);
  const embeddingModel = options.embeddingModel ?? '';
  const embeddingVersion = options.embeddingVersion ?? EMBEDDING_VERSION;
  const domains = options.domains ?? [];

  const embeddedCount = articles.filter((article) =>
    usableEmbedding(article, embeddingModel, embeddingVersion),
  ).length;
  const embeddingCoverage = articles.length ? embeddedCount / articles.length : 0;
  /**
   * 语义口径要求**全簇**都有当前口径向量，不是抽样内那 40 篇。
   *
   * 只看抽样会开一个洞：一个 100 篇的簇，最新 40 篇有向量、更老的 60 篇滑出了
   * 回填窗口，抽样判定通过、一致性只在 40% 的文章上算出，而 `automatable` 可以为 true——
   * 等于让一个 60% 未被度量的簇走进无人值守生产。覆盖率算出来就必须参与判定，
   * 否则它只是个没人看的数字。
   */
  const semantic = Boolean(articles.length) && embeddedCount === articles.length;

  const pairwise = semantic
    ? pairwiseCosine(sample.map((article) => article.embedding))
    : (() => {
        const tokens = sample.map((article) => tokensFor(article));
        const values: number[] = [];
        for (let left = 0; left < tokens.length; left += 1) {
          for (let right = left + 1; right < tokens.length; right += 1) {
            values.push(similarity(tokens[left], tokens[right]));
          }
        }
        return values;
      })();
  const coherence = median(pairwise);
  const coherenceFloor = pairwise.length ? Math.min(...pairwise) : 0;

  const text = articles
    .map((article) => `${article.title} ${article.summary}`)
    .join(' ')
    .toLowerCase();
  const language = detectLanguage(text);
  const distinctness = evidenceDistinctness(candidateClaims(articles));

  const topicVector = semantic
    ? meanVector(sample.map((article) => article.embedding))
    : [];
  const domain: DomainRelevance = evaluateDomainRelevance(
    topicVector,
    domains,
    embeddingModel,
    embeddingVersion,
  );

  const coherenceScore = Math.min(1, coherence / MIN_SEMANTIC_COHERENCE);
  const distinctnessScore = Math.min(
    1,
    distinctness / MIN_EVIDENCE_DISTINCTNESS,
  );
  const domainScore =
    domain.status === 'evaluated' && domain.threshold > 0
      ? Math.min(1, domain.relevance / domain.threshold)
      : 0;
  const qualityScore = Math.round(
    ((coherenceScore + distinctnessScore + domainScore) / 3) * 100,
  );

  const reasons: string[] = [];
  if (!semantic) {
    reasons.push(
      `簇内只有 ${Math.round(embeddingCoverage * 100)}% 的文章有当前口径（${embeddingModel || '未配置'}/v${embeddingVersion}）的语义向量，一致性与领域相关性无法按语义口径判定。`,
    );
  }
  if (articles.length < 2)
    reasons.push('簇内只有一篇文章，无法度量主题一致性。');
  if (semantic && pairwise.length && coherence < MIN_SEMANTIC_COHERENCE) {
    reasons.push(
      `簇内语义余弦中位数 ${round(coherence)} 低于 ${MIN_SEMANTIC_COHERENCE}，聚类可能把不相关的报道并到了一起。`,
    );
  }
  if (
    semantic &&
    articles.length > MAX_COHERENT_CLUSTER_SIZE &&
    coherence < MIN_SEMANTIC_COHERENCE * 0.8
  ) {
    reasons.push(
      `簇内有 ${articles.length} 篇文章但语义一致性只有 ${round(coherence)}，属于聚类失效而不是热点集中。`,
    );
  }
  if (distinctness < MIN_EVIDENCE_DISTINCTNESS) {
    reasons.push(
      `声明与证据的对应唯一性 ${round(distinctness)} 低于 ${MIN_EVIDENCE_DISTINCTNESS}，同一批证据同时支撑多条声明。`,
    );
  }
  if (domain.status === 'no_domains') {
    reasons.push('没有配置任何主题领域，无法判断这条选题是否落在生产范围内。');
  } else if (domain.status === 'unavailable') {
    reasons.push(
      '领域中心向量缺失或与当前嵌入口径不一致，领域相关性无法判定。',
    );
  } else if (!domain.inScope) {
    reasons.push(
      `与最接近的领域「${domain.domainName}」相关性 ${domain.relevance} 低于 ${domain.threshold}，这条选题不在配置的生产范围内。`,
    );
  }

  return {
    version: TOPIC_QUALITY_VERSION,
    assessedAt: now.toISOString(),
    articleCount: articles.length,
    sourceCount: topic.sourceCount,
    coherence: round(coherence),
    coherenceFloor: round(coherenceFloor),
    evidenceDistinctness: round(distinctness),
    language,
    /** 语义口径下这个字段不再参与判定，保留为 0 以免旧看板把它读成有效覆盖率。 */
    lexiconCoverage: 0,
    embeddingCoverage: round(embeddingCoverage),
    embeddingModel,
    embeddingVersion,
    coherenceMode: semantic ? 'semantic' : 'token',
    domainId: domain.domainId,
    domainName: domain.domainName,
    domainRelevance: domain.relevance,
    domainThreshold: domain.threshold,
    domainStatus: domain.status,
    /**
     * 判定时的领域配置哈希。
     *
     * 门禁结论的生命周期不能长于它所依据的配置：停用一个领域、或把阈值从 0.3 提到 0.5
     * 之后，旧的 `automatable: true` 必须失效。落这个哈希，编排引擎才判得出哪些结论过期了。
     */
    domainConfigHash: domainConfigHash(domains),
    score: qualityScore,
    automatable: reasons.length === 0,
    reasons,
  };
}
