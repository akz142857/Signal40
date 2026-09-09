import type { Article } from './domain.ts';
import type { EvidenceRelationship } from './social-evidence.ts';

export type RelationshipClassification = {
  relationship: EvidenceRelationship;
  confidence: number;
  reason: string;
};

function normalizedHosts(identifiers: Record<string, string>) {
  const hosts = new Set<string>();
  for (const [key, value] of Object.entries(identifiers)) {
    if (!/(?:website|domain|homepage|url)/i.test(key)) continue;
    const candidate = value.trim().toLowerCase();
    if (!candidate) continue;
    try {
      hosts.add(new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname.replace(/^www\./, ''));
    } catch { /* 非站点标识不参与 host 判定。 */ }
  }
  return hosts;
}

/**
 * 可解释的保守关系分类器。只有发布主体登记的 host 与内容 URL 一致且
 * 没有转载信号时才判为 original；其他不确定情形始终返回 unknown。
 */
export function classifyOriginRelationship(
  article: Pick<Article, 'url' | 'title' | 'summary' | 'author'>,
  publisherIdentifiers: Record<string, string> = {},
): RelationshipClassification {
  const text = `${article.title}\n${article.summary ?? ''}\n${article.author ?? ''}`.toLowerCase();
  if (/(?:授权转载|联播|同步刊发|syndicat(?:ed|ion))/.test(text)) {
    return { relationship: 'syndicated', confidence: 90, reason: 'content-marker:syndicated' };
  }
  if (/(?:转载自|转自|原文来自|来源：|\brepost(?:ed)?\b|\bvia\s+@)/.test(text)) {
    return { relationship: 'repost', confidence: 95, reason: 'content-marker:repost' };
  }
  if (/(?:据.{1,30}(?:表示|报道|称)|\baccording to\b|\bquoted?\b)/.test(text)) {
    return { relationship: 'quote', confidence: 75, reason: 'content-marker:quote' };
  }
  try {
    const articleHost = new URL(article.url).hostname.toLowerCase().replace(/^www\./, '');
    if (normalizedHosts(publisherIdentifiers).has(articleHost)) {
      return { relationship: 'original', confidence: 95, reason: 'publisher-host-match' };
    }
  } catch { /* URL 在更早的入口校验；这里仍然失败关闭。 */ }
  return { relationship: 'unknown', confidence: 0, reason: 'insufficient-signals' };
}
