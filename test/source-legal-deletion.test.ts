import assert from 'node:assert/strict';
import test from 'node:test';
import type { MultipartUpload, ObjectStorage, StoredObjectBody } from '../lib/storage.ts';
import { finishJob, leaseNextJob } from '../lib/control-plane.ts';
import {
  authorizeSourceLegalWithdrawal,
  createSourceLegalHold,
  processSourceLegalDeletions,
  releaseSourceLegalHold,
  requestSourceLegalDeletion,
  retrySourceLegalDeletion,
} from '../lib/source-legal-deletion.ts';
import { createMemoryPg } from './pg-memory.ts';

class DeletionStorage implements ObjectStorage {
  readonly keys = new Set<string>();
  failDelete = false;
  async get(): Promise<StoredObjectBody | null> { return null; }
  async put(key: string) { this.keys.add(key); }
  async delete(keys: string | string[]) {
    if (this.failDelete) throw new Error('simulated deletion failure');
    for (const key of Array.isArray(keys) ? keys : [keys]) this.keys.delete(key);
  }
  async list() { return { objects: [], truncated: false }; }
  async createMultipartUpload(): Promise<MultipartUpload> { throw new Error('not implemented'); }
  resumeMultipartUpload(): MultipartUpload { throw new Error('not implemented'); }
}

const now = new Date('2026-09-09T04:00:00.000Z');
const actor = { id: 'admin-delete', email: 'delete@signal40.test', role: 'admin' as const, canManageSourceLegal: true };
const independentActor = { id: 'admin-legal-review', email: 'legal-review@signal40.test', role: 'admin' as const, canManageSourceLegal: true };

function firstRow<T>(result: { rows: unknown[] }) {
  return result.rows[0] as T;
}

async function seedSource(id: string) {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO team_members
      (user_id, email, role, status, can_manage_source_legal, created_at, updated_at)
    VALUES
      ('admin-delete', 'delete@signal40.test', 'admin', 'active', 1, $1, $1),
      ('admin-legal-review', 'legal-review@signal40.test', 'admin', 'active', 1, $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, locator_json, rights_status, enabled, version,
       lifecycle_status, health_status, config_hash, created_at, updated_at)
    VALUES ($1, 'Delete me', 'rss', '{}', '{}', 'approved', 1, 3,
      'enabled', 'healthy', 'config-hash', $2, $2)
  `, [id, now.toISOString()]);
  return db;
}

void test('legal operations require an explicit capability and a second hold operator', async () => {
  const db = await seedSource('source-legal-capability');
  const ordinaryAdmin = { id: 'admin-ordinary', email: 'ordinary@signal40.test', role: 'admin' as const };
  assert.deepEqual(await requestSourceLegalDeletion(db, {
    sourceId: 'source-legal-capability', expectedVersion: 3,
    reason: 'Verified erasure request', idempotencyKey: 'ordinary-delete', actor: ordinaryAdmin,
  }, now), {
    status: 403,
    error: '需要有效的来源法律操作权限才能发起依法删除。',
  });
  assert.deepEqual(await createSourceLegalHold(db, {
    sourceId: 'source-legal-capability', reason: 'Preservation request requires review',
    authorityRef: 'case-capability', actor: ordinaryAdmin,
  }, now), {
    status: 403,
    error: '需要有效的来源法律操作权限才能创建 legal hold。',
  });

  await db.client.query("UPDATE team_members SET status = 'suspended' WHERE user_id = 'admin-legal-review'");
  assert.deepEqual(await createSourceLegalHold(db, {
    sourceId: 'source-legal-capability', reason: 'Preservation request requires review',
    authorityRef: 'case-second-operator', actor,
  }, now), {
    status: 409,
    error: '创建 legal hold 前必须任命另一名有效法律操作人，以保证异人解除。',
  });
});

void test('legal hold leaves source untouched, then release initializes and completes the request', async () => {
  const db = await seedSource('source-held');
  const storage = new DeletionStorage();
  const hold = await createSourceLegalHold(db, {
    sourceId: 'source-held',
    reason: 'Litigation preservation request',
    authorityRef: 'case-2026-001',
    actor,
  }, now);
  assert.equal(hold.status, 201);
  assert.equal('holdEpoch' in hold ? hold.holdEpoch : null, 1);
  const requested = await requestSourceLegalDeletion(db, {
    sourceId: 'source-held',
    expectedVersion: 3,
    reason: 'Data subject deletion request',
    idempotencyKey: 'delete-held-1',
    actor,
  }, now);
  if ('error' in requested) assert.fail(requested.error);
  assert.equal(requested.deletionStatus, 'blocked');
  let source = await db.client.query("SELECT enabled, version, name FROM source_configs WHERE id = 'source-held'");
  assert.deepEqual(source.rows[0], { enabled: 1, version: 3, name: 'Delete me' });
  assert.deepEqual(await processSourceLegalDeletions(db, storage, now), { processed: false });

  if (!('legalHoldId' in hold)) return;
  assert.deepEqual(await releaseSourceLegalHold(db, {
    sourceId: 'source-held', legalHoldId: hold.legalHoldId,
    reason: 'Preservation obligation has ended', actor,
  }, new Date(now.valueOf() + 1_000)), {
    status: 403,
    error: '建立 legal hold 的管理员不能单人解除同一个 hold。',
  });
  await releaseSourceLegalHold(db, {
    sourceId: 'source-held', legalHoldId: hold.legalHoldId,
    reason: 'Preservation obligation has ended', actor: independentActor,
  }, new Date(now.valueOf() + 1_000));
  const processed = await processSourceLegalDeletions(db, storage, new Date(now.valueOf() + 2_000));
  assert.equal(processed.completed, true);
  source = await db.client.query("SELECT enabled, lifecycle_status, name FROM source_configs WHERE id = 'source-held'");
  assert.deepEqual(source.rows[0], { enabled: 0, lifecycle_status: 'archived', name: '[deleted]' });
  const request = await db.client.query("SELECT status, initialized_at, receipt_hash FROM source_deletion_requests WHERE idempotency_key = 'delete-held-1'");
  const requestRow = firstRow<{ status: string; initialized_at: string; receipt_hash: string }>(request);
  assert.equal(requestRow.status, 'completed');
  assert.ok(requestRow.initialized_at);
  assert.match(requestRow.receipt_hash, /^sha256:[a-f0-9]{64}$/);
});

void test('legal hold epoch invalidates a leased external withdrawal and release requires a fresh lease', async () => {
  const db = await seedSource('source-hold-fence');
  await db.client.query(`
    INSERT INTO source_deletion_requests
      (id, source_config_id, source_version, idempotency_key, status, reason,
       requested_by, initialized_at, created_at, updated_at)
    VALUES ('delete-fenced', 'source-hold-fence', 3, 'delete-fenced-key',
      'awaiting_external', 'Verified erasure request', 'admin-delete', $1, $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_deletion_items
      (id, request_id, kind, target_ref, status, created_at, updated_at)
    VALUES ('delete-fenced-item', 'delete-fenced', 'external_publish',
      'publish-fenced', 'awaiting_external', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO jobs
      (id, kind, payload_schema_version, payload_json, status, idempotency_key,
       available_at, created_at, updated_at)
    VALUES ('job-delete-fenced', 'publish', 2,
      '{"schemaVersion":2,"operation":"withdraw","publishJobId":"publish-fenced","channel":"youtube","externalId":"video-fenced","deletionRequestId":"delete-fenced","deletionItemId":"delete-fenced-item","legalHoldEpoch":0}',
      'queued', 'legal-delete-external:delete-fenced:publish-fenced', $1, $1, $1)
  `, [now.toISOString()]);

  const firstLease = await leaseNextJob(db, {
    workerId: 'render-fence-1',
    kinds: ['publish'],
    maxPayloadSchemaVersion: 2,
  }, now);
  assert.equal((firstLease as { id?: string } | null)?.id, 'job-delete-fenced');
  assert.deepEqual(await authorizeSourceLegalWithdrawal(db, {
    jobId: 'job-delete-fenced', workerId: 'render-fence-1', leaseEpoch: 1,
  }, new Date(now.valueOf() + 1_000)), {
    status: 200,
    authorized: true,
    sourceId: 'source-hold-fence',
    legalHoldEpoch: 0,
  });

  const hold = await createSourceLegalHold(db, {
    sourceId: 'source-hold-fence',
    reason: 'Preserve while external withdrawal is pending',
    authorityRef: 'case-fence-1',
    actor,
  }, new Date(now.valueOf() + 2_000));
  assert.equal('holdEpoch' in hold ? hold.holdEpoch : null, 1);
  assert.deepEqual(await authorizeSourceLegalWithdrawal(db, {
    jobId: 'job-delete-fenced', workerId: 'render-fence-1', leaseEpoch: 1,
  }, new Date(now.valueOf() + 3_000)), {
    status: 409,
    error: '外部撤回作业租约或 leaseEpoch 已失效。',
    errorCode: 'LEASE_LOST',
  });
  const fencedJob = (await db.client.query(
    "SELECT status, lease_epoch FROM jobs WHERE id = 'job-delete-fenced'",
  )).rows[0] as { status: string; lease_epoch: number };
  assert.deepEqual(fencedJob, { status: 'cancelled', lease_epoch: 2 });

  if (!('legalHoldId' in hold) || typeof hold.legalHoldId !== 'string') return;
  const released = await releaseSourceLegalHold(db, {
    sourceId: 'source-hold-fence', legalHoldId: hold.legalHoldId,
    reason: 'Independent reviewer confirmed preservation ended', actor: independentActor,
  }, new Date(now.valueOf() + 4_000));
  assert.equal('holdEpoch' in released ? released.holdEpoch : null, 1);
  const requeued = (await db.client.query(
    "SELECT status, payload_json FROM jobs WHERE id = 'job-delete-fenced'",
  )).rows[0] as { status: string; payload_json: Record<string, unknown> };
  assert.equal(requeued.status, 'queued');
  assert.equal(requeued.payload_json.legalHoldEpoch, 1);

  const secondLease = await leaseNextJob(db, {
    workerId: 'render-fence-2',
    kinds: ['publish'],
    maxPayloadSchemaVersion: 2,
  }, new Date(now.valueOf() + 5_000));
  assert.equal((secondLease as { lease_epoch?: number } | null)?.lease_epoch, 3);
  assert.deepEqual(await authorizeSourceLegalWithdrawal(db, {
    jobId: 'job-delete-fenced', workerId: 'render-fence-2', leaseEpoch: 3,
  }, new Date(now.valueOf() + 6_000)), {
    status: 200,
    authorized: true,
    sourceId: 'source-hold-fence',
    legalHoldEpoch: 1,
  });
});

void test('object failure is retryable and database content is removed only after storage receipt', async () => {
  const db = await seedSource('source-retry');
  const storage = new DeletionStorage();
  const objectKey = 'sources/source-retry/raw/run-1/payload';
  storage.keys.add(objectKey);
  await db.client.query(`
    INSERT INTO articles
      (id, source, source_type, title, url, published_at, content_hash, created_at)
    VALUES ('article-delete', 'Feed', 'media', 'Sensitive title', 'https://example.test/a', $1, 'content-delete', $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO article_revisions
      (id, article_id, revision, content_json, content_hash, raw_object_key, observed_at)
    VALUES ('revision-delete', 'article-delete', 1, '{"body":"sensitive"}', 'revision-hash', $1, $2)
  `, [objectKey, now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_item_origins
      (id, source_config_id, namespace, platform_item_id, article_id, article_revision_id,
       ingestion_run_id, canonical_url_hash, fingerprint_version, content_fingerprint, first_seen_at, last_seen_at)
    VALUES ('origin-delete', 'source-retry', 'rss', 'item-delete', 'article-delete', 'revision-delete',
      'run-delete', 'url-hash', 'v1', 'fingerprint', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO raw_payload_uploads
      (id, source_config_id, ingestion_run_id, state, object_key, sha256, byte_size,
       created_at, updated_at, expires_at, delete_after)
    VALUES ('raw-delete', 'source-retry', 'run-delete', 'committed', $1, 'raw-hash', 12,
      $2, $2, $2, $2)
  `, [objectKey, now.toISOString()]);
  const requested = await requestSourceLegalDeletion(db, {
    sourceId: 'source-retry', expectedVersion: 3, reason: 'Verified erasure request',
    idempotencyKey: 'delete-retry-1', actor,
  }, now);
  if ('error' in requested) assert.fail(requested.error);
  assert.equal(requested.deletionStatus, 'pending');
  storage.failDelete = true;
  const failed = await processSourceLegalDeletions(db, storage, new Date(now.valueOf() + 1_000));
  assert.equal(failed.failedObjects, 1);
  assert.equal(firstRow<{ total: number }>(await db.client.query("SELECT COUNT(*)::int AS total FROM articles WHERE id = 'article-delete'")).total, 1);
  assert.equal(firstRow<{ status: string }>(await db.client.query("SELECT status FROM source_deletion_requests WHERE idempotency_key = 'delete-retry-1'")).status, 'failed');

  storage.failDelete = false;
  const completed = await processSourceLegalDeletions(db, storage, new Date(now.valueOf() + 2_000));
  assert.equal(completed.completed, true);
  assert.equal(storage.keys.has(objectKey), false);
  assert.equal(firstRow<{ total: number }>(await db.client.query("SELECT COUNT(*)::int AS total FROM articles WHERE id = 'article-delete'")).total, 0);
  const item = await db.client.query("SELECT object_key, status, receipt_hash, receipt_json FROM source_deletion_items WHERE kind = 'raw_object'");
  const itemRow = firstRow<{ object_key: null; status: string; receipt_hash: string; receipt_json: unknown }>(item);
  assert.equal(itemRow.object_key, null);
  assert.equal(itemRow.status, 'deleted');
  assert.match(itemRow.receipt_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(itemRow.receipt_json).includes(objectKey), false);
});

void test('shared normalized article survives deletion of one source origin', async () => {
  const db = await seedSource('source-shared-delete');
  const storage = new DeletionStorage();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, locator_json, rights_status, enabled, version,
       lifecycle_status, health_status, config_hash, created_at, updated_at)
    VALUES ('source-shared-keep', 'Keep', 'rss', '{}', '{}', 'approved', 1, 1,
      'enabled', 'healthy', 'keep-hash', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO articles (id, source, source_type, title, url, published_at, content_hash, created_at)
    VALUES ('article-shared', 'Shared', 'media', 'Shared title', 'https://example.test/shared', $1, 'shared-hash', $1)
  `, [now.toISOString()]);
  for (const [originId, sourceId] of [['origin-shared-delete', 'source-shared-delete'], ['origin-shared-keep', 'source-shared-keep']] as const) {
    await db.client.query(`
      INSERT INTO source_item_origins
        (id, source_config_id, namespace, platform_item_id, article_id, ingestion_run_id,
         canonical_url_hash, fingerprint_version, content_fingerprint, first_seen_at, last_seen_at)
      VALUES ($1, $2, 'rss', $1, 'article-shared', $1, 'shared-url', 'v1', 'shared-fingerprint', $3, $3)
    `, [originId, sourceId, now.toISOString()]);
  }
  await requestSourceLegalDeletion(db, {
    sourceId: 'source-shared-delete', expectedVersion: 3, reason: 'Delete only this source',
    idempotencyKey: 'delete-shared-1', actor,
  }, now);
  const processed = await processSourceLegalDeletions(db, storage, new Date(now.valueOf() + 1_000));
  assert.equal(processed.completed, true);
  assert.equal(firstRow<{ total: number }>(await db.client.query("SELECT COUNT(*)::int AS total FROM articles WHERE id = 'article-shared'")).total, 1);
  const origins = await db.client.query("SELECT source_config_id FROM source_item_origins WHERE article_id = 'article-shared'");
  assert.deepEqual(origins.rows, [{ source_config_id: 'source-shared-keep' }]);
  assert.equal(firstRow<{ total: number }>(await db.client.query("SELECT COUNT(*)::int AS total FROM source_deletion_items WHERE kind = 'normalized_article'")).total, 0);
});

void test('published content blocks final deletion until the publish worker confirms remote withdrawal', async () => {
  const db = await seedSource('source-published');
  const storage = new DeletionStorage();
  await db.client.query(`
    INSERT INTO articles (id, source, source_type, title, url, published_at, content_hash, created_at)
    VALUES ('article-published', 'Feed', 'media', 'Published title', 'https://example.test/published', $1, 'published-hash', $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_item_origins
      (id, source_config_id, namespace, platform_item_id, article_id, ingestion_run_id,
       canonical_url_hash, fingerprint_version, content_fingerprint, first_seen_at, last_seen_at)
    VALUES ('origin-published', 'source-published', 'rss', 'item-published', 'article-published',
      'run-published', 'published-url', 'v1', 'published-fingerprint', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO topics
      (id, title, score, score_breakdown_json, source_count, status, gate_json, updated_at)
    VALUES ('topic-published', 'Topic', 90, '{}', 1, 'ready', '{}', $1)
  `, [now.toISOString()]);
  await db.client.query("INSERT INTO topic_articles (topic_id, article_id) VALUES ('topic-published', 'article-published')");
  await db.client.query(`
    INSERT INTO content_projects
      (id, topic_id, title, state, owner_id, project_json, immutable_hash, created_at, updated_at)
    VALUES ('project-published', 'topic-published', 'Project', 'PUBLISHED', 'admin-delete', '{}', 'project-hash', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO publish_jobs
      (id, project_id, channel, logical_key, status, external_id, title, created_at, updated_at)
    VALUES ('publish-published', 'project-published', 'youtube', 'published-key', 'published', 'youtube-video-1', 'Video', $1, $1)
  `, [now.toISOString()]);
  const requested = await requestSourceLegalDeletion(db, {
    sourceId: 'source-published', expectedVersion: 3, reason: 'Remove published data',
    idempotencyKey: 'delete-published-1', actor,
  }, now);
  const waiting = await processSourceLegalDeletions(db, storage, new Date(now.valueOf() + 1_000));
  assert.equal(waiting.awaitingExternal, true);
  assert.equal(waiting.queuedExternal, 1);
  assert.equal(firstRow<{ status: string }>(await db.client.query("SELECT status FROM source_deletion_requests WHERE idempotency_key = 'delete-published-1'")).status, 'awaiting_external');
  assert.equal(firstRow<{ total: number }>(await db.client.query("SELECT COUNT(*)::int AS total FROM content_projects WHERE id = 'project-published'")).total, 1);

  const job = await db.client.query("SELECT id FROM jobs WHERE idempotency_key LIKE 'legal-delete-external:%'");
  const jobId = firstRow<{ id: string }>(job).id;
  const failedAt = new Date(now.valueOf() + 2_000);
  await db.client.query("UPDATE jobs SET status = 'leased', lease_owner = 'render-worker-1', lease_epoch = 1, lease_expires_at = $1, attempt = 1 WHERE id = $2", [new Date(now.valueOf() + 60_000).toISOString(), jobId]);
  const failed = await finishJob(db, {
    id: jobId,
    workerId: 'render-worker-1',
    leaseEpoch: 1,
    succeeded: false,
    terminal: true,
    error: 'provider rejected deletion',
    errorCode: 'PROVIDER_REJECTED',
  }, failedAt);
  assert.equal('error' in failed, false);
  assert.equal(firstRow<{ status: string }>(await db.client.query("SELECT status FROM source_deletion_requests WHERE idempotency_key = 'delete-published-1'")).status, 'failed');
  assert.deepEqual(await processSourceLegalDeletions(db, storage, new Date(now.valueOf() + 2_500)), { processed: false });
  const retried = await retrySourceLegalDeletion(db, {
    sourceId: 'source-published',
    deletionRequestId: 'deletionRequestId' in requested ? String(requested.deletionRequestId) : '',
    reason: 'Provider credentials repaired',
    actor,
  }, new Date(now.valueOf() + 3_000));
  assert.equal('error' in retried, false);
  if ('error' in retried) return;
  assert.equal(retried.retriedJobs, 1);

  const finishedAt = new Date(now.valueOf() + 4_000);
  await db.client.query("UPDATE jobs SET status = 'leased', lease_owner = 'render-worker-1', lease_epoch = 2, lease_expires_at = $1, attempt = 1 WHERE id = $2", [new Date(now.valueOf() + 60_000).toISOString(), jobId]);
  const finished = await finishJob(db, {
    id: jobId,
    workerId: 'render-worker-1',
    leaseEpoch: 2,
    succeeded: true,
    result: { externalId: 'youtube-video-1', withdrawn: true },
  }, finishedAt);
  assert.equal('error' in finished, false);
  assert.equal(firstRow<{ status: string }>(await db.client.query("SELECT status FROM publish_jobs WHERE id = 'publish-published'")).status, 'withdrawn');
  assert.equal(firstRow<{ status: string }>(await db.client.query("SELECT status FROM source_deletion_items WHERE kind = 'external_publish'")).status, 'confirmed');

  const completed = await processSourceLegalDeletions(db, storage, new Date(now.valueOf() + 5_000));
  assert.equal(completed.completed, true);
  assert.equal(firstRow<{ total: number }>(await db.client.query("SELECT COUNT(*)::int AS total FROM content_projects WHERE id = 'project-published'")).total, 0);
});
