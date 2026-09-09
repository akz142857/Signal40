import assert from 'node:assert/strict';
import test from 'node:test';
import { archiveSource, disconnectSource, withdrawSourceContent } from '../lib/source-lifecycle.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T01:00:00.000Z');
const actor = { id: 'admin-1', email: 'admin@signal40.test', role: 'admin' as const };

async function seedSource(id: string) {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, rights_status, enabled, version,
       lifecycle_status, health_status, config_hash, credential_ref,
       credential_version, created_at, updated_at)
    VALUES ($1, 'Feed', 'rss', '{}', 'approved', 1, 3, 'enabled', 'healthy',
      'hash-v3', 'secret-ref', 2, $2, $2)
  `, [id, now.toISOString()]);
  await db.client.query(`
    INSERT INTO jobs
      (id, kind, payload_json, status, idempotency_key, available_at, created_at, updated_at)
    VALUES ('job-queued', 'ingestion', '{}', 'queued', $1, $2, $2, $2)
  `, [`${id}:queued`, now.toISOString()]);
  await db.client.query(`
    INSERT INTO ingestion_runs
      (id, source_config_id, job_id, status, created_at)
    VALUES ('run-queued', $1, 'job-queued', 'queued', $2)
  `, [id, now.toISOString()]);
  await db.client.query("UPDATE source_configs SET active_run_id = 'run-queued' WHERE id = $1", [id]);
  return db;
}

void test('archiving disables a source and atomically cancels work that has not started', async () => {
  const db = await seedSource('source-archive');
  const result = await archiveSource(db, {
    sourceId: 'source-archive', expectedVersion: 3, reason: 'No longer monitored', actor,
  }, now);
  assert.deepEqual(result, { status: 200, sourceId: 'source-archive', version: 4, cancelledRuns: 1 });
  const source = await db.client.query("SELECT enabled, lifecycle_status, health_status, active_run_id, archived_at, version FROM source_configs WHERE id = 'source-archive'");
  assert.deepEqual(source.rows[0], {
    enabled: 0, lifecycle_status: 'archived', health_status: 'paused',
    active_run_id: null, archived_at: now.toISOString(), version: 4,
  });
  assert.equal(((await db.client.query("SELECT status FROM jobs WHERE id = 'job-queued'")).rows[0] as { status: string }).status, 'cancelled');
  assert.equal(((await db.client.query("SELECT status FROM ingestion_runs WHERE id = 'run-queued'")).rows[0] as { status: string }).status, 'cancelled');
});

void test('disconnecting revokes pending sessions, rotates the credential version, and rejects stale versions', async () => {
  const db = await seedSource('source-disconnect');
  await db.client.query(`
    INSERT INTO source_connection_sessions
      (id, source_config_id, initiated_by, connector, status, state_hash, expires_at, created_at)
    VALUES ('session-1', 'source-disconnect', 'admin-1', 'rss-v1', 'pending', 'state-hash', $1, $2)
  `, [new Date(now.valueOf() + 60_000).toISOString(), now.toISOString()]);
  const result = await disconnectSource(db, {
    sourceId: 'source-disconnect', expectedVersion: 3, reason: 'Rotate access', actor,
  }, now);
  assert.equal('error' in result, false);
  const source = await db.client.query("SELECT enabled, lifecycle_status, health_status, credential_ref, credential_version, version FROM source_configs WHERE id = 'source-disconnect'");
  assert.deepEqual(source.rows[0], {
    enabled: 0, lifecycle_status: 'auth_required', health_status: 'auth_required',
    credential_ref: null, credential_version: 3, version: 4,
  });
  assert.equal(((await db.client.query("SELECT status FROM source_connection_sessions WHERE id = 'session-1'")).rows[0] as { status: string }).status, 'revoked');
  assert.equal(((await db.client.query("SELECT kind FROM source_connection_events WHERE source_config_id = 'source-disconnect'")).rows[0] as { kind: string }).kind, 'disconnected');
  assert.deepEqual(
    await disconnectSource(db, { sourceId: 'source-disconnect', expectedVersion: 3, reason: 'stale', actor }, now),
    { status: 409, error: '版本冲突：当前版本为 4。' },
  );
});

void test('content withdrawal tombstones origins, revokes rights, and enqueues one idempotent recompute', async () => {
  const db = await seedSource('source-withdraw');
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, purpose, usage_scope,
       evidence_ref, terms_version, verified_by, granted_at, verified_at, created_at)
    VALUES ('rights-withdraw', 'source-withdraw', 'admin-1', 'rss', 'research',
      'metadata', 'confirmation', 'v1', 'admin-1', $1, $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_item_origins
      (id, source_config_id, namespace, platform_item_id, article_id,
       ingestion_run_id, canonical_url_hash, fingerprint_version,
       content_fingerprint, first_seen_at, last_seen_at)
    VALUES ('origin-withdraw', 'source-withdraw', 'rss', 'item-1', 'article-1',
      'run-old', 'url-hash', 'v1', 'content-hash', $1, $1)
  `, [now.toISOString()]);
  const first = await withdrawSourceContent(db, {
    sourceId: 'source-withdraw', expectedVersion: 3, reason: 'Rights withdrawn',
    idempotencyKey: 'withdraw-key', actor,
  }, now);
  assert.equal('error' in first, false);
  if ('error' in first) return;
  assert.equal(first.withdrawnOrigins, 1);
  assert.equal(first.replayed, false);
  const source = await db.client.query("SELECT rights_status, enabled, lifecycle_status, version FROM source_configs WHERE id = 'source-withdraw'");
  assert.deepEqual(source.rows[0], { rights_status: 'revoked', enabled: 0, lifecycle_status: 'paused', version: 4 });
  assert.equal(((await db.client.query("SELECT deleted_at FROM source_item_origins WHERE id = 'origin-withdraw'")).rows[0] as { deleted_at: string }).deleted_at, now.toISOString());
  assert.equal(((await db.client.query("SELECT revoked_at FROM source_rights_grants WHERE id = 'rights-withdraw'")).rows[0] as { revoked_at: string }).revoked_at, now.toISOString());
  assert.equal(Number(((await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE required_capability = 'source:pipeline'")).rows[0] as { total: number }).total), 1);

  const replay = await withdrawSourceContent(db, {
    sourceId: 'source-withdraw', expectedVersion: 3, reason: 'replayed request',
    idempotencyKey: 'withdraw-key', actor,
  }, new Date(now.valueOf() + 1_000));
  assert.equal('error' in replay, false);
  if ('error' in replay) return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.pipelineJobId, first.pipelineJobId);
  assert.equal(Number(((await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE required_capability = 'source:pipeline'")).rows[0] as { total: number }).total), 1);
});
