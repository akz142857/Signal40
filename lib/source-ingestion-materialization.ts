import type { Article } from './domain.ts';
import { sha256Hex } from './hash.ts';
import { persistArticlesWithRevisions } from './persistence.ts';
import type { SqlDatabase } from './sql.ts';
import {
  sourceItemEventAt,
  type NormalizedSourceItem,
  type NormalizedSourceUpsert,
} from './source-normalized-item.ts';

export type StagedIngestionPayload = {
  /** page-v2/new workers use the discriminated union; legacy pages are upgraded below. */
  items?: NormalizedSourceItem[];
  articles: Article[];
  origins: unknown[];
  rejections: unknown[];
  skippedCount: number;
};

type SourceItemEventState = {
  latest_kind: 'upsert' | 'tombstone';
  latest_event_at: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function originIdentity(
  originValue: unknown,
  articlesByUrl: Map<string, Article>,
  fallbackNamespace: string,
) {
  if (!isRecord(originValue)) return null;
  const namespace = typeof originValue.namespace === 'string'
    ? originValue.namespace.slice(0, 80)
    : fallbackNamespace;
  const platformItemId = typeof originValue.platformItemId === 'string'
    ? originValue.platformItemId.slice(0, 500)
    : '';
  const originUrl = typeof originValue.url === 'string'
    ? originValue.url.replace(/#.*$/, '')
    : '';
  const article = articlesByUrl.get(originUrl);
  return namespace && platformItemId && article
    ? { namespace, platformItemId, article }
    : null;
}

export function shouldApplySourceItemEvent(
  existing: SourceItemEventState | null,
  incoming: Pick<NormalizedSourceItem, 'kind'> & { eventAt: string },
) {
  if (!existing) return true;
  if (incoming.eventAt > existing.latest_event_at) return true;
  if (incoming.eventAt < existing.latest_event_at) return false;
  // 同一平台版本/更新时间发生冲突时，删除优先，绝不默认复活。
  return existing.latest_kind === 'upsert' && incoming.kind === 'tombstone';
}

function legacyNormalizedItems(payload: StagedIngestionPayload, fallbackNamespace: string): NormalizedSourceItem[] {
  const articlesByUrl = new Map(payload.articles.map((article) => [article.url.replace(/#.*$/, ''), article]));
  const identitiesByUrl = new Map<string, { namespace: string; platformItemId: string }>();
  for (const originValue of payload.origins) {
    const identity = originIdentity(originValue, articlesByUrl, fallbackNamespace);
    if (identity) identitiesByUrl.set(identity.article.url.replace(/#.*$/, ''), identity);
  }
  return payload.articles.map((article) => {
    const identity = identitiesByUrl.get(article.url.replace(/#.*$/, ''));
    return {
      kind: 'upsert',
      namespace: identity?.namespace ?? fallbackNamespace,
      platformItemId: identity?.platformItemId ?? article.id ?? sha256Hex(article.url),
      title: article.title,
      url: article.url,
      publishedAt: article.publishedAt,
      author: article.author,
      summary: article.summary,
      metrics: article.metrics,
      provenance: { connectorId: 'legacy-article-v1', connectorVersion: '1', observedAt: article.publishedAt },
      identityStrategy: identity ? 'platform_id' : article.id ? 'platform_id' : 'canonical_url',
      identityConfidence: identity || article.id ? 'high' : 'medium',
      canonicalUrlVersion: 'url-v1',
      contentFingerprintVersion: 'content-v1',
    } satisfies NormalizedSourceUpsert;
  });
}

async function writeSourceItemState(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    ingestionRunId: string;
    item: NormalizedSourceItem;
    eventAt: string;
    now: string;
  },
) {
  await db.prepare(`
    INSERT INTO source_item_event_states
      (id, source_config_id, namespace, platform_item_id, latest_kind,
       latest_event_at, latest_ingestion_run_id, identity_strategy,
       identity_confidence, provenance_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_config_id, namespace, platform_item_id) DO UPDATE SET
      latest_kind = excluded.latest_kind,
      latest_event_at = excluded.latest_event_at,
      latest_ingestion_run_id = excluded.latest_ingestion_run_id,
      identity_strategy = excluded.identity_strategy,
      identity_confidence = excluded.identity_confidence,
      provenance_json = excluded.provenance_json,
      updated_at = excluded.updated_at
  `).bind(
    `source_item_state_${crypto.randomUUID()}`,
    input.sourceConfigId,
    input.item.namespace,
    input.item.platformItemId,
    input.item.kind,
    input.eventAt,
    input.ingestionRunId,
    input.item.identityStrategy,
    input.item.identityConfidence,
    JSON.stringify(input.item.provenance),
    input.now,
    input.now,
  ).run();
}

export async function countExistingOriginDuplicates(
  db: SqlDatabase,
  sourceConfigId: string,
  platform: string,
  payload: StagedIngestionPayload,
) {
  if (payload.items?.length) {
    let duplicates = Math.max(0, payload.skippedCount);
    for (const item of payload.items) {
      const existing = await db.prepare(`
        SELECT latest_kind, latest_event_at FROM source_item_event_states
        WHERE source_config_id = ? AND namespace = ? AND platform_item_id = ? LIMIT 1
      `).bind(sourceConfigId, item.namespace, item.platformItemId).first<SourceItemEventState>();
      if (!shouldApplySourceItemEvent(existing, { kind: item.kind, eventAt: sourceItemEventAt(item) })) duplicates += 1;
    }
    return duplicates;
  }
  const articlesByUrl = new Map(payload.articles.map((article) => [article.url.replace(/#.*$/, ''), article]));
  let duplicates = Math.max(0, payload.skippedCount);
  for (const originValue of payload.origins) {
    const identity = originIdentity(originValue, articlesByUrl, platform);
    if (!identity) continue;
    const existing = await db.prepare(`
      SELECT id FROM source_item_origins
      WHERE source_config_id = ? AND namespace = ? AND platform_item_id = ? LIMIT 1
    `).bind(sourceConfigId, identity.namespace, identity.platformItemId).first<{ id: string }>();
    if (existing) duplicates += 1;
  }
  return duplicates;
}

export async function materializeIngestionPayload(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    ingestionRunId: string;
    platform: string;
    publisherEntityId: string | null;
    payload: StagedIngestionPayload;
    observedAt: Date;
    rawObjectKey?: string | null;
  },
) {
  const candidateItems = input.payload.items?.length
    ? input.payload.items
    : legacyNormalizedItems(input.payload, input.platform);
  const articlesByUrl = new Map(input.payload.articles.map((article) => [article.url.replace(/#.*$/, ''), article]));
  const normalized: Article[] = [];
  let duplicateCount = Math.max(0, input.payload.skippedCount);
  let changedCount = 0;

  for (const item of candidateItems) {
    const eventAt = sourceItemEventAt(item);
    const eventState = await db.prepare(`
      SELECT latest_kind, latest_event_at FROM source_item_event_states
      WHERE source_config_id = ? AND namespace = ? AND platform_item_id = ? LIMIT 1
      FOR UPDATE
    `).bind(input.sourceConfigId, item.namespace, item.platformItemId).first<SourceItemEventState>();
    if (!shouldApplySourceItemEvent(eventState, { kind: item.kind, eventAt })) {
      duplicateCount += 1;
      continue;
    }
    if (item.kind === 'tombstone') {
      const deleted = await db.prepare(`
        UPDATE source_item_origins SET deleted_at = ?, last_seen_at = ?, ingestion_run_id = ?
        WHERE source_config_id = ? AND namespace = ? AND platform_item_id = ?
          AND (deleted_at IS NULL OR deleted_at < ?)
      `).bind(
        item.deletedAt,
        input.observedAt.toISOString(),
        input.ingestionRunId,
        input.sourceConfigId,
        item.namespace,
        item.platformItemId,
        item.deletedAt,
      ).run();
      await writeSourceItemState(db, {
        sourceConfigId: input.sourceConfigId,
        ingestionRunId: input.ingestionRunId,
        item,
        eventAt,
        now: input.observedAt.toISOString(),
      });
      if (deleted.meta.changes) changedCount += 1;
      continue;
    }
    const article = articlesByUrl.get(item.url.replace(/#.*$/, ''));
    if (!article) throw new Error(`upsert ${item.namespace}/${item.platformItemId} 缺少已验证文章。`);
    const [canonical] = await persistArticlesWithRevisions(
      db,
      [article],
      input.observedAt,
      input.rawObjectKey ?? null,
    );
    if (!canonical) throw new Error(`upsert ${item.namespace}/${item.platformItemId} 无法规范化。`);
    normalized.push(canonical);
    const existing = await db.prepare(`
      SELECT id FROM source_item_origins
      WHERE source_config_id = ? AND namespace = ? AND platform_item_id = ? LIMIT 1
    `).bind(input.sourceConfigId, item.namespace, item.platformItemId).first<{ id: string }>();
    if (existing) duplicateCount += 1;
    const revision = await db.prepare(`
      SELECT id FROM article_revisions WHERE article_id = ? ORDER BY revision DESC LIMIT 1
    `).bind(canonical.id).first<{ id: string }>();
    await db.prepare(`
      INSERT INTO source_item_origins
        (id, source_config_id, namespace, platform_item_id, article_id,
         article_revision_id, ingestion_run_id, canonical_url_hash,
         fingerprint_version, content_fingerprint, relationship,
         evidence_family_id, publisher_entity_id, confidence, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'content-v1', ?, 'unknown', ?, ?, 0, ?, ?)
      ON CONFLICT (source_config_id, namespace, platform_item_id) DO UPDATE SET
        article_id = excluded.article_id,
        article_revision_id = excluded.article_revision_id,
        ingestion_run_id = excluded.ingestion_run_id,
        canonical_url_hash = excluded.canonical_url_hash,
        content_fingerprint = excluded.content_fingerprint,
        evidence_family_id = excluded.evidence_family_id,
        publisher_entity_id = excluded.publisher_entity_id,
        last_seen_at = excluded.last_seen_at,
        deleted_at = NULL
    `).bind(
      `origin_${crypto.randomUUID()}`,
      input.sourceConfigId,
      item.namespace,
      item.platformItemId,
      canonical.id,
      revision?.id ?? null,
      input.ingestionRunId,
      sha256Hex(canonical.url),
      canonical.contentHash,
      `family_${canonical.contentHash}`,
      input.publisherEntityId ?? input.sourceConfigId,
      input.observedAt.toISOString(),
      input.observedAt.toISOString(),
    ).run();
    await writeSourceItemState(db, {
      sourceConfigId: input.sourceConfigId,
      ingestionRunId: input.ingestionRunId,
      item,
      eventAt,
      now: input.observedAt.toISOString(),
    });
    changedCount += 1;
  }

  for (const [fallbackIndex, rejectionValue] of input.payload.rejections.entries()) {
    if (!isRecord(rejectionValue)) continue;
    const itemIndex = Number.isInteger(rejectionValue.itemIndex)
      ? Math.max(0, Number(rejectionValue.itemIndex))
      : fallbackIndex;
    const errorCode = typeof rejectionValue.errorCode === 'string'
      ? rejectionValue.errorCode.slice(0, 80)
      : 'INVALID_ITEM';
    const detail = typeof rejectionValue.detailRedacted === 'string'
      ? rejectionValue.detailRedacted.slice(0, 500)
      : '条目未通过规范化校验。';
    const payloadHash = typeof rejectionValue.payloadHash === 'string'
      ? rejectionValue.payloadHash.slice(0, 128)
      : sha256Hex(JSON.stringify(rejectionValue));
    const platformItemId = typeof rejectionValue.platformItemId === 'string'
      ? rejectionValue.platformItemId.slice(0, 500)
      : null;
    await db.prepare(`
      INSERT INTO source_item_rejections
        (id, ingestion_run_id, platform_item_id, item_index, error_code,
         detail_redacted, payload_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `rejection_${crypto.randomUUID()}`,
      input.ingestionRunId,
      platformItemId,
      itemIndex,
      errorCode,
      detail,
      payloadHash,
      input.observedAt.toISOString(),
    ).run();
  }

  return { normalized, duplicateCount, changedCount };
}

export function parseStagedIngestionPayload(value: unknown): StagedIngestionPayload | null {
  if (!isRecord(value) || !Array.isArray(value.articles) || !Array.isArray(value.origins)
    || !Array.isArray(value.rejections) || !Number.isInteger(value.skippedCount)) return null;
  if (value.items !== undefined && !Array.isArray(value.items)) return null;
  return value as StagedIngestionPayload;
}
