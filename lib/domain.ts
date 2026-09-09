import { sha256Hex } from './hash.ts';
import {
  independentEvidenceCount,
  SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY,
  type EvidenceQualificationPolicy,
  type EvidenceOrigin,
  type EvidenceRelationship,
} from './social-evidence.ts';

export const SOURCE_TYPES = [
  'social',
  'media',
  'market',
  'filing',
  'company',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

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
};

export type ScoreBreakdown = {
  resonance: number;
  velocity: number;
  numericImpact: number;
  sourceQuality: number;
  freshness: number;
  explainability: number;
};

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
  language: 'zh' | 'en' | 'mixed' | 'unknown';
  lexiconCoverage: number;
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

function clean(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokensFor(article: Pick<ArticleInput, 'title' | 'summary'>) {
  const text = clean(`${article.title} ${article.summary ?? ''}`);
  const tokens = new Set<string>();

  for (const match of text.matchAll(/[a-z][a-z0-9.+-]{1,}|\d+(?:\.\d+)?%?/g)) {
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

function isStrongTopicToken(token: string) {
  return (
    STRONG_TOPIC_TERMS.has(token) ||
    /^[a-z][a-z0-9.+-]{2,}$/.test(token) ||
    /^\d+(?:\.\d+)?%$/.test(token)
  );
}

function hasStrongOverlap(left: Set<string>, right: Set<string>) {
  for (const token of left) {
    if (isStrongTopicToken(token) && right.has(token)) return true;
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
    });
  }
  return [...byHash.values()].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  );
}

type Cluster = { articles: Article[]; tokens: Set<string> };

export function clusterArticles(articles: Article[], threshold = 0.3) {
  const clusters: Cluster[] = [];
  for (const article of articles) {
    const articleTokens = tokensFor(article);
    let bestCluster: Cluster | undefined;
    let bestSimilarity = 0;
    for (const cluster of clusters) {
      const score = hasStrongOverlap(articleTokens, cluster.tokens)
        ? 1
        : similarity(articleTokens, cluster.tokens);
      if (score > bestSimilarity) {
        bestCluster = cluster;
        bestSimilarity = score;
      }
    }
    if (bestCluster && bestSimilarity >= threshold) {
      bestCluster.articles.push(article);
      for (const token of articleTokens) bestCluster.tokens.add(token);
    } else {
      clusters.push({ articles: [article], tokens: articleTokens });
    }
  }
  return clusters;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function scoreCluster(
  cluster: Cluster,
  now: Date,
  evidencePolicy: EvidenceQualificationPolicy,
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
  const sourceTypes = new Set(
    cluster.articles.map((article) => article.sourceType),
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

  const breakdown: ScoreBreakdown = {
    resonance: clamp(independentSourceCount * 19 + sourceTypes.size * 7),
    velocity: clamp(
      26 + recentCount * 20 + Math.max(0, independentSourceCount - 1) * 8,
    ),
    numericImpact: clamp(44 + numericMatches.length * 18),
    sourceQuality: clamp(
      cluster.articles.reduce(
        (sum, article) => sum + SOURCE_QUALITY[article.sourceType],
        0,
      ) / cluster.articles.length,
    ),
    freshness: clamp(100 - Math.min(...ages) * 8),
    explainability: clamp(
      46 +
        FINANCE_TERMS.filter((term) => clean(text).includes(term)).length * 8 +
        (numericMatches.length ? 14 : 0),
    ),
  };
  const score = clamp(
    breakdown.resonance * 0.25 +
      breakdown.velocity * 0.2 +
      breakdown.numericImpact * 0.15 +
      breakdown.sourceQuality * 0.2 +
      breakdown.freshness * 0.1 +
      breakdown.explainability * 0.1,
  );
  const hasPrimarySource = cluster.articles.some((article) =>
    ['filing', 'company', 'market'].includes(article.sourceType),
  );
  const passed = hasPrimarySource && independentSourceCount >= 2;
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
    heatChange: clamp(
      recentCount * 4 + Math.max(0, independentSourceCount - 1) * 3,
    ),
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
): TopicCandidate[] {
  const articles = normalizeArticles(inputs);
  return clusterArticles(articles)
    .map((cluster) => {
      const rankedTokens = [...cluster.tokens]
        .filter((token) => token.length > 1 && !/^\d/.test(token))
        .sort(
          (a, b) =>
            Number(FINANCE_TERMS.includes(b)) -
              Number(FINANCE_TERMS.includes(a)) || b.length - a.length,
        )
        .slice(0, 6);
      const scored = scoreCluster(cluster, now, evidencePolicy);
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
