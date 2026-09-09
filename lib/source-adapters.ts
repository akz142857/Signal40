import type { ArticleInput, SourceType } from './domain.ts';
import { isPrivateHostname } from './net-guard.ts';
import { isValidCron } from './schedule.ts';
import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { sha256Hex } from './hash.ts';
import {
  SOURCE_RIGHTS_STATUSES,
  type SourceRightsStatus,
} from './source-lifecycle-status.ts';
import type { NormalizedSourceItem } from './source-normalized-item.ts';

export type SourceAdapterName = 'rss' | 'http' | 'web' | 'social' | 'csv';

export type SocialDiscoveryMode = 'opencli' | 'rss';

export type HttpJsonPaginationConfig = {
  mode: 'none' | 'page' | 'cursor' | 'since';
  /** 每次运行的硬页数上限；到达上限但上游仍声明有下一页时整次运行失败，不推进 checkpoint。 */
  maxPages?: number;
  pageParameter?: string;
  startPage?: number;
  pageSizeParameter?: string;
  pageSize?: number;
  cursorParameter?: string;
  /** 从响应 JSON 中读取下一游标的点路径。 */
  cursorPath?: string;
  sinceParameter?: string;
  /** 可选布尔/0/1 字段；明确为 false 时停止翻页。 */
  hasMorePath?: string;
};

export type SourceConfigInput = {
  name: string;
  adapter: SourceAdapterName;
  sourceType: SourceType;
  url?: string;
  scheduleCron?: string | null;
  rightsStatus: SourceRightsStatus;
  rateLimitPerMinute?: number;
  retention?: { mode: 'metadata' | 'raw'; days: number };
  mapping?: Record<string, string>;
  pagination?: HttpJsonPaginationConfig;
  /** 社交平台发现策略：OpenCLI 按账号搜索，或读取第三方 RSSHub/Feed。 */
  discoveryMode?: SocialDiscoveryMode;
  accountName?: string;
  searchLimit?: number;
  namespace?: string;
  connectorId?: string;
  connectorVersion?: string;
};

export function normalizeSourceRuntimeConfig(input: SourceConfigInput) {
  const normalizedUrl = input.url ? assertPublicHttpUrl(input.url) : '';
  const socialMaximum = input.namespace === 'wechat' ? 10 : input.namespace === 'xiaohongshu' ? 20 : 50;
  const socialLimit = Math.max(1, Math.min(socialMaximum, input.searchLimit ?? socialMaximum));
  return {
    sourceType: input.sourceType,
    url: normalizedUrl || undefined,
    mapping: input.mapping ?? {},
    pagination: input.adapter === 'http'
      ? (input.pagination ?? { mode: 'none' as const })
      : undefined,
    discoveryMode: input.adapter === 'social' ? input.discoveryMode : undefined,
    accountName: input.adapter === 'social' && input.discoveryMode === 'opencli'
      ? input.accountName?.trim()
      : undefined,
    searchLimit: input.adapter === 'social' && input.discoveryMode === 'opencli'
      ? socialLimit
      : undefined,
  };
}

export function sourceLocatorForConfig(input: SourceConfigInput) {
  const config = normalizeSourceRuntimeConfig(input);
  return input.adapter === 'social' && input.discoveryMode === 'opencli'
    ? { kind: 'account-search', platform: input.namespace, accountName: config.accountName }
    : { kind: 'url', url: config.url };
}

const SENSITIVE_SOURCE_QUERY_NAME = /(?:^|[-_.])(access|auth|credential|key|pass(?:word)?|secret|sig(?:nature)?|token)(?:$|[-_.])/i;

export function assertPublicHttpUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('来源 URL 无效。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('来源 URL 必须使用 HTTP(S)。');
  if (isPrivateHostname(url.hostname)) throw new Error('来源 URL 不能指向本地或私有网络。');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('来源 URL 只允许标准 HTTP(S) 端口。');
  if (url.username || url.password) throw new Error('来源 URL 不能包含用户凭据。');
  if (url.hash) throw new Error('来源 URL 不能包含 fragment。');
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_SOURCE_QUERY_NAME.test(key) || key.toLowerCase().startsWith('x-amz-')) {
      throw new Error('公开来源 URL 不能包含访问密钥或签名 query。');
    }
  }
  return url.toString();
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    // 数字字符引用（&#8364; / &#x20AC;）在真实 RSS 里很常见，不解码会把
    // "€6.7B" 变成 "&#x20AC;6.7B" 一路带进标题、脚本和配音文本。
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const rssParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  isArray: (tagName) => tagName === 'item' || tagName === 'entry' || tagName === 'link',
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return decodeXml(String(value));
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(' ');
  const object = record(value);
  if (!object) return '';
  return text(object['#text'] ?? object.value ?? object.name ?? '');
}

function firstText(item: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = text(item[name]);
    if (value) return value;
  }
  return '';
}

function feedLink(value: unknown) {
  const links = Array.isArray(value) ? value : [value];
  for (const link of links) {
    if (typeof link === 'string' && link.trim()) return decodeXml(link);
    const object = record(link);
    if (!object) continue;
    const relation = typeof object['@_rel'] === 'string' ? object['@_rel'] : 'alternate';
    const href = typeof object['@_href'] === 'string' ? object['@_href'] : text(object);
    if ((!relation || relation === 'alternate') && href) return decodeXml(href);
  }
  return '';
}

export function parseRssFeed(
  xml: string,
  config: Pick<SourceConfigInput, 'name' | 'sourceType'> & { url?: string },
): ArticleInput[] {
  // 即使关闭实体处理，也显式拒绝 DTD，避免未来依赖配置变更重新引入实体扩展风险。
  if (/<!DOCTYPE/i.test(xml)) throw new Error('RSS/Atom 不允许包含 DOCTYPE。');
  let parsed: unknown;
  try {
    SyntaxValidator.validate(xml, {
      allowBooleanAttributes: false,
      invalidCharSequence: { comment: true, tagValue: true, attrLt: true },
    });
    parsed = rssParser.parse(xml);
  } catch {
    throw new Error('RSS/Atom XML 格式无效。');
  }
  const root = record(parsed);
  const rss = record(root?.rss);
  const channel = record(rss?.channel);
  const atom = record(root?.feed);
  const documentBase = typeof atom?.['@_base'] === 'string'
    ? atom['@_base']
    : config.url || feedLink(channel?.link) || feedLink(atom?.link);
  const candidates = channel?.item ?? atom?.entry ?? [];
  const items = Array.isArray(candidates) ? candidates : [candidates];
  return items.slice(0, 100).flatMap((candidate) => {
    const item = record(candidate);
    if (!item) return [];
    const title = firstText(item, ['title']);
    const link = feedLink(item.link) || firstText(item, ['guid', 'id']);
    const publishedAt = firstText(item, ['pubDate', 'published', 'updated', 'date']);
    if (!title || !link || !publishedAt) return [];
    try {
      const timestamp = new Date(publishedAt);
      if (Number.isNaN(timestamp.valueOf())) return [];
      const itemBase = typeof item['@_base'] === 'string' ? item['@_base'] : documentBase;
      const url = itemBase ? new URL(link, itemBase).toString() : link;
      return [{
        id: firstText(item, ['guid', 'id']) || undefined,
        source: config.name,
        sourceType: config.sourceType,
        title,
        summary: firstText(item, ['description', 'summary', 'content', 'encoded']),
        author: firstText(item, ['author', 'creator']),
        url: assertPublicHttpUrl(url),
        publishedAt: timestamp.toISOString(),
      }];
    } catch { return []; }
  });
}

function decodeHtml(value: string) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function webArticleFromRecord(
  value: Record<string, unknown>,
  config: Pick<SourceConfigInput, 'name' | 'sourceType'> & { url: string },
  observedAt: string,
) {
  const type = stringValue(value['@type']).toLowerCase();
  if (!['article', 'newsarticle', 'blogposting', 'socialmediaposting'].includes(type)) return null;
  const title = (stringValue(value.headline) || stringValue(value.name)).trim();
  const urlValue = value.url ?? (record(value.mainEntityOfPage)?.['@id']);
  if (!title || typeof urlValue !== 'string') return null;
  const published = stringValue(value.datePublished) || stringValue(value.dateModified) || observedAt;
  const publishedAt = new Date(published);
  if (Number.isNaN(publishedAt.valueOf())) return null;
  const authorValue = Array.isArray(value.author) ? value.author[0] : value.author;
  const author = typeof authorValue === 'string'
    ? authorValue
    : stringValue(record(authorValue)?.name);
  try {
    return {
      source: config.name,
      sourceType: config.sourceType,
      title: decodeHtml(title),
      summary: decodeHtml(stringValue(value.description)),
      author: decodeHtml(author),
      url: assertPublicHttpUrl(new URL(urlValue, config.url).toString()),
      publishedAt: publishedAt.toISOString(),
    } satisfies ArticleInput;
  } catch {
    return null;
  }
}

/**
 * 公开网页/热榜的轻量解析器：优先读标准 JSON-LD，没有结构化数据时
 * 回退到同页链接列表。它不执行 JavaScript，不绕过登录、验证码或反自动化保护。
 */
export function parsePublicWebPage(
  html: string,
  config: Pick<SourceConfigInput, 'name' | 'sourceType'> & { url: string },
  observedAt = new Date().toISOString(),
): ArticleInput[] {
  if (html.length > 5_000_000) throw new Error('网页响应超过 5 MB。');
  const articles: ArticleInput[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1].trim());
      const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const current = queue.shift();
        if (Array.isArray(current)) { queue.push(...current); continue; }
        const object = record(current);
        if (!object) continue;
        if (Array.isArray(object['@graph'])) queue.push(...object['@graph']);
        if (Array.isArray(object.itemListElement)) {
          for (const entry of object.itemListElement) queue.push(record(entry)?.item ?? entry);
        }
        const article = webArticleFromRecord(object, config, observedAt);
        if (article && !seen.has(article.url)) {
          seen.add(article.url);
          articles.push(article);
        }
      }
    } catch { /* 无效 JSON-LD 不阻断链接回退。 */ }
  }
  if (articles.length) return articles.slice(0, 100);
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = decodeHtml(match[2]);
    if (title.length < 4 || title.length > 300) continue;
    try {
      const url = assertPublicHttpUrl(new URL(match[1], config.url).toString());
      if (seen.has(url)) continue;
      seen.add(url);
      articles.push({
        source: config.name,
        sourceType: config.sourceType,
        title,
        summary: '',
        author: '',
        url,
        publishedAt: observedAt,
      });
      if (articles.length >= 100) break;
    } catch { /* 跳过非 HTTP、私网或敏感链接。 */ }
  }
  return articles;
}

export function readJsonPath(value: unknown, path: string) {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function mapHttpJson(payload: unknown, config: SourceConfigInput): ArticleInput[] {
  return mapHttpJsonPage(payload, config).articles;
}

export type SourceItemRejection = {
  itemIndex: number;
  platformItemId: string | null;
  errorCode: 'INVALID_ITEM';
  detailRedacted: string;
  payloadHash: string;
};

export function mapHttpJsonPage(payload: unknown, config: SourceConfigInput) {
  const mapping = { items: 'items', id: 'id', kind: 'kind', title: 'title', summary: 'summary', url: 'url', publishedAt: 'publishedAt', updatedAt: 'updatedAt', deletedAt: 'deletedAt', author: 'author', ...config.mapping };
  const items = readJsonPath(payload, mapping.items);
  if (!Array.isArray(items)) throw new Error(`HTTP JSON 路径 ${mapping.items} 不是数组。`);
  if (items.length > 100) throw new Error('HTTP JSON 单页不能超过 100 条；请配置上游 pageSize。');
  const articles: ArticleInput[] = [];
  const normalizedItems: NormalizedSourceItem[] = [];
  const rejections: SourceItemRejection[] = [];
  for (const [index, item] of items.entries()) {
    const platformItemId = stringValue(readJsonPath(item, mapping.id ?? 'id')) || null;
    try {
      const declaredKind = stringValue(readJsonPath(item, mapping.kind));
      if (declaredKind && declaredKind !== 'upsert' && declaredKind !== 'tombstone') throw new Error('kind 必须是 upsert 或 tombstone');
      if (declaredKind === 'tombstone') {
        const deletedAt = stringValue(readJsonPath(item, mapping.deletedAt));
        const timestamp = new Date(deletedAt);
        if (!platformItemId) throw new Error('tombstone 缺少稳定 id');
        if (Number.isNaN(timestamp.valueOf())) throw new Error('deletedAt 不是有效时间');
        normalizedItems.push({
          kind: 'tombstone',
          namespace: config.namespace ?? config.adapter,
          platformItemId,
          deletedAt: timestamp.toISOString(),
          provenance: {
            connectorId: config.connectorId ?? `${config.adapter}-v1`,
            connectorVersion: config.connectorVersion ?? '1',
            observedAt: timestamp.toISOString(),
          },
          identityStrategy: 'platform_id',
          identityConfidence: 'high',
        });
        continue;
      }
      const title = readJsonPath(item, mapping.title);
      const url = readJsonPath(item, mapping.url);
      const publishedAt = readJsonPath(item, mapping.publishedAt);
      if (typeof title !== 'string' || typeof url !== 'string' || typeof publishedAt !== 'string') throw new Error('缺少 title、url 或 publishedAt');
      const timestamp = new Date(publishedAt);
      if (Number.isNaN(timestamp.valueOf())) throw new Error('publishedAt 不是有效时间');
      const canonicalUrl = assertPublicHttpUrl(url);
      const identity = platformItemId ?? sha256Hex(canonicalUrl);
      const updatedAtValue = stringValue(readJsonPath(item, mapping.updatedAt));
      const updatedAt = updatedAtValue ? new Date(updatedAtValue) : null;
      if (updatedAt && Number.isNaN(updatedAt.valueOf())) throw new Error('updatedAt 不是有效时间');
      const article: ArticleInput = {
        id: platformItemId ?? undefined,
        source: config.name,
        sourceType: config.sourceType,
        title,
        summary: stringValue(readJsonPath(item, mapping.summary)),
        author: stringValue(readJsonPath(item, mapping.author)),
        url: canonicalUrl,
        publishedAt: timestamp.toISOString(),
      };
      articles.push(article);
      normalizedItems.push({
        kind: 'upsert',
        namespace: config.namespace ?? config.adapter,
        platformItemId: identity,
        title,
        summary: article.summary,
        author: article.author,
        url: canonicalUrl,
        publishedAt: timestamp.toISOString(),
        updatedAt: updatedAt?.toISOString(),
        metrics: article.metrics,
        provenance: {
          connectorId: config.connectorId ?? `${config.adapter}-v1`,
          connectorVersion: config.connectorVersion ?? '1',
          observedAt: updatedAt?.toISOString() ?? timestamp.toISOString(),
        },
        identityStrategy: platformItemId ? 'platform_id' : 'canonical_url',
        identityConfidence: platformItemId ? 'high' : 'medium',
        canonicalUrlVersion: 'url-v1',
        contentFingerprintVersion: 'content-v1',
      });
    } catch (error) {
      rejections.push({
        itemIndex: index,
        platformItemId,
        errorCode: 'INVALID_ITEM',
        detailRedacted: (error instanceof Error ? error.message : '条目无效').slice(0, 200),
        payloadHash: sha256Hex(JSON.stringify(item)),
      });
    }
  }
  return { articles, items: normalizedItems, rejections, fetchedCount: items.length };
}

export function validateSourceConfig(input: SourceConfigInput, requireApproved = true) {
  const errors: string[] = [];
  if (!input.name?.trim() || input.name.length > 160) errors.push('来源名称必须为 1–160 个字符');
  if (!['rss', 'http', 'web', 'social', 'csv'].includes(input.adapter)) errors.push('适配器无效');
  if (['rss', 'http', 'web'].includes(input.adapter)) {
    try { if (!input.url) throw new Error(); else assertPublicHttpUrl(input.url); } catch { errors.push('RSS/HTTP/网页适配器必须提供公网 HTTP(S) URL'); }
  }
  if (input.adapter === 'social') {
    if (!['opencli', 'rss'].includes(input.discoveryMode ?? '')) {
      errors.push('社交来源必须选择 opencli 或 rss 发现策略');
    } else if (input.discoveryMode === 'opencli') {
      if (!input.accountName?.trim() || input.accountName.trim().length > 100) {
        errors.push('OpenCLI 社交来源必须提供 1–100 个字符的账号名称');
      }
      if (input.url) {
        try { assertPublicHttpUrl(input.url); } catch { errors.push('OpenCLI 种子文章 URL 必须是公网 HTTP(S) URL'); }
      }
      const maximum = input.namespace === 'wechat' ? 10 : input.namespace === 'xiaohongshu' ? 20 : 50;
      if (input.searchLimit !== undefined && (!Number.isInteger(input.searchLimit) || input.searchLimit < 1 || input.searchLimit > maximum)) {
        errors.push(`searchLimit 必须为 1–${maximum} 的整数`);
      }
    } else {
      try { if (!input.url) throw new Error(); else assertPublicHttpUrl(input.url); } catch { errors.push('第三方 RSS 策略必须提供公网 HTTP(S) Feed URL'); }
    }
  }
  if (input.scheduleCron && !isValidCron(input.scheduleCron)) errors.push('scheduleCron 格式无效或超出取值范围');
  if (!(SOURCE_RIGHTS_STATUSES as readonly string[]).includes(input.rightsStatus)) errors.push('rightsStatus 无效');
  else if (requireApproved && input.rightsStatus !== 'approved') errors.push('只有 rightsStatus=approved 的来源可以启用采集');
  if (input.rateLimitPerMinute !== undefined && (!Number.isInteger(input.rateLimitPerMinute) || input.rateLimitPerMinute < 1 || input.rateLimitPerMinute > 600)) errors.push('rateLimitPerMinute 必须为 1–600 的整数');
  if (input.retention && (!['metadata', 'raw'].includes(input.retention.mode) || !Number.isInteger(input.retention.days) || input.retention.days < 1 || input.retention.days > 3650)) errors.push('retention 必须指定 metadata/raw 和 1–3650 天');
  if (input.pagination) {
    const pagination = input.pagination;
    const parameterValid = (value: string | undefined) => value === undefined || /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value);
    const pathValid = (value: string | undefined) => value === undefined || /^[A-Za-z0-9_$-]+(?:\.[A-Za-z0-9_$-]+)*$/.test(value);
    if (input.adapter !== 'http') errors.push('只有 HTTP JSON 来源可以配置 pagination');
    if (!['none', 'page', 'cursor', 'since'].includes(pagination.mode)) errors.push('pagination.mode 无效');
    if (pagination.maxPages !== undefined && (!Number.isInteger(pagination.maxPages) || pagination.maxPages < 1 || pagination.maxPages > 20)) errors.push('pagination.maxPages 必须为 1–20 的整数');
    if (pagination.startPage !== undefined && (!Number.isInteger(pagination.startPage) || pagination.startPage < 0 || pagination.startPage > 1_000_000)) errors.push('pagination.startPage 必须为 0–1000000 的整数');
    if (pagination.pageSize !== undefined && (!Number.isInteger(pagination.pageSize) || pagination.pageSize < 1 || pagination.pageSize > 100)) errors.push('pagination.pageSize 必须为 1–100 的整数');
    if (![pagination.pageParameter, pagination.pageSizeParameter, pagination.cursorParameter, pagination.sinceParameter].every(parameterValid)) errors.push('pagination 查询参数名无效');
    if (![pagination.cursorPath, pagination.hasMorePath].every(pathValid)) errors.push('pagination 响应字段路径无效');
    if (pagination.mode === 'cursor' && !pagination.cursorPath) errors.push('cursor 分页必须配置 cursorPath');
    if (pagination.mode === 'since' && pagination.cursorPath && !pagination.cursorParameter) errors.push('since 分页配置 cursorPath 时必须同时配置 cursorParameter');
  }
  return { valid: errors.length === 0, errors };
}
