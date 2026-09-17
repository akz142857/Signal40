/**
 * 主题领域：自动化允许生产的内容范围。
 *
 * 取代 `lib/domain.ts` 里写死的 `FINANCE_TERMS`。词表有两个改不掉的毛病：
 *
 * 1. **和语言绑死**——命中靠子串匹配，中文词表在英文语料上必然命中 0 个，
 *    于是「这条英文选题跑题吗」和「这条选题是英文吗」被判成了同一件事；
 * 2. **和部署绑死**——词表是源码常量，换一个领域要改代码、发一次版。
 *
 * 领域改成一段自然语言描述，嵌成中心向量，选题与它比余弦。语言无关，
 * 领域可配置，判定口径和簇内一致性完全相同（都是 `cosineSimilarity`）。
 *
 * 可以配多个领域（比如财经 + AI），选题命中任意一个即算在范围内，
 * 记下命中的是哪个、余弦是多少——「为什么这条能自动生产」因此是可解释的。
 */

import {
  cosineSimilarity,
  isComparableEmbedding,
  parseEmbedding,
} from './embedding.ts';
import { stableHash } from './hash.ts';

/** 领域相关性的默认余弦下限。 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.3;

export type TopicDomain = {
  id: string;
  name: string;
  description: string;
  descriptionHash: string;
  centroid: number[];
  centroidSourceHash: string;
  centroidModel: string;
  centroidVersion: number;
  relevanceThreshold: number;
  enabled: boolean;
};

export type DomainRelevance = {
  /** 命中的领域 id；没有任何领域可判定时为空串。 */
  domainId: string;
  domainName: string;
  /** 与最相近领域中心向量的余弦；无法判定时为 0。 */
  relevance: number;
  threshold: number;
  /** 是否落在某个领域范围内。 */
  inScope: boolean;
  /**
   * 判定状态。`unavailable` 表示「没有可用的领域中心向量或选题向量」——
   * 这和「算过了、确实跑题」是两回事，前者不该被解释成后者。
   */
  status: 'evaluated' | 'unavailable' | 'no_domains';
};

/** 中心向量是否与描述同步：改了描述而没重算中心向量，旧向量代表的是旧领域。 */
export function isCentroidCurrent(
  domain: Pick<
    TopicDomain,
    'descriptionHash' | 'centroidSourceHash' | 'centroid'
  >,
) {
  return Boolean(
    domain.centroid.length &&
    domain.centroidSourceHash === domain.descriptionHash,
  );
}

/**
 * 可用于判定的领域：启用、中心向量与描述同步、且模型口径与选题向量一致。
 * 模型不一致的中心向量不能和文章向量比余弦——那是两个空间里的点。
 */
export function usableDomains(
  domains: readonly TopicDomain[],
  model: string,
  version: number,
) {
  return domains.filter(
    (domain) =>
      domain.enabled &&
      isCentroidCurrent(domain) &&
      domain.centroidModel === model &&
      domain.centroidVersion === version,
  );
}

/**
 * 选题向量与各领域中心向量比余弦，取最相近的一个。
 *
 * 判定不了时 **fail closed**：返回 `inScope: false` 且 `status` 说明原因。
 * 一条判定不了的选题不该因为「没证据说它跑题」就被放进自动生产。
 */
export function evaluateDomainRelevance(
  topicVector: readonly number[],
  domains: readonly TopicDomain[],
  model: string,
  version: number,
): DomainRelevance {
  const candidates = usableDomains(domains, model, version);
  if (!candidates.length) {
    return {
      domainId: '',
      domainName: '',
      relevance: 0,
      threshold: DEFAULT_RELEVANCE_THRESHOLD,
      inScope: false,
      status: domains.length ? 'unavailable' : 'no_domains',
    };
  }
  if (!topicVector.length) {
    return {
      domainId: '',
      domainName: '',
      relevance: 0,
      threshold: candidates[0].relevanceThreshold,
      inScope: false,
      status: 'unavailable',
    };
  }
  let best = candidates[0];
  let bestRelevance = cosineSimilarity(topicVector, candidates[0].centroid);
  for (const domain of candidates.slice(1)) {
    const relevance = cosineSimilarity(topicVector, domain.centroid);
    if (relevance > bestRelevance) {
      best = domain;
      bestRelevance = relevance;
    }
  }
  const relevance = Math.round(bestRelevance * 1000) / 1000;
  return {
    domainId: best.id,
    domainName: best.name,
    relevance,
    threshold: best.relevanceThreshold,
    inScope: relevance >= best.relevanceThreshold,
    status: 'evaluated',
  };
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

/** 数据库行 → 领域对象。阈值存成字符串是为了不引入 numeric 的精度歧义。 */
export function rowToTopicDomain(row: Record<string, unknown>): TopicDomain {
  const threshold = Number(row.relevance_threshold);
  return {
    id: text(row.id),
    name: text(row.name),
    description: text(row.description),
    descriptionHash: text(row.description_hash),
    centroid: parseEmbedding(text(row.centroid_json)),
    centroidSourceHash: text(row.centroid_source_hash),
    centroidModel: text(row.centroid_model),
    centroidVersion: Number(row.centroid_version ?? 0),
    relevanceThreshold: Number.isFinite(threshold)
      ? threshold
      : DEFAULT_RELEVANCE_THRESHOLD,
    enabled: text(row.enabled) === 'true',
  };
}

/** 判定「这个领域的中心向量需要重算吗」——新建、改过描述、或换过模型口径。 */
export function needsCentroidRefresh(
  domain: TopicDomain,
  model: string,
  version: number,
) {
  return (
    !isCentroidCurrent(domain) ||
    !isComparableEmbedding(
      {
        embedding: domain.centroid,
        embeddingModel: domain.centroidModel,
        embeddingVersion: domain.centroidVersion,
      },
      model,
      version,
    )
  );
}

/**
 * 读取全部领域配置。
 *
 * 判定「这条选题在不在生产范围内」时每轮都要读，数量是人工维护的个位数量级，
 * 没有分页；真的多到需要分页时，说明领域定义本身出了问题。
 */
export async function loadTopicDomains(db: {
  prepare: (sql: string) => {
    all: <T = Record<string, unknown>>() => Promise<{ results: T[] }>;
  };
}) {
  const result = await db
    .prepare(`
      SELECT id, name, description, description_hash, centroid_json, centroid_source_hash,
             centroid_model, centroid_version, relevance_threshold, enabled
      FROM topic_domains
      ORDER BY name ASC
    `)
    .all<Record<string, unknown>>();
  return result.results.map(rowToTopicDomain);
}

/**
 * 当前领域配置的指纹：参与判定的每个字段都进去。
 *
 * `quality_json` 是一份快照，而快照的前提会变——停用领域、改阈值、改描述
 * 都会让旧的门禁结论失去依据。把这个哈希一并落库，编排引擎才判得出
 * 「这条结论依据的配置还是现在这套吗」，而不是让过期结论无限期有效。
 */
export function domainConfigHash(domains: readonly TopicDomain[]) {
  return stableHash(
    domains
      .filter((domain) => domain.enabled)
      .map((domain) => ({
        id: domain.id,
        descriptionHash: domain.descriptionHash,
        centroidSourceHash: domain.centroidSourceHash,
        centroidModel: domain.centroidModel,
        centroidVersion: domain.centroidVersion,
        relevanceThreshold: domain.relevanceThreshold,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  );
}
