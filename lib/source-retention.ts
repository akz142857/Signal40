import type { SqlDatabase, SqlStatement } from './sql.ts';
import type { ObjectStorage } from './storage.ts';
import { stableHash } from './workflow.ts';

type SourceRetentionRow = {
  id: string;
  retention_mode: 'metadata' | 'raw';
  retention_days: number;
};

export async function purgeExpiredSourcePayloads(
  db: SqlDatabase,
  media: ObjectStorage,
  now = new Date(),
) {
  const sources = await db.prepare('SELECT id, retention_mode, retention_days FROM source_configs ORDER BY id LIMIT 500').all<SourceRetentionRow>();
  let deletedObjects = 0;
  let clearedRevisionLinks = 0;

  for (const source of sources.results) {
    const prefix = `sources/${source.id}/raw/`;
    const cutoff = source.retention_mode === 'metadata'
      ? now.toISOString()
      : new Date(now.valueOf() - source.retention_days * 86_400_000).toISOString();
    const expiredFromDatabase = await db.prepare(`
      SELECT raw_object_key
      FROM article_revisions
      WHERE raw_object_key IS NOT NULL AND strpos(raw_object_key, ?) = 1
      GROUP BY raw_object_key
      HAVING MAX(observed_at) < ?
      LIMIT 500
    `).bind(prefix, cutoff).all<{ raw_object_key: string }>();

    const expiredKeys = new Set(expiredFromDatabase.results.map((row) => row.raw_object_key));
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      // metadata 模式下前缀内的对象一律清掉，不需要元数据；
      // raw 模式才要读 deleteAfter，这时才让实现去补元数据。
      const listed = await media.list({ prefix, cursor, limit: 500, includeMetadata: source.retention_mode === 'raw' });
      for (const object of listed.objects) {
        const deleteAfter = object.customMetadata?.deleteAfter;
        if (source.retention_mode === 'metadata' || (deleteAfter && deleteAfter <= now.toISOString())) expiredKeys.add(object.key);
      }
      if (!listed.truncated || !listed.cursor) break;
      cursor = listed.cursor;
    }
    if (!expiredKeys.size) continue;

    const keys = [...expiredKeys].slice(0, 100);
    await media.delete(keys);
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

  return { checkedSources: sources.results.length, deletedObjects, clearedRevisionLinks };
}
