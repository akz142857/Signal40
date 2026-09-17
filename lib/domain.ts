import { sha256Hex } from './hash.ts';
import {
  independentEvidenceCount,
  SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY,
  type EvidenceQualificationPolicy,
  type EvidenceOrigin,
  type EvidenceRelationship,
} from './social-evidence.ts';
import {
  scoreBreakdownFromFeatures,
  weightedScore,
  type ScoreBreakdown,
  type ScoreFeatures,
} from './topic-scoring.ts';

import {
  cosineSimilarity,
  EMBEDDING_VERSION,
  meanVector,
  usableEmbedding,
} from './embedding.ts';
import { evaluateDomainRelevance, type TopicDomain } from './topic-domains.ts';

/**
 * 流水线上下文：当前向量口径 + 领域配置。
 *
 * 不传就等于「这一轮没有语义口径」：聚类全部走词元、`domainRelevance` 恒为 0。
 * 生产路径必须传——不传时可解释性分项恒 0，而 `SCORING_VERSION` 仍然照写，
 * 落库的分数会声称按领域余弦算过、实际从未评估。
 */
export type PipelineContext = {
  domains: readonly TopicDomain[];
  embeddingModel: string;
  embeddingVersion?: number;
};

/**
 * 词元口径的聚类阈值：判定用词的 Jaccard 相似度下限。
 * 只在文章没有向量时使用。
 */
export const TOKEN_CLUSTER_THRESHOLD = 0.3;

/**
 * 语义口径的聚类阈值：文章向量与簇代表向量的余弦下限。
 *
 * 和词元阈值不是一个量纲，不能沿用同一个数：Jaccard 在无关文本上接近 0，
 * 而嵌入余弦在任意两段自然语言之间都有一个不低的基线。
 *
 * 这个数由 `scripts/calibrate-embedding-threshold.ts` 在本项目真实语料上测出：
 * 200 篇、19900 对，text-embedding-3-small 的两两余弦中位数 0.228、p95 0.542、
 * p99 0.719。人工读了边界上的样例对：
 *
 *   0.556  「OpenAI 披露安全事件」vs「OpenAI 办巡回活动教老年人用 AI」——同公司，异事件
 *   0.606  「OpenAI 披露安全事件」vs「OpenAI 披露六起新安全事件」——同一件事，不同媒体
 *
 * 分界落在 0.56–0.61 这个很窄的带里，两侧余量都只有 0.05，所以取值偏高一侧：
 * 把一件事拆成两个选题，代价是这两个选题各自凑不够 `MINIMUM_INDEPENDENT_EVIDENCE`
 * 而被门禁挡下——这是 fail closed 的方向；而把两件事并成一个选题会虚增独立来源数，
 * 让证据门禁拿着伪造的交叉验证放行，那是这条链路上最不能出的错。
 *
 * 换模型或换语料都要重跑标定脚本，这个数不能跟着代码搬到别的语料上继续用。
 */
export const EMBEDDING_CLUSTER_THRESHOLD = 0.62;

export const SOURCE_TYPES = [
  'social',
  'media',
  'market',
  'filing',
  'company',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * 一手来源：证据门禁认的原始出处（财报/公告、公司官方发布、原始市场数据）。
 * 媒体报道和社交内容是转述，单靠它们过不了门禁。
 *
 * 门禁判据只有这一处定义，界面要解释「为什么过不了」时也读这里，
 * 免得提示词和引擎各说各话。
 */
export const PRIMARY_EVIDENCE_SOURCE_TYPES: readonly SourceType[] = [
  'filing',
  'company',
  'market',
];

/** 通过门禁所需的独立证据份数。 */
export const MINIMUM_INDEPENDENT_EVIDENCE = 2;

export type ArticleInput = {
  id?: string;
  source: string;
  sourceType: SourceType;
  author?: string;
  title: string;
  summary?: string;
  url: string;
  publishedAt: string;
  metrics?: { views?: number; likes?: number; recommends?: number };
  /** 由持久化层从 source_item_origins/publisher_entities 注入，外部导入不能自行提权。 */
  evidenceFamilyId?: string;
  publisherEntityId?: string;
  publisherOwnershipGroup?: string;
  /** 仅由持久化治理层注入；连接器与浏览器输入不能自行提权。 */
  platform?: string;
  originRelationship?: EvidenceRelationship;
  originConfidence?: number;
  originManaged?: boolean;
  originManuallyCorrected?: boolean;
  /** 同一规范化文章可能保留多个来源 origin；仅由持久化治理层填充。 */
  evidenceOrigins?: EvidenceOrigin[];
  /**
   * 语义向量，由 Render Worker 算好写回 articles 表，持久化层读出来注入。
   * 外部导入不带向量，聚类会退回词元口径——见 `clusterArticles`。
   */
  embedding?: number[];
  embeddingModel?: string;
  embeddingVersion?: number;
  /** 算这个向量时用的输入文本哈希；和当前标题摘要对不上就说明向量过期了。 */
  embeddingSourceHash?: string;
};

export type Article = Required<
  Pick<ArticleInput, 'source' | 'sourceType' | 'title' | 'url' | 'publishedAt'>
> & {
  id: string;
  author: string;
  summary: string;
  metrics: NonNullable<ArticleInput['metrics']>;
  contentHash: string;
  evidenceFamilyId?: string;
  publisherEntityId?: string;
  publisherOwnershipGroup?: string;
  platform?: string;
  originRelationship?: EvidenceRelationship;
  originConfidence?: number;
  originManaged?: boolean;
  originManuallyCorrected?: boolean;
  evidenceOrigins?: EvidenceOrigin[];
  /** 语义向量；空数组表示这篇文章还没算过向量。 */
  embedding: number[];
  embeddingModel: string;
  embeddingVersion: number;
  embeddingSourceHash: string;
};


export type { ScoreBreakdown, ScoreFeatures } from './topic-scoring.ts';

export type EvidenceGate = {
  passed: boolean;
  hasPrimarySource: boolean;
  independentSourceCount: number;
  reason: string;
};

export type VerificationStatus = 'unreviewed' | 'verified' | 'rejected';

export type TopicQuality = {
  version: string;
  assessedAt: string;
  articleCount: number;
  sourceCount: number;
  coherence: number;
  coherenceFloor: number;
  evidenceDistinctness: number;
  /** 观测值，不参与判定；判定生产范围的是 domain* 几项。 */
  language: 'zh' | 'en' | 'mixed' | 'unknown';
  /** 语义口径下恒为 0；保留字段是为了旧的落库 JSON 仍能按同一个类型读出来。 */
  lexiconCoverage: number;
  /** 簇内有当前口径语义向量的文章占比。 */
  embeddingCoverage: number;
  embeddingModel: string;
  embeddingVersion: number;
  /** 一致性是按语义余弦算的还是退回了词元口径；后者不允许自动化。 */
  coherenceMode: 'semantic' | 'token';
  domainId: string;
  domainName: string;
  domainRelevance: number;
  domainThreshold: number;
  domainStatus: 'evaluated' | 'unavailable' | 'no_domains';
  /** 判定时的领域配置指纹；配置变了就说明这条结论的依据已经不在了。 */
  domainConfigHash: string;
  /** 综合质量分（0–100），供自动化策略设置可审计的数值下限。 */
  score: number;
  automatable: boolean;
  reasons: string[];
};

export type TopicCandidate = {
  id: string;
  title: string;
  keywords: string[];
  score: number;
  heatChange: number;
  scoreBreakdown: ScoreBreakdown;
  sourceCount: number;
  sources: string[];
  status: 'ready' | 'needs_primary_source' | 'needs_corroboration';
  gate: EvidenceGate;
  verificationStatus: VerificationStatus;
  verificationNote: string;
  quality?: TopicQuality | null;
  articles: Article[];
  updatedAt: string;
};

const SOURCE_QUALITY: Record<SourceType, number> = {
  filing: 100,
  company: 92,
  market: 92,
  media: 72,
  social: 48,
};

export const FINANCE_TERMS = [
  'dram',
  'hbm',
  '存储',
  '芯片',
  '价格',
  '涨价',
  '毛利',
  '利润',
  '收入',
  '财报',
  '铜价',
  '期货',
  '成本',
  '供需',
  '营收',
  '公告',
  '库存',
  '出货',
];

const STRONG_TOPIC_TERMS = new Set([
  'dram',
  'hbm',
  '存储',
  '芯片',
  '铜价',
  '期货',
]);

const STOP_BIGRAMS = new Set([
  '公司',
  '一个',
  '这个',
  '什么',
  '如何',
  '最新',
  '今日',
  '市场',
  '数据',
]);

/**
 * 内容与话题 ID 使用的短哈希：SHA-256 截断到 64 位（16 个十六进制字符）。
 * 不要换回 32 位 FNV——文章去重与话题聚类都按哈希相等判定，
 * 32 位在数万条文章量级上必然发生生日碰撞，会把不同文章/话题合并成一个。
 */
function shortHash(value: string) {
  return sha256Hex(value).slice(0, 16);
}

/**
 * 形如 example.com、a-b.co.uk 的主机名。
 *
 * Google News 的 RSS 把来源域名追加在标题末尾（“…… - washingtonpost.com”），
 * 于是这个域名出现在该媒体的每一条标题里。当成话题词，同一家媒体的两条无关
 * 报道会因为共享域名而被判为相似；当成关键词，它又因为够长而顶掉真正的主题词
 * ——首页上就出现过一条 Trump/Epstein 的新闻被标成
 * “RESPIRATORY-THERAPY.COM 升温”。
 *
 * 用通用形状而不是 TLD 名单：名单一定会漏，而这里判错的方向是丢掉一个词，
 * 比把域名当主题安全。代价是 node.js 这类带点的词也会被丢；真要留住某个这样的词，
 * 把它加进下面的主题词表——词表匹配走的是另一条分支，不受这条规则影响。
 */
const HOSTNAME_TOKEN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function clean(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokensFor(article: Pick<ArticleInput, 'title' | 'summary'>) {
  const text = clean(`${article.title} ${article.summary ?? ''}`);
  const tokens = new Set<string>();

  for (const match of text.matchAll(/[a-z][a-z0-9.+-]{1,}|\d+(?:\.\d+)?%?/g)) {
    if (HOSTNAME_TOKEN.test(match[0])) continue;
    tokens.add(match[0]);
  }
  for (const term of FINANCE_TERMS) {
    if (text.includes(term)) tokens.add(term);
  }
  for (const match of text.matchAll(/[\p{Script=Han}]{3,}/gu)) {
    const value = match[0];
    for (let index = 0; index < value.length - 1; index += 1) {
      const bigram = value.slice(index, index + 2);
      if (!STOP_BIGRAMS.has(bigram)) tokens.add(bigram);
    }
  }
  return tokens;
}

export function similarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

/**
 * 语料里出现得太普遍的词不参与聚类判定。
 *
 * `isStrongTopicToken` 把任何三字母以上的英文词都算「强词」，于是 says、new、trump
 * 这种天天出现的词一个就能把两条毫不相干的新闻判成同一个选题。文档频率是语料自己
 * 给出的答案，不用维护停用词表——但样本太小时频率没有意义，所以只在语料够大时启用。
 */
const COMMON_TOKEN_MIN_ARTICLES = 12;
const COMMON_TOKEN_RATIO = 0.25;
const COMMON_TOKEN_MIN_HITS = 4;

export function commonTokens(tokenSets: readonly Set<string>[]) {
  const common = new Set<string>();
  if (tokenSets.length < COMMON_TOKEN_MIN_ARTICLES) return common;
  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const limit = Math.max(
    COMMON_TOKEN_MIN_HITS,
    tokenSets.length * COMMON_TOKEN_RATIO,
  );
  for (const [token, count] of documentFrequency) {
    // 词表里的词是这套系统要找的主题本身，出现得多是命中而不是噪声。
    if (STRONG_TOPIC_TERMS.has(token) || FINANCE_TERMS.includes(token)) continue;
    if (count > limit) common.add(token);
  }
  return common;
}

function discriminative(tokens: Set<string>, common: Set<string>) {
  if (!common.size) return tokens;
  const kept = new Set<string>();
  for (const token of tokens) if (!common.has(token)) kept.add(token);
  return kept;
}

/**
 * 「强重合」只认词表里的主题词。
 *
 * 原本 `isStrongTopicToken` 把任何三字母以上的英文词都算强词，共享一个就直接判定
 * 同一话题（相似度记满分）。一天的新闻里 trump、says、says 这类词到处都是，第一个
 * 簇借它们把后面所有文章吃掉——46 篇塌成 1 个选题就是这么来的。
 * 词表之外的词不再有这种一票通过的权力，改由 Jaccard 相似度决定。
 */
function hasStrongOverlap(left: Set<string>, right: Set<string>) {
  for (const token of left) {
    if (STRONG_TOPIC_TERMS.has(token) && right.has(token)) return true;
  }
  return false;
}

export function normalizeArticles(inputs: ArticleInput[]) {
  const byHash = new Map<string, Article>();
  for (const input of inputs) {
    if (!input.title?.trim() || !input.url?.trim() || !input.source?.trim())
      continue;
    const canonicalUrl = input.url.trim().replace(/#.*$/, '');
    const contentHash = shortHash(`${canonicalUrl}|${clean(input.title)}`);
    const publishedAt = new Date(input.publishedAt);
    if (Number.isNaN(publishedAt.valueOf())) continue;
    const evidenceOrigins = input.evidenceOrigins?.length ? input.evidenceOrigins : [{
      source: input.source.trim(),
      sourceType: input.sourceType,
      contentHash,
      evidenceFamilyId: input.evidenceFamilyId,
      publisherEntityId: input.publisherEntityId,
      publisherOwnershipGroup: input.publisherOwnershipGroup,
      platform: input.platform,
      originRelationship: input.originRelationship,
      originConfidence: input.originConfidence,
      originManaged: input.originManaged,
      originManuallyCorrected: input.originManuallyCorrected,
    }];
    const existing = byHash.get(contentHash);
    if (existing) {
      const seen = new Set((existing.evidenceOrigins ?? []).map((origin) => JSON.stringify(origin)));
      for (const origin of evidenceOrigins) {
        const key = JSON.stringify(origin);
        if (!seen.has(key)) {
          (existing.evidenceOrigins ??= []).push(origin);
          seen.add(key);
        }
      }
      continue;
    }
    byHash.set(contentHash, {
      id: input.id ?? `article_${contentHash}`,
      source: input.source.trim(),
      sourceType: input.sourceType,
      author: input.author?.trim() ?? '',
      title: input.title.trim(),
      summary: input.summary?.trim() ?? '',
      url: canonicalUrl,
      publishedAt: publishedAt.toISOString(),
      metrics: input.metrics ?? {},
      contentHash,
      evidenceFamilyId: input.evidenceFamilyId,
      publisherEntityId: input.publisherEntityId,
      publisherOwnershipGroup: input.publisherOwnershipGroup,
      platform: input.platform,
      originRelationship: input.originRelationship,
      originConfidence: input.originConfidence,
      originManaged: input.originManaged,
      originManuallyCorrected: input.originManuallyCorrected,
      evidenceOrigins: [...evidenceOrigins],
      embedding: input.embedding ?? [],
      embeddingModel: input.embeddingModel ?? '',
      embeddingVersion: input.embeddingVersion ?? 0,
      embeddingSourceHash: input.embeddingSourceHash ?? '',
    });
  }
  return [...byHash.values()].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  );
}

type Cluster = {
  articles: Article[];
  /** 簇内所有文章的词并集，只用于挑关键词。 */
  tokens: Set<string>;
  /** 簇代表（第一篇文章）的判定用词；聚类只比它，不比并集也不比其他成员。 */
  seedTokens: Set<string>;
  /** 簇代表的语义向量；词元口径下为空数组。 */
  seedEmbedding: number[];
};

/**
 * 聚类用的相似度：共享词数除以并集（Jaccard），且至少要共享两个词。
 *
 * 导出的 `similarity` 用较小的那个词集当分母，这对只有标题、十来个词的新闻条目
 * 过于宽松——共享三个词就到 0.3。并集当分母会把「两条都很短且只碰巧撞上几个词」
 * 压回去，而真正讲同一件事的两条标题共享比例本来就高。
 */
function clusterSimilarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  if (shared < 2) return 0;
  return shared / (left.size + right.size - shared);
}

/**
 * 每个簇由它的第一篇文章代表，后来的文章只和这篇代表比。
 *
 * 不比并集：并集随簇变大不断膨胀，而相似度分母取两者较小的一个，于是大簇对任何
 * 新文章都显得很像——一天 46 篇新闻会全部塌进同一个选题。
 * 也不做单链传递：A 像 B、B 像 C 就把 A 和 C 放一起，同样会顺着链条把不相干的
 * 文章串成一簇，只是塌得慢一点。
 */
export function clusterArticles(
  articles: Article[],
  context?: PipelineContext,
  threshold = TOKEN_CLUSTER_THRESHOLD,
  embeddingThreshold = EMBEDDING_CLUSTER_THRESHOLD,
) {
  const tokenSets = articles.map((article) => tokensFor(article));
  const common = commonTokens(tokenSets);
  const model = context?.embeddingModel ?? '';
  const version = context?.embeddingVersion ?? EMBEDDING_VERSION;
  // 逐篇判定有没有当前口径的向量，而不是对整批做全有全无的判定。
  //
  // 曾经是整批判定，理由是「混着算等于在两个空间里比距离」——理由对，结论错：
  // 向量是异步算的，任何时刻刚采进来的文章都还没有向量，于是 1 篇拖着 1000 篇
  // 一起退回词元口径，语义聚类在有采集流量时根本不会启用。
  // 正确的粒度是「这一对能不能比」：两篇都有当前口径向量就比余弦，否则比词元。
  // 两种口径不会混进同一个比较，而没向量的那篇也不再拖累别人。
  const usable = articles.map((article) => usableEmbedding(article, model, version));
  const clusters: Cluster[] = [];
  for (const [index, article] of articles.entries()) {
    const articleTokens = tokenSets[index];
    const matchTokens = discriminative(articleTokens, common);
    let bestCluster: Cluster | undefined;
    let bestSimilarity = 0;
    for (const cluster of clusters) {
      const semantic = usable[index] && cluster.seedEmbedding.length > 0;
      const score = semantic
        ? cosineSimilarity(article.embedding, cluster.seedEmbedding)
        : hasStrongOverlap(matchTokens, cluster.seedTokens)
          ? 1
          : clusterSimilarity(matchTokens, cluster.seedTokens);
      // 两种口径的分数不可直接比大小，所以各自先过自己的阈值再参与择优。
      if (score < (semantic ? embeddingThreshold : threshold)) continue;
      if (score > bestSimilarity) {
        bestCluster = cluster;
        bestSimilarity = score;
      }
    }
    if (bestCluster) {
      bestCluster.articles.push(article);
      for (const token of articleTokens) bestCluster.tokens.add(token);
    } else {
      clusters.push({
        articles: [article],
        tokens: new Set(articleTokens),
        seedTokens: matchTokens,
        seedEmbedding: usable[index] ? article.embedding : [],
      });
    }
  }
  return clusters;
}

function scoreCluster(
  cluster: Cluster,
  now: Date,
  evidencePolicy: EvidenceQualificationPolicy,
  context?: PipelineContext,
): Omit<
  TopicCandidate,
  | 'id'
  | 'title'
  | 'keywords'
  | 'articles'
  | 'updatedAt'
  | 'verificationStatus'
  | 'verificationNote'
> {
  const uniqueSources = new Set(
    cluster.articles.map((article) => article.source),
  );
  const independentSourceCount = independentEvidenceCount(
    cluster.articles.flatMap((article) => article.evidenceOrigins?.length ? article.evidenceOrigins : [article]),
    evidencePolicy,
  );
  const ages = cluster.articles.map((article) =>
    Math.max(
      0,
      (now.valueOf() - new Date(article.publishedAt).valueOf()) / 3_600_000,
    ),
  );
  const recentCount = ages.filter((hours) => hours <= 1).length;
  const text = cluster.articles
    .map((article) => `${article.title} ${article.summary}`)
    .join(' ');
  const numericMatches = text.match(/\d+(?:\.\d+)?%?|[¥￥$]\s?\d+/g) ?? [];

  const features: ScoreFeatures = {
    independentSourceCount,
    recentArticleCount: recentCount,
    numericMentionCount: numericMatches.length,
    sourceQualityAverage:
      cluster.articles.reduce(
        (sum, article) => sum + SOURCE_QUALITY[article.sourceType],
        0,
      ) / cluster.articles.length,
    freshestAgeHours: Math.min(...ages),
    domainRelevance: context
      ? evaluateDomainRelevance(
          meanVector(
            cluster.articles
              .filter((article) =>
                usableEmbedding(
                  article,
                  context.embeddingModel,
                  context.embeddingVersion ?? EMBEDDING_VERSION,
                ),
              )
              .map((article) => article.embedding),
          ),
          context.domains,
          context.embeddingModel,
          context.embeddingVersion ?? EMBEDDING_VERSION,
        ).relevance
      : 0,
  };
  const breakdown = scoreBreakdownFromFeatures(features);
  const score = weightedScore(breakdown);
  const hasPrimarySource = cluster.articles.some((article) =>
    PRIMARY_EVIDENCE_SOURCE_TYPES.includes(article.sourceType),
  );
  const passed =
    hasPrimarySource && independentSourceCount >= MINIMUM_INDEPENDENT_EVIDENCE;
  const gate: EvidenceGate = {
    passed,
    hasPrimarySource,
    independentSourceCount,
    reason: passed
      ? '已找到原始来源并有独立证据交叉支持'
      : !hasPrimarySource
        ? '仍需财报、公告或原始市场数据'
        : '原始来源已找到，仍需一个独立证据交叉支持',
  };
  const status: TopicCandidate['status'] = passed
    ? 'ready'
    : hasPrimarySource
      ? 'needs_corroboration'
      : 'needs_primary_source';

  return {
    score,
    // 「热度」= 最近一小时新增的篇数。以前是 recentCount*4 + (来源数-1)*3，
    // 界面上那个「热度 +7」既不是篇数也不是百分比，没有单位可言。
    heatChange: recentCount,
    scoreBreakdown: breakdown,
    sourceCount: independentSourceCount,
    sources: [...uniqueSources],
    status,
    gate,
  };
}

export function runPipeline(
  inputs: ArticleInput[],
  now = new Date(),
  evidencePolicy: EvidenceQualificationPolicy = SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY,
  context?: PipelineContext,
): TopicCandidate[] {
  const articles = normalizeArticles(inputs);
  return clusterArticles(articles, context)
    .map((cluster) => {
      const rankedTokens = [...cluster.tokens]
        .filter((token) => token.length > 1 && !/^\d/.test(token))
        .sort(
          (a, b) =>
            Number(FINANCE_TERMS.includes(b)) -
              Number(FINANCE_TERMS.includes(a)) || b.length - a.length,
        )
        .slice(0, 6);
      const scored = scoreCluster(cluster, now, evidencePolicy, context);
      return {
        id: `topic_${shortHash(
          cluster.articles
            .map((article) => article.contentHash)
            .sort()
            .join('|'),
        )}`,
        title: cluster.articles[0].title,
        keywords: rankedTokens,
        ...scored,
        articles: cluster.articles,
        verificationStatus: 'unreviewed' as const,
        verificationNote: '',
        updatedAt: cluster.articles[0].publishedAt,
      };
    })
    .sort((a, b) => b.score - a.score || b.sourceCount - a.sourceCount);
}

export function validateArticleInput(
  value: unknown,
  now = new Date(),
): string | null {
  if (!value || typeof value !== 'object') return '记录必须是对象';
  const input = value as Partial<ArticleInput>;
  if (
    typeof input.source !== 'string' ||
    !input.source.trim() ||
    input.source.length > 160
  )
    return 'source 必须是 1–160 个字符';
  if (
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 500
  )
    return 'title 必须是 1–500 个字符';
  if (
    input.summary !== undefined &&
    (typeof input.summary !== 'string' || input.summary.length > 4_000)
  )
    return 'summary 最多 4000 个字符';
  if (
    input.author !== undefined &&
    (typeof input.author !== 'string' || input.author.length > 160)
  )
    return 'author 最多 160 个字符';
  if (!SOURCE_TYPES.includes(input.sourceType as SourceType))
    return `sourceType 必须是 ${SOURCE_TYPES.join(', ')} 之一`;
  if (typeof input.url !== 'string' || input.url.length > 2_000)
    return 'url 必须是长度不超过 2000 的 HTTP(S) 地址';
  try {
    const parsed = new URL(input.url);
    if (!['http:', 'https:'].includes(parsed.protocol))
      return 'url 仅允许 HTTP(S)';
  } catch {
    return 'url 不是合法地址';
  }
  if (typeof input.publishedAt !== 'string')
    return 'publishedAt 必须是 ISO 日期时间';
  const publishedAt = new Date(input.publishedAt);
  if (Number.isNaN(publishedAt.valueOf()))
    return 'publishedAt 不是合法日期时间';
  if (publishedAt.valueOf() > now.valueOf() + 5 * 60_000)
    return 'publishedAt 不能晚于当前时间 5 分钟以上';
  if (input.metrics !== undefined) {
    if (!input.metrics || typeof input.metrics !== 'object')
      return 'metrics 必须是对象';
    for (const key of ['views', 'likes', 'recommends'] as const) {
      const metric = input.metrics[key];
      if (metric !== undefined && (!Number.isSafeInteger(metric) || metric < 0))
        return `metrics.${key} 必须是非负整数`;
    }
  }
  return null;
}

export function isArticleInput(value: unknown): value is ArticleInput {
  return validateArticleInput(value) === null;
}
