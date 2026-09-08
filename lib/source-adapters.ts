import type { ArticleInput, SourceType } from './domain.ts';
import { isPrivateHostname } from './net-guard.ts';
import { isValidCron } from './schedule.ts';

export type SourceAdapterName = 'rss' | 'http' | 'opencli' | 'csv';

export type SourceConfigInput = {
  name: string;
  adapter: SourceAdapterName;
  sourceType: SourceType;
  url?: string;
  scheduleCron?: string | null;
  rightsStatus: 'approved' | 'restricted' | 'blocked';
  rateLimitPerMinute?: number;
  retention?: { mode: 'metadata' | 'raw'; days: number };
  mapping?: Record<string, string>;
};

export function assertPublicHttpUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('来源 URL 无效。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('来源 URL 必须使用 HTTP(S)。');
  if (isPrivateHostname(url.hostname)) throw new Error('来源 URL 不能指向本地或私有网络。');
  url.username = '';
  url.password = '';
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

function element(block: string, names: string[]) {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
    if (match) return decodeXml(match[1]);
  }
  return '';
}

export function parseRssFeed(xml: string, config: Pick<SourceConfigInput, 'name' | 'sourceType'>): ArticleInput[] {
  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  return blocks.slice(0, 100).flatMap((block) => {
    const title = element(block, ['title']);
    const linkText = element(block, ['link']);
    const linkHref = /<link[^>]+href=["']([^"']+)["']/i.exec(block)?.[1];
    const publishedAt = element(block, ['pubDate', 'published', 'updated']);
    if (!title || !(linkHref || linkText) || !publishedAt) return [];
    try {
      return [{ source: config.name, sourceType: config.sourceType, title, summary: element(block, ['description', 'summary', 'content']), url: assertPublicHttpUrl(linkHref || linkText), publishedAt: new Date(publishedAt).toISOString() }];
    } catch { return []; }
  });
}

function readPath(value: unknown, path: string) {
  return path.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

export function mapHttpJson(payload: unknown, config: SourceConfigInput): ArticleInput[] {
  const mapping = { items: 'items', title: 'title', summary: 'summary', url: 'url', publishedAt: 'publishedAt', author: 'author', ...config.mapping };
  const items = readPath(payload, mapping.items);
  if (!Array.isArray(items)) throw new Error(`HTTP JSON 路径 ${mapping.items} 不是数组。`);
  return items.slice(0, 100).map((item, index) => {
    const title = readPath(item, mapping.title);
    const url = readPath(item, mapping.url);
    const publishedAt = readPath(item, mapping.publishedAt);
    if (typeof title !== 'string' || typeof url !== 'string' || typeof publishedAt !== 'string') throw new Error(`第 ${index + 1} 条缺少 title、url 或 publishedAt。`);
    return { source: config.name, sourceType: config.sourceType, title, summary: stringValue(readPath(item, mapping.summary)), author: stringValue(readPath(item, mapping.author)), url: assertPublicHttpUrl(url), publishedAt: new Date(publishedAt).toISOString() };
  });
}

export function validateSourceConfig(input: SourceConfigInput, requireApproved = true) {
  const errors: string[] = [];
  if (!input.name?.trim() || input.name.length > 160) errors.push('来源名称必须为 1–160 个字符');
  if (!['rss', 'http', 'opencli', 'csv'].includes(input.adapter)) errors.push('适配器无效');
  if (['rss', 'http'].includes(input.adapter)) {
    try { if (!input.url) throw new Error(); else assertPublicHttpUrl(input.url); } catch { errors.push('RSS/HTTP 适配器必须提供公网 HTTP(S) URL'); }
  }
  if (input.scheduleCron && !isValidCron(input.scheduleCron)) errors.push('scheduleCron 格式无效或超出取值范围');
  if (!['approved', 'restricted', 'blocked'].includes(input.rightsStatus)) errors.push('rightsStatus 无效');
  else if (requireApproved && input.rightsStatus !== 'approved') errors.push('只有 rightsStatus=approved 的来源可以启用采集');
  if (input.rateLimitPerMinute !== undefined && (!Number.isInteger(input.rateLimitPerMinute) || input.rateLimitPerMinute < 1 || input.rateLimitPerMinute > 600)) errors.push('rateLimitPerMinute 必须为 1–600 的整数');
  if (input.retention && (!['metadata', 'raw'].includes(input.retention.mode) || !Number.isInteger(input.retention.days) || input.retention.days < 1 || input.retention.days > 3650)) errors.push('retention 必须指定 metadata/raw 和 1–3650 天');
  return { valid: errors.length === 0, errors };
}
