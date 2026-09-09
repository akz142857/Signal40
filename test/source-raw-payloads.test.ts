import assert from 'node:assert/strict';
import test from 'node:test';
import { purgeExpiredSourcePayloads } from '../lib/source-retention.ts';
import {
  commitRawPayloadUpload,
  RawPayloadUploadError,
  requireRawPayloadUploadForCommit,
  storeRawPayloadUpload,
} from '../lib/source-raw-payloads.ts';
import type {
  MultipartUpload,
  ObjectPutBody,
  ObjectPutOptions,
  ObjectStorage,
  StoredObjectBody,
} from '../lib/storage.ts';
import { createMemoryPg } from './pg-memory.ts';

class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata?: Record<string, string> }>();
  failDelete = false;

  async get(key: string): Promise<StoredObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(object.bytes);
          controller.close();
        },
      }),
    };
  }

  async put(key: string, data: ObjectPutBody, options?: ObjectPutOptions) {
    let bytes: Uint8Array;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data).slice();
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength).slice();
    else throw new Error('测试存储不接收 stream。');
    this.objects.set(key, { bytes, metadata: options?.customMetadata });
  }

  async delete(keys: string | string[]) {
    if (this.failDelete) throw new Error('simulated object deletion failure');
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options: { prefix: string; cursor?: string; limit?: number; includeMetadata?: boolean }) {
    const all = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    const offset = Number(options.cursor ?? 0);
    const limit = options.limit ?? 1_000;
    const keys = all.slice(offset, offset + limit);
    const next = offset + keys.length;
    return {
      objects: keys.map((key) => ({
        key,
        customMetadata: options.includeMetadata ? this.objects.get(key)?.metadata : undefined,
      })),
      cursor: next < all.length ? String(next) : undefined,
      truncated: next < all.length,
    };
  }

  async createMultipartUpload(): Promise<MultipartUpload> {
    throw new Error('not implemented in test storage');
  }

  resumeMultipartUpload(): MultipartUpload {
    throw new Error('not implemented in test storage');
  }
}

const hour = 60 * 60_000;
const day = 24 * hour;

void test('raw payload upload is durable before object write and idempotent for identical bytes', async () => {
  const db = await createMemoryPg();
  const storage = new MemoryObjectStorage();
  const now = new Date('2026-09-09T02:00:00.000Z');
  const data = new TextEncoder().encode('{"items":[]}').buffer;
  const input = {
    sourceConfigId: 'source-1',
    ingestionRunId: 'run-1',
    objectKey: 'sources/source-1/raw/run-1/payload',
    data,
    contentType: 'application/json',
    expiresAt: new Date(now.valueOf() + hour).toISOString(),
    deleteAfter: new Date(now.valueOf() + day).toISOString(),
  };

  const first = await storeRawPayloadUpload(db, storage, input, now);
  const replay = await storeRawPayloadUpload(db, storage, input, now);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.id, replay.id);
  const row = await db.client.query('SELECT state, object_key, sha256, byte_size FROM raw_payload_uploads WHERE ingestion_run_id = $1', ['run-1']);
  assert.deepEqual(row.rows[0], {
    state: 'uploaded',
    object_key: input.objectKey,
    sha256: first.sha256,
    byte_size: data.byteLength,
  });
  assert.equal(storage.objects.get(input.objectKey)?.metadata?.rawUploadId, first.id);

  await assert.rejects(
    storeRawPayloadUpload(db, storage, { ...input, data: new TextEncoder().encode('different').buffer }, now),
    (error: unknown) => error instanceof RawPayloadUploadError && /不能上传不同/.test(error.message),
  );

  await db.transaction(async (tx) => {
    const locked = await requireRawPayloadUploadForCommit(tx, {
      sourceConfigId: input.sourceConfigId,
      ingestionRunId: input.ingestionRunId,
      objectKey: input.objectKey,
    }, now);
    await commitRawPayloadUpload(tx, locked.id, now);
  });
  const committed = await db.client.query('SELECT state, committed_at FROM raw_payload_uploads WHERE id = $1', [first.id]);
  assert.deepEqual(committed.rows[0], { state: 'committed', committed_at: now.toISOString() });
  await assert.rejects(
    db.transaction((tx) => requireRawPayloadUploadForCommit(tx, {
      sourceConfigId: input.sourceConfigId,
      ingestionRunId: input.ingestionRunId,
      objectKey: input.objectKey,
    }, now)),
    (error: unknown) => error instanceof RawPayloadUploadError && /committed/.test(error.message),
  );
});

void test('expired raw payload upload cannot be attached to an ingestion commit', async () => {
  const db = await createMemoryPg();
  const storage = new MemoryObjectStorage();
  const now = new Date('2026-09-09T02:00:00.000Z');
  const upload = await storeRawPayloadUpload(db, storage, {
    sourceConfigId: 'source-expired',
    ingestionRunId: 'run-expired',
    objectKey: 'sources/source-expired/raw/run-expired/payload',
    data: new TextEncoder().encode('expired').buffer,
    contentType: 'text/plain',
    expiresAt: new Date(now.valueOf() + hour).toISOString(),
    deleteAfter: new Date(now.valueOf() + day).toISOString(),
  }, now);
  await assert.rejects(
    db.transaction((tx) => requireRawPayloadUploadForCommit(tx, {
      sourceConfigId: 'source-expired',
      ingestionRunId: 'run-expired',
      objectKey: upload.objectKey,
    }, new Date(now.valueOf() + 2 * hour))),
    (error: unknown) => error instanceof RawPayloadUploadError && /过期/.test(error.message),
  );
  const row = await db.client.query('SELECT state FROM raw_payload_uploads WHERE id = $1', [upload.id]);
  assert.equal((row.rows[0] as { state: string }).state, 'uploaded');
});

void test('expired uncommitted raw payload is deleted at upload TTL, not retention deadline', async () => {
  const db = await createMemoryPg();
  const storage = new MemoryObjectStorage();
  const now = new Date('2026-09-09T02:00:00.000Z');
  const upload = await storeRawPayloadUpload(db, storage, {
    sourceConfigId: 'source-2',
    ingestionRunId: 'run-2',
    objectKey: 'sources/source-2/raw/run-2/payload',
    data: new TextEncoder().encode('orphan').buffer,
    contentType: 'text/plain',
    expiresAt: new Date(now.valueOf() + hour).toISOString(),
    deleteAfter: new Date(now.valueOf() + 30 * day).toISOString(),
  }, now);

  const result = await purgeExpiredSourcePayloads(db, storage, new Date(now.valueOf() + 2 * hour), { maxApiCalls: 10 });
  assert.equal(result.trackedDeletedObjects, 1);
  assert.equal(result.failedObjects, 0);
  assert.equal(storage.objects.has(upload.objectKey), false);
  const row = await db.client.query('SELECT state, deleted_at, delete_attempts FROM raw_payload_uploads WHERE id = $1', [upload.id]);
  assert.equal((row.rows[0] as { state: string }).state, 'deleted');
  assert.equal((row.rows[0] as { delete_attempts: number }).delete_attempts, 1);
  assert.ok((row.rows[0] as { deleted_at: string }).deleted_at);
  const audit = await db.client.query("SELECT metadata_json FROM audit_events WHERE action = 'source.raw_payload_deleted' AND entity_id = $1", [upload.id]);
  assert.equal((audit.rows[0] as { metadata_json: { reason: string } }).metadata_json.reason, 'upload_session_expired');
});

void test('committed raw payload clears revision link only after retention deletion succeeds', async () => {
  const db = await createMemoryPg();
  const storage = new MemoryObjectStorage();
  const now = new Date('2026-09-09T02:00:00.000Z');
  const upload = await storeRawPayloadUpload(db, storage, {
    sourceConfigId: 'source-3',
    ingestionRunId: 'run-3',
    objectKey: 'sources/source-3/raw/run-3/payload',
    data: new TextEncoder().encode('committed').buffer,
    contentType: 'text/plain',
    expiresAt: new Date(now.valueOf() + hour).toISOString(),
    deleteAfter: new Date(now.valueOf() + day).toISOString(),
  }, now);
  await db.client.query("UPDATE raw_payload_uploads SET state = 'committed', committed_at = $1, delete_after = $2 WHERE id = $3", [now.toISOString(), new Date(now.valueOf() - 1).toISOString(), upload.id]);
  await db.client.query(`
    INSERT INTO article_revisions (id, article_id, revision, content_json, content_hash, raw_object_key, observed_at)
    VALUES ('revision-3', 'article-3', 1, '{}', 'hash-3', $1, $2)
  `, [upload.objectKey, now.toISOString()]);

  storage.failDelete = true;
  const failed = await purgeExpiredSourcePayloads(db, storage, now, { maxApiCalls: 1 });
  assert.equal(failed.failedObjects, 1);
  assert.equal(storage.objects.has(upload.objectKey), true);
  let row = await db.client.query('SELECT state, delete_attempts FROM raw_payload_uploads WHERE id = $1', [upload.id]);
  assert.deepEqual(row.rows[0], { state: 'expired', delete_attempts: 1 });
  let revision = await db.client.query('SELECT raw_object_key FROM article_revisions WHERE id = $1', ['revision-3']);
  assert.equal((revision.rows[0] as { raw_object_key: string }).raw_object_key, upload.objectKey);

  storage.failDelete = false;
  const retried = await purgeExpiredSourcePayloads(db, storage, new Date(now.valueOf() + 1), { maxApiCalls: 1 });
  assert.equal(retried.trackedDeletedObjects, 1);
  row = await db.client.query('SELECT state, delete_attempts FROM raw_payload_uploads WHERE id = $1', [upload.id]);
  assert.deepEqual(row.rows[0], { state: 'deleted', delete_attempts: 2 });
  revision = await db.client.query('SELECT raw_object_key FROM article_revisions WHERE id = $1', ['revision-3']);
  assert.equal((revision.rows[0] as { raw_object_key: string | null }).raw_object_key, null);
});

void test('active delete lease is not stolen and stale delete lease is recovered', async () => {
  const db = await createMemoryPg();
  const storage = new MemoryObjectStorage();
  const now = new Date('2026-09-09T02:00:00.000Z');
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, rights_status, retention_mode, retention_days, created_at, updated_at)
    VALUES ('source-4', 'Source 4', 'rss', 'approved', 'raw', 30, $1, $1)
  `, [now.toISOString()]);
  const upload = await storeRawPayloadUpload(db, storage, {
    sourceConfigId: 'source-4',
    ingestionRunId: 'run-4',
    objectKey: 'sources/source-4/raw/run-4/payload',
    data: new TextEncoder().encode('leased-delete').buffer,
    contentType: 'text/plain',
    expiresAt: new Date(now.valueOf() + hour).toISOString(),
    deleteAfter: new Date(now.valueOf() + day).toISOString(),
  }, now);
  await db.client.query("UPDATE raw_payload_uploads SET state = 'deleting', delete_lease_expires_at = $1 WHERE id = $2", [new Date(now.valueOf() + hour).toISOString(), upload.id]);
  const active = await purgeExpiredSourcePayloads(db, storage, now, { maxApiCalls: 1 });
  assert.equal(active.trackedDeletedObjects, 0);
  assert.equal(storage.objects.has(upload.objectKey), true);

  await db.client.query('UPDATE raw_payload_uploads SET delete_lease_expires_at = $1 WHERE id = $2', [new Date(now.valueOf() - 1).toISOString(), upload.id]);
  const stale = await purgeExpiredSourcePayloads(db, storage, now, { maxApiCalls: 1 });
  assert.equal(stale.trackedDeletedObjects, 1);
  assert.equal(storage.objects.has(upload.objectKey), false);
});
