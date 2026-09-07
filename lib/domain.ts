export const SOURCE_TYPES = ['social', 'media', 'market', 'filing', 'company'] as const;
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
};

export type Article = Required<Pick<ArticleInput, 'source' | 'sourceType' | 'title' | 'url' | 'publishedAt'>> & {
  id: string;
  author: string;
  summary: string;
  metrics: NonNullable<ArticleInput['metrics']>;
  contentHash: string;
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

const FINANCE_TERMS = [
  'dram', 'hbm', '存储', '芯片', '价格', '涨价', '毛利', '利润', '收入', '财报',
  '铜价', '期货', '成本', '供需', '营收', '公告', '库存', '出货',
];

const STRONG_TOPIC_TERMS = new Set(['dram', 'hbm', '存储', '芯片', '铜价', '期货']);

const STOP_BIGRAMS = new Set(['公司', '一个', '这个', '什么', '如何', '最新', '今日', '市场', '数据']);

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function clean(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function tokensFor(article: Pick<ArticleInput, 'title' | 'summary'>) {
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

function similarity(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

function isStrongTopicToken(token: string) {
  return STRONG_TOPIC_TERMS.has(token) || /^[a-z][a-z0-9.+-]{2,}$/.test(token) || /^\d+(?:\.\d+)?%$/.test(token);
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
    if (!input.title?.trim() || !input.url?.trim() || !input.source?.trim()) continue;
    const canonicalUrl = input.url.trim().replace(/#.*$/, '');
    const contentHash = stableHash(`${canonicalUrl}|${clean(input.title)}`);
    if (byHash.has(contentHash)) continue;
    const publishedAt = new Date(input.publishedAt);
    if (Number.isNaN(publishedAt.valueOf())) continue;
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
    });
  }
  return [...byHash.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

type Cluster = { articles: Article[]; tokens: Set<string> };

export function clusterArticles(articles: Article[], threshold = 0.3) {
  const clusters: Cluster[] = [];
  for (const article of articles) {
    const articleTokens = tokensFor(article);
    let bestCluster: Cluster | undefined;
    let bestSimilarity = 0;
    for (const cluster of clusters) {
      const score = hasStrongOverlap(articleTokens, cluster.tokens) ? 1 : similarity(articleTokens, cluster.tokens);
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

function scoreCluster(cluster: Cluster, now: Date): Omit<TopicCandidate, 'id' | 'title' | 'keywords' | 'articles' | 'updatedAt'> {
  const uniqueSources = new Set(cluster.articles.map((article) => article.source));
  const sourceTypes = new Set(cluster.articles.map((article) => article.sourceType));
  const ages = cluster.articles.map((article) => Math.max(0, (now.valueOf() - new Date(article.publishedAt).valueOf()) / 3_600_000));
  const recentCount = ages.filter((hours) => hours <= 1).length;
  const text = cluster.articles.map((article) => `${article.title} ${article.summary}`).join(' ');
  const numericMatches = text.match(/\d+(?:\.\d+)?%?|[¥￥$]\s?\d+/g) ?? [];

  const breakdown: ScoreBreakdown = {
    resonance: clamp(uniqueSources.size * 19 + sourceTypes.size * 7),
    velocity: clamp(26 + recentCount * 20 + Math.max(0, uniqueSources.size - 1) * 8),
    numericImpact: clamp(44 + numericMatches.length * 18),
    sourceQuality: clamp(cluster.articles.reduce((sum, article) => sum + SOURCE_QUALITY[article.sourceType], 0) / cluster.articles.length),
    freshness: clamp(100 - Math.min(...ages) * 8),
    explainability: clamp(46 + FINANCE_TERMS.filter((term) => clean(text).includes(term)).length * 8 + (numericMatches.length ? 14 : 0)),
  };
  const score = clamp(
    breakdown.resonance * 0.25 + breakdown.velocity * 0.2 + breakdown.numericImpact * 0.15 +
    breakdown.sourceQuality * 0.2 + breakdown.freshness * 0.1 + breakdown.explainability * 0.1,
  );
  const hasPrimarySource = cluster.articles.some((article) => ['filing', 'company', 'market'].includes(article.sourceType));
  const independentSourceCount = uniqueSources.size;
  const passed = hasPrimarySource && independentSourceCount >= 2;
  const gate: EvidenceGate = {
    passed,
    hasPrimarySource,
    independentSourceCount,
    reason: passed ? '已找到原始来源并有独立证据交叉支持' : !hasPrimarySource ? '仍需财报、公告或原始市场数据' : '原始来源已找到，仍需一个独立证据交叉支持',
  };
  const status: TopicCandidate['status'] = passed ? 'ready' : hasPrimarySource ? 'needs_corroboration' : 'needs_primary_source';

  return {
    score,
    heatChange: clamp(recentCount * 4 + Math.max(0, uniqueSources.size - 1) * 3),
    scoreBreakdown: breakdown,
    sourceCount: uniqueSources.size,
    sources: [...uniqueSources],
    status,
    gate,
  };
}

export function runPipeline(inputs: ArticleInput[], now = new Date()): TopicCandidate[] {
  const articles = normalizeArticles(inputs);
  return clusterArticles(articles)
    .map((cluster) => {
      const rankedTokens = [...cluster.tokens]
        .filter((token) => token.length > 1 && !/^\d/.test(token))
        .sort((a, b) => Number(FINANCE_TERMS.includes(b)) - Number(FINANCE_TERMS.includes(a)) || b.length - a.length)
        .slice(0, 6);
      const scored = scoreCluster(cluster, now);
      return {
        id: `topic_${stableHash(cluster.articles.map((article) => article.contentHash).sort().join('|'))}`,
        title: cluster.articles[0].title,
        keywords: rankedTokens,
        ...scored,
        articles: cluster.articles,
        updatedAt: cluster.articles[0].publishedAt,
      };
    })
    .sort((a, b) => b.score - a.score || b.sourceCount - a.sourceCount);
}

export function isArticleInput(value: unknown): value is ArticleInput {
  if (!value || typeof value !== 'object') return false;
  const input = value as Partial<ArticleInput>;
  return typeof input.source === 'string' && typeof input.title === 'string' && typeof input.url === 'string' &&
    typeof input.publishedAt === 'string' && SOURCE_TYPES.includes(input.sourceType as SourceType);
}
