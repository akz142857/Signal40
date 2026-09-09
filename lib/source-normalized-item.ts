import type { ArticleInput, SourceType } from './domain.ts';

export const SOURCE_IDENTITY_STRATEGIES = [
  'platform_id',
  'guid',
  'canonical_url',
  'content_fingerprint',
] as const;
export type SourceIdentityStrategy = (typeof SOURCE_IDENTITY_STRATEGIES)[number];

export const SOURCE_IDENTITY_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type SourceIdentityConfidence = (typeof SOURCE_IDENTITY_CONFIDENCES)[number];

export type SourceItemProvenance = {
  connectorId: string;
  connectorVersion: string;
  observedAt: string;
};

type NormalizedSourceIdentity = {
  namespace: string;
  platformItemId: string;
  provenance: SourceItemProvenance;
  identityStrategy: SourceIdentityStrategy;
  identityConfidence: SourceIdentityConfidence;
};

export type NormalizedSourceUpsert = NormalizedSourceIdentity & {
  kind: 'upsert';
  title: string;
  url: string;
  publishedAt: string;
  updatedAt?: string;
  author?: string;
  summary?: string;
  metrics?: ArticleInput['metrics'];
  canonicalUrlVersion: string;
  contentFingerprintVersion: string;
};

export type NormalizedSourceTombstone = NormalizedSourceIdentity & {
  kind: 'tombstone';
  deletedAt: string;
};

export type NormalizedSourceItem = NormalizedSourceUpsert | NormalizedSourceTombstone;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validDate(value: unknown) {
  return typeof value === 'string' && Number.isFinite(new Date(value).valueOf());
}

function boundedString(value: unknown, max: number) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function publicHttpUrl(value: unknown) {
  if (!boundedString(value, 2_000)) return false;
  try {
    const url = new URL(value as string);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Worker 提交边界的严格解析器。控制面从 source_config 注入 source/sourceType，
 * 所以 connector 不能借此声明 publisher/evidence/sourceType 等治理字段。
 */
export function parseNormalizedSourceItems(value: unknown): {
  items: NormalizedSourceItem[];
  issues: Array<{ index: number; issue: string }>;
} {
  if (!Array.isArray(value)) return { items: [], issues: [{ index: 0, issue: 'items 必须是数组' }] };
  const items: NormalizedSourceItem[] = [];
  const issues: Array<{ index: number; issue: string }> = [];
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) {
      issues.push({ index, issue: '条目必须是对象' });
      continue;
    }
    if (!isRecord(candidate.provenance)
      || !hasOnlyKeys(candidate.provenance, ['connectorId', 'connectorVersion', 'observedAt'])) {
      issues.push({ index, issue: 'provenance 结构无效' });
      continue;
    }
    const commonValid = boundedString(candidate.namespace, 80)
      && boundedString(candidate.platformItemId, 500)
      && SOURCE_IDENTITY_STRATEGIES.includes(candidate.identityStrategy as SourceIdentityStrategy)
      && SOURCE_IDENTITY_CONFIDENCES.includes(candidate.identityConfidence as SourceIdentityConfidence)
      && isRecord(candidate.provenance)
      && boundedString(candidate.provenance.connectorId, 80)
      && boundedString(candidate.provenance.connectorVersion, 40)
      && validDate(candidate.provenance.observedAt);
    if (!commonValid) {
      issues.push({ index, issue: '身份或 provenance 字段无效' });
      continue;
    }
    if (candidate.kind === 'tombstone') {
      if (!hasOnlyKeys(candidate, ['kind', 'namespace', 'platformItemId', 'deletedAt', 'provenance', 'identityStrategy', 'identityConfidence'])) {
        issues.push({ index, issue: 'tombstone 不接受正文、标题、URL 或治理字段' });
        continue;
      }
      if (!validDate(candidate.deletedAt)) {
        issues.push({ index, issue: 'tombstone.deletedAt 必须是有效时间' });
        continue;
      }
      const forbidden = ['title', 'url', 'publishedAt', 'updatedAt', 'author', 'summary', 'metrics', 'canonicalUrlVersion', 'contentFingerprintVersion'];
      if (forbidden.some((field) => candidate[field] !== undefined)) {
        issues.push({ index, issue: 'tombstone 不接受正文、标题或 URL 字段' });
        continue;
      }
      items.push(candidate as NormalizedSourceTombstone);
      continue;
    }
    if (candidate.kind !== 'upsert') {
      issues.push({ index, issue: 'kind 必须是 upsert 或 tombstone' });
      continue;
    }
    if (!hasOnlyKeys(candidate, ['kind', 'namespace', 'platformItemId', 'title', 'url', 'publishedAt', 'updatedAt', 'author', 'summary', 'metrics', 'provenance', 'identityStrategy', 'identityConfidence', 'canonicalUrlVersion', 'contentFingerprintVersion'])) {
      issues.push({ index, issue: 'upsert 包含未授权字段' });
      continue;
    }
    if (!boundedString(candidate.title, 500) || !publicHttpUrl(candidate.url)
      || !validDate(candidate.publishedAt)
      || (candidate.updatedAt !== undefined && !validDate(candidate.updatedAt))
      || !boundedString(candidate.canonicalUrlVersion, 40)
      || !boundedString(candidate.contentFingerprintVersion, 40)) {
      issues.push({ index, issue: 'upsert 内容或版本字段无效' });
      continue;
    }
    if (candidate.metrics !== undefined && (!isRecord(candidate.metrics)
      || !hasOnlyKeys(candidate.metrics, ['views', 'likes', 'recommends'])
      || Object.values(candidate.metrics).some((metric) => !Number.isSafeInteger(metric) || Number(metric) < 0))) {
      issues.push({ index, issue: 'metrics 字段无效' });
      continue;
    }
    items.push(candidate as NormalizedSourceUpsert);
  }
  return { items, issues };
}

export function sourceItemEventAt(item: NormalizedSourceItem) {
  return new Date(item.kind === 'tombstone' ? item.deletedAt : item.updatedAt ?? item.publishedAt).toISOString();
}

export function normalizedUpsertToArticle(
  item: NormalizedSourceUpsert,
  source: { name: string; sourceType: SourceType },
): ArticleInput {
  return {
    id: undefined,
    source: source.name,
    sourceType: source.sourceType,
    title: item.title,
    summary: item.summary,
    author: item.author,
    url: item.url,
    publishedAt: item.publishedAt,
    metrics: item.metrics,
  };
}
