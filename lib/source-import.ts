import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';
import { parseCsvRows, isSourceType } from './import.ts';
import { assertPublicHttpUrl, type SourceAdapterName } from './source-adapters.ts';
import { isValidCron } from './schedule.ts';
import type { SourceType } from './domain.ts';
import type { SqlDatabase } from './sql.ts';
import { sourceConnectorByPlatform } from './source-connectors/registry.ts';
import { stableHash } from './workflow.ts';
import { createPendingSourceRightsRequest } from './source-rights-approval.ts';

const MAX_SOURCE_IMPORTS = 100;

export type SourceImportCandidate = {
  row: number;
  name: string;
  adapter: Extract<SourceAdapterName, 'rss' | 'http'>;
  platform: 'rss' | 'http_json';
  sourceType: SourceType;
  url: string;
  scheduleCron: string | null;
};

export type SourceImportIssue = { row: number; message: string };

type RawCandidate = {
  row: number;
  name?: unknown;
  url?: unknown;
  platform?: unknown;
  sourceType?: unknown;
  scheduleCron?: unknown;
};

const opmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tagName) => tagName === 'outline',
});

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function opmlCandidates(input: string): RawCandidate[] {
  if (/<!DOCTYPE/i.test(input)) throw new Error('OPML 不允许包含 DOCTYPE。');
  let parsed: unknown;
  try {
    SyntaxValidator.validate(input, { allowBooleanAttributes: false });
    parsed = opmlParser.parse(input);
  } catch {
    throw new Error('OPML XML 格式无效。');
  }
  const root = record(parsed);
  const body = record(record(root?.opml)?.body);
  if (!body) throw new Error('OPML 缺少 opml/body。');
  const result: RawCandidate[] = [];
  const visit = (value: unknown) => {
    for (const entry of Array.isArray(value) ? value : [value]) {
      const outline = record(entry);
      if (!outline) continue;
      const url = outline['@_xmlUrl'] ?? outline['@_xmlurl'];
      if (url !== undefined) {
        result.push({
          row: result.length + 1,
          name: outline['@_title'] ?? outline['@_text'],
          url,
          platform: 'rss',
        });
      }
      if (outline.outline) visit(outline.outline);
    }
  };
  visit(body.outline);
  if (!result.length) throw new Error('OPML 中没有包含 xmlUrl 的订阅来源。');
  return result;
}

function csvCandidates(input: string): RawCandidate[] {
  const rows = parseCsvRows(input.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('来源 CSV 至少需要表头和一行数据。');
  const headers = rows[0].map((value) => value.trim());
  const urlIndex = headers.findIndex((value) => value.toLowerCase() === 'url');
  if (urlIndex < 0) throw new Error('来源 CSV 缺少 url 表头。');
  const indexOf = (name: string) => headers.findIndex((value) => value.toLowerCase() === name.toLowerCase());
  const valueAt = (values: string[], name: string) => {
    const index = indexOf(name);
    return index < 0 ? undefined : values[index];
  };
  return rows.slice(1).map((values, index) => ({
    row: index + 2,
    name: valueAt(values, 'name'),
    url: values[urlIndex],
    platform: valueAt(values, 'platform') ?? valueAt(values, 'adapter'),
    sourceType: valueAt(values, 'sourceType'),
    scheduleCron: valueAt(values, 'scheduleCron'),
  }));
}

function jsonCandidates(input: string): RawCandidate[] {
  let parsed: unknown;
  try { parsed = JSON.parse(input) as unknown; }
  catch { throw new Error('来源 JSON 格式无效。'); }
  const rows = Array.isArray(parsed) ? parsed : record(parsed)?.sources;
  if (!Array.isArray(rows)) throw new Error('来源 JSON 必须是数组或包含 sources 数组的对象。');
  return rows.map((value, index) => ({ row: index + 1, ...record(value) }));
}

function lineCandidates(input: string): RawCandidate[] {
  return input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const columns = line.split('\t').map((value) => value.trim());
    return columns.length > 1
      ? { row: index + 1, name: columns[0], url: columns[1] }
      : { row: index + 1, url: columns[0] };
  });
}

function normalizePlatform(value: unknown, fallback: 'rss' | 'http_json') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return fallback;
  if (['rss', 'atom', 'feed'].includes(normalized)) return 'rss' as const;
  if (['http', 'http_json', 'json', 'api'].includes(normalized)) return 'http_json' as const;
  throw new Error(`不支持的平台 ${normalized}`);
}

export function parseSourceImport(
  input: string,
  defaults: { platform?: 'rss' | 'http_json'; sourceType?: SourceType; scheduleCron?: string | null } = {},
) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('请粘贴 OPML、来源 CSV、JSON 或逐行 URL。');
  if (new TextEncoder().encode(trimmed).byteLength > 1_000_000) throw new Error('来源导入内容不能超过 1 MB。');
  let raw: RawCandidate[];
  if (trimmed.startsWith('<')) raw = opmlCandidates(trimmed);
  else if (trimmed.startsWith('[') || trimmed.startsWith('{')) raw = jsonCandidates(trimmed);
  else {
    const firstLine = trimmed.split(/\r?\n/, 1)[0].toLowerCase();
    raw = firstLine.split(',').some((value) => value.trim() === 'url') ? csvCandidates(trimmed) : lineCandidates(trimmed);
  }
  if (raw.length > MAX_SOURCE_IMPORTS) throw new Error(`每次最多导入 ${MAX_SOURCE_IMPORTS} 个来源。`);

  const candidates: SourceImportCandidate[] = [];
  const issues: SourceImportIssue[] = [];
  const seenUrls = new Set<string>();
  for (const item of raw) {
    try {
      if (typeof item.url !== 'string' || !item.url.trim()) throw new Error('缺少 URL');
      const url = assertPublicHttpUrl(item.url.trim());
      if (seenUrls.has(url)) throw new Error('本批次中 URL 重复');
      const platform = normalizePlatform(item.platform, defaults.platform ?? 'rss');
      const sourceTypeValue = typeof item.sourceType === 'string' && item.sourceType.trim() ? item.sourceType.trim() : defaults.sourceType ?? 'media';
      if (!isSourceType(sourceTypeValue)) throw new Error(`sourceType ${sourceTypeValue} 无效`);
      const scheduleCron = typeof item.scheduleCron === 'string' && item.scheduleCron.trim()
        ? item.scheduleCron.trim()
        : defaults.scheduleCron ?? null;
      if (scheduleCron && !isValidCron(scheduleCron)) throw new Error('scheduleCron 无效');
      const fallbackName = new URL(url).hostname;
      const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : fallbackName;
      if (name.length > 160) throw new Error('名称不能超过 160 个字符');
      seenUrls.add(url);
      candidates.push({
        row: item.row,
        name,
        adapter: platform === 'rss' ? 'rss' : 'http',
        platform,
        sourceType: sourceTypeValue,
        url,
        scheduleCron,
      });
    } catch (error) {
      issues.push({ row: item.row, message: error instanceof Error ? error.message : '来源格式无效' });
    }
  }
  return { candidates, issues, total: raw.length };
}

export async function persistSourceImportDrafts(
  db: SqlDatabase,
  input: {
    actor: { id: string; role: string };
    candidates: SourceImportCandidate[];
    idempotencyKey: string;
    now?: Date;
  },
) {
  const now = (input.now ?? new Date()).toISOString();
  const created: Array<{ row: number; sourceId: string; name: string }> = [];
  const skipped: Array<{ row: number; sourceId: string; name: string; reason: 'already_exists' }> = [];
  for (const candidate of input.candidates) {
    const config = {
      sourceType: candidate.sourceType,
      url: candidate.url,
      mapping: {},
      pagination: candidate.adapter === 'http' ? { mode: 'none' as const } : undefined,
    };
    const locator = { kind: 'url', url: candidate.url };
    const locatorHash = stableHash({ teamId: 'default', platform: candidate.platform, locator });
    const existing = await db.prepare(`
      SELECT id FROM source_configs
      WHERE team_id = 'default' AND platform = ?
        AND (locator_hash = ? OR locator_json ->> 'url' = ?)
      LIMIT 1
    `).bind(candidate.platform, locatorHash, candidate.url).first<{ id: string }>();
    if (existing) {
      skipped.push({ row: candidate.row, sourceId: existing.id, name: candidate.name, reason: 'already_exists' });
      continue;
    }
    const sourceId = `source_${crypto.randomUUID()}`;
    const configHash = stableHash({ platform: candidate.platform, adapter: candidate.adapter, config });
    const rightsConfigHash = stableHash({
      platform: candidate.platform,
      adapter: candidate.adapter,
      config,
      retention: { mode: 'metadata', days: 30 },
    });
    const connector = sourceConnectorByPlatform(candidate.platform);
    if (!connector || connector.availability !== 'available' || connector.adapter !== candidate.adapter) {
      throw new Error(`第 ${candidate.row} 项连接器不可用。`);
    }
    await db.prepare(`
      INSERT INTO source_configs
        (id, team_id, owner_team_id, business_owner_id,
         name, adapter, platform, config_json, locator_json, locator_hash,
         collection_policy_json, capabilities_json, lifecycle_status, health_status,
         config_hash, rights_config_hash, source_type, rights_status, rate_limit_per_minute, retention_mode,
         retention_days, enabled, version, schedule_cron, created_at, updated_at)
      VALUES (?, 'default', 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'unknown', ?, ?, ?,
        'pending', 30, 'metadata', 30, 0, 1, ?, ?, ?)
    `).bind(
      sourceId, input.actor.id, candidate.name, candidate.adapter,
      candidate.platform, JSON.stringify(config),
      JSON.stringify(locator), locatorHash,
      JSON.stringify({ scheduleCron: candidate.scheduleCron, mode: 'standard', maxItems: 100 }),
      JSON.stringify(connector.supports), configHash, rightsConfigHash, candidate.sourceType,
      candidate.scheduleCron, now, now,
    ).run();
    const rightsRequest = await createPendingSourceRightsRequest(db, {
      sourceConfigId: sourceId,
      requestedBy: input.actor.id,
      assertionRef: `provisional:${stableHash({ idempotencyKey: input.idempotencyKey, candidate: candidate.url })}`,
      sourceVersion: 1,
      rightsConfigHash,
      idempotencyKey: `source-import:${input.idempotencyKey}:${candidate.row}`,
    }, new Date(now));
    await db.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, after_hash,
         metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.created', 'source_config', ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, sourceId, configHash,
      JSON.stringify({
        bulkImportKey: input.idempotencyKey,
        row: candidate.row,
        platform: candidate.platform,
        lifecycleStatus: 'draft',
        publicUseConfirmed: true,
        rightsRequestId: rightsRequest.id,
        ownership: {
          ownerTeamId: 'default',
          businessOwnerId: input.actor.id,
        },
      }),
      crypto.randomUUID(), now,
    ).run();
    created.push({ row: candidate.row, sourceId, name: candidate.name });
  }
  return { created, skipped, requiresIndividualTestAndEnable: true as const };
}
