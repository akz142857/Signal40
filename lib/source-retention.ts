import type { SqlDatabase, SqlStatement } from './sql.ts';
import type { ObjectStorage } from './storage.ts';
import { stableHash } from './workflow.ts';

type SourceRetentionRow = {
  id: string;
  retention_mode: 'metadata' | 'raw';
  retention_days: number;
};

type RawPayloadUploadRow = {
  id: string;
  source_config_id: string;
  ingestion_run_id: string;
  state: 'initiated' | 'uploaded' | 'committed' | 'aborted' | 'expired' | 'deleting';
  object_key: string;
  expires_at: string;
  delete_after: string;
};

async function purgeTrackedRawPayloads(
  db: SqlDatabase,
  media: ObjectStorage,
  now: Date,
  maxApiCalls: number,
) {
  if (maxApiCalls <= 0) {
    return { deletedObjects: 0, clearedRevisionLinks: 0, failedObjects: 0, apiCalls: 0 };
  }
  const timestamp = now.toISOString();
  const deleteLeaseExpiresAt = new Date(now.valueOf() + 5 * 60_000).toISOString();
  const limit = Math.min(100, Number.isFinite(maxApiCalls) ? Math.floor(maxApiCalls) : 100);
  const candidates = await db.prepare(`
    SELECT id, source_config_id, ingestion_run_id, state, object_key, expires_at, delete_after
    FROM raw_payload_uploads
    WHERE state = 'expired'
       OR (state = 'deleting' AND delete_lease_expires_at <= ?)
       OR (state IN ('initiated', 'uploaded', 'aborted') AND expires_at <= ?)
       OR (state = 'committed' AND delete_after <= ?)
    ORDER BY updated_at, id
    LIMIT ?
  `).bind(timestamp, timestamp, timestamp, limit).all<RawPayloadUploadRow>();

  let deletedObjects = 0;
  let clearedRevisionLinks = 0;
  let failedObjects = 0;
  let apiCalls = 0;
  for (const candidate of candidates.results) {
    if (apiCalls >= maxApiCalls) break;
    const reason = candidate.delete_after <= timestamp ? 'retention_expired' : 'upload_session_expired';
    const claimed = await db.prepare(`
      UPDATE raw_payload_uploads
      SET state = 'deleting', delete_lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND (
        state = 'expired'
        OR (state = 'deleting' AND delete_lease_expires_at <= ?)
        OR (state IN ('initiated', 'uploaded', 'aborted') AND expires_at <= ?)
        OR (state = 'committed' AND delete_after <= ?)
      )
    `).bind(deleteLeaseExpiresAt, timestamp, candidate.id, timestamp, timestamp, timestamp).run();
    if (!claimed.meta.changes) continue;

    try {
      await media.delete(candidate.object_key);
      apiCalls += 1;
    } catch {
      apiCalls += 1;
      failedObjects += 1;
      await db.prepare(`
        UPDATE raw_payload_uploads
        SET state = 'expired', delete_lease_expires_at = NULL,
            delete_attempts = delete_attempts + 1,
            last_error_redacted = 'OBJECT_DELETE_FAILED', updated_at = ?
        WHERE id = ? AND state = 'deleting'
      `).bind(timestamp, candidate.id).run();
      continue;
    }

    const deletionHash = stableHash({
      uploadId: candidate.id,
      objectKey: candidate.object_key,
      reason,
      deletedAt: timestamp,
    });
    const results = await db.batch([
      db.prepare(`
        UPDATE raw_payload_uploads
        SET state = 'deleted', deleted_at = ?, updated_at = ?,
            delete_attempts = delete_attempts + 1, delete_lease_expires_at = NULL,
            last_error_redacted = NULL
        WHERE id = ? AND state = 'deleting'
      `).bind(timestamp, timestamp, candidate.id),
      db.prepare('UPDATE article_revisions SET raw_object_key = NULL WHERE raw_object_key = ?').bind(candidate.object_key),
      db.prepare(`
        INSERT INTO audit_events
          (id, actor_id, actor_role, action, entity_type, entity_id,
           after_hash, metadata_json, request_id, created_at)
        VALUES (?, 'source-retention', 'admin', 'source.raw_payload_deleted',
                'raw_payload_upload', ?, ?, ?, ?, ?)
      `).bind(
        `audit_${crypto.randomUUID()}`,
        candidate.id,
        deletionHash,
        JSON.stringify({
          sourceConfigId: candidate.source_config_id,
          ingestionRunId: candidate.ingestion_run_id,
          reason,
          receiptHash: deletionHash,
        }),
        crypto.randomUUID(),
        timestamp,
      ),
    ]);
    if (!results[0].meta.changes) continue;
    deletedObjects += 1;
    clearedRevisionLinks += Number(results[1].meta.changes ?? 0);
  }
  return { deletedObjects, clearedRevisionLinks, failedObjects, apiCalls };
}

export async function purgeExpiredSourcePayloads(
  db: SqlDatabase,
  media: ObjectStorage,
  now = new Date(),
  options: { maxApiCalls?: number } = {},
) {
  const maxApiCalls = options.maxApiCalls ?? Number.POSITIVE_INFINITY;
  const tracked = await purgeTrackedRawPayloads(db, media, now, maxApiCalls);
  const sources = await db.prepare('SELECT id, retention_mode, retention_days FROM source_configs ORDER BY id LIMIT 500').all<SourceRetentionRow>();
  let deletedObjects = tracked.deletedObjects;
  let clearedRevisionLinks = tracked.clearedRevisionLinks;
  let apiCalls = tracked.apiCalls;

  sourceLoop:
  for (const source of sources.results) {
    const prefix = `sources/${source.id}/raw/`;
    const managed = await db.prepare(`
      SELECT object_key FROM raw_payload_uploads
      WHERE source_config_id = ? AND state <> 'deleted'
      ORDER BY created_at DESC LIMIT 5000
    `).bind(source.id).all<{ object_key: string }>();
    const managedKeys = new Set(managed.results.map((row) => row.object_key));
    const cutoff = source.retention_mode === 'metadata'
      ? now.toISOString()
      : new Date(now.valueOf() - source.retention_days * 86_400_000).toISOString();
    const expiredFromDatabase = await db.prepare(`
      SELECT raw_object_key
      FROM article_revisions
      WHERE raw_object_key IS NOT NULL AND strpos(raw_object_key, ?) = 1
        AND NOT EXISTS (
          SELECT 1 FROM raw_payload_uploads
          WHERE raw_payload_uploads.object_key = article_revisions.raw_object_key
            AND raw_payload_uploads.state <> 'deleted'
        )
      GROUP BY raw_object_key
      HAVING MAX(observed_at) < ?
      LIMIT 500
    `).bind(prefix, cutoff).all<{ raw_object_key: string }>();

    const expiredKeys = new Set(expiredFromDatabase.results.map((row) => row.raw_object_key));
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      if (apiCalls >= maxApiCalls) break sourceLoop;
      // metadata 模式下前缀内的对象一律清掉，不需要元数据；
      // raw 模式才要读 deleteAfter，这时才让实现去补元数据。
      const listed = await media.list({ prefix, cursor, limit: 500, includeMetadata: source.retention_mode === 'raw' });
      apiCalls += 1;
      for (const object of listed.objects) {
        if (managedKeys.has(object.key)) continue;
        const deleteAfter = object.customMetadata?.deleteAfter;
        if (source.retention_mode === 'metadata' || (deleteAfter && deleteAfter <= now.toISOString())) expiredKeys.add(object.key);
      }
      if (!listed.truncated || !listed.cursor) break;
      cursor = listed.cursor;
    }
    if (!expiredKeys.size) continue;

    const keys = [...expiredKeys].slice(0, 100);
    if (apiCalls >= maxApiCalls) break;
    await media.delete(keys);
    apiCalls += 1;
    const timestamp = now.toISOString();
    const statements: SqlStatement[] = keys.map((key) => db.prepare('UPDATE article_revisions SET raw_object_key = NULL WHERE raw_object_key = ?').bind(key));
    statements.push(db.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
      VALUES (?, 'source-retention', 'admin', 'source.raw_payloads_purged', 'source_config', ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`,
      source.id,
      stableHash({ sourceConfigId: source.id, deletedCount: keys.length, timestamp }),
      JSON.stringify({ deletedCount: keys.length, retentionMode: source.retention_mode, retentionDays: source.retention_days }),
      crypto.randomUUID(),
      timestamp,
    ));
    const results = await db.batch(statements);
    deletedObjects += keys.length;
    clearedRevisionLinks += results.slice(0, keys.length).reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
  }

  return {
    checkedSources: sources.results.length,
    deletedObjects,
    clearedRevisionLinks,
    failedObjects: tracked.failedObjects,
    trackedDeletedObjects: tracked.deletedObjects,
    apiCalls,
  };
}
