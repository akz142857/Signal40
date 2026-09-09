import type { ArticleInput, SourceType } from './domain.ts';
import { assertPublicHttpUrl } from './source-adapters.ts';

type SocialPlatform = 'wechat' | 'xiaohongshu';

type SocialSearchConfig = {
  platform: SocialPlatform;
  name: string;
  sourceType: SourceType;
  accountName: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function first(...values: unknown[]) {
  for (const value of values) {
    const candidate = string(value);
    if (candidate) return candidate;
  }
  return '';
}

function resultRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = object(payload);
  if (!root) return [];
  for (const key of ['data', 'results', 'items', 'notes', 'list']) {
    const value = root[key];
    if (Array.isArray(value)) return value;
    const nested = object(value);
    if (nested) {
      for (const nestedKey of ['items', 'results', 'notes', 'list']) {
        if (Array.isArray(nested[nestedKey])) return nested[nestedKey] as unknown[];
      }
    }
  }
  return [];
}

function parsePublishedAt(value: unknown, observedAt: string) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(timestamp.valueOf()) ? observedAt : timestamp.toISOString();
  }
  const raw = string(value);
  if (!raw) return observedAt;
  const absolute = new Date(raw);
  if (!Number.isNaN(absolute.valueOf())) return absolute.toISOString();
  const base = new Date(observedAt);
  const relative = raw.match(/^(\d+)\s*(分钟|小时|天|周|个月|年)前$/);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs: Record<string, number> = {
      '分钟': 60_000, '小时': 3_600_000, '天': 86_400_000,
      '周': 604_800_000, '个月': 2_592_000_000, '年': 31_536_000_000,
    };
    return new Date(base.valueOf() - amount * unitMs[relative[2]]).toISOString();
  }
  if (raw.startsWith('昨天')) return new Date(base.valueOf() - 86_400_000).toISOString();
  if (/刚刚|分钟前/.test(raw)) return observedAt;
  return observedAt;
}

function socialUrl(row: Record<string, unknown>, platform: SocialPlatform) {
  const note = object(row.note_card) ?? object(row.noteCard);
  const direct = first(row.url, row.link, row.note_url, row.noteUrl, row.share_url, row.shareUrl, note?.url);
  if (direct) return direct;
  const id = first(row.note_id, row.noteId, row.id);
  return platform === 'xiaohongshu' && id ? `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}` : '';
}

/** 将 OpenCLI 的宽松 JSON 输出收敛为 Signal40 的受验证文章契约。 */
export function parseOpenCliSocialSearch(
  payload: unknown,
  config: SocialSearchConfig,
  observedAt = new Date().toISOString(),
): ArticleInput[] {
  const output: ArticleInput[] = [];
  const seen = new Set<string>();
  for (const value of resultRows(payload).slice(0, 100)) {
    const row = object(value);
    if (!row) continue;
    const note = object(row.note_card) ?? object(row.noteCard);
    const user = object(row.user) ?? object(note?.user);
    const title = first(row.title, row.display_title, row.displayTitle, row.name, note?.display_title, note?.title);
    const rawUrl = socialUrl(row, config.platform);
    if (!title || !rawUrl) continue;
    try {
      const url = assertPublicHttpUrl(rawUrl);
      if (seen.has(url)) continue;
      seen.add(url);
      output.push({
        id: first(row.note_id, row.noteId, row.id) || undefined,
        source: config.name,
        sourceType: config.sourceType,
        title: title.slice(0, 300),
        summary: first(row.summary, row.desc, row.description, note?.desc).slice(0, 4_000),
        // 搜索词不是发布主体证明；OpenCLI 未返回作者时保持为空，避免把候选误标为原始来源。
        author: first(row.author, row.account, row.nickname, user?.nickname, user?.name),
        url,
        publishedAt: parsePublishedAt(
          row.publish_time ?? row.publishTime ?? row.published_at ?? row.publishedAt ?? row.create_time ?? row.createTime ?? row.time,
          observedAt,
        ),
      });
    } catch { /* 丢弃无效、私网或带凭据的 URL。 */ }
  }
  return output;
}

export function openCliSocialArgs(platform: SocialPlatform, accountName: string, limit: number) {
  return [platform === 'wechat' ? 'weixin' : 'xiaohongshu', 'search', accountName, '--limit', String(limit), '--format', 'json'];
}
