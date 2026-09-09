import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  fetchOutcomeFromCheckpoint,
  fetchOutcomeFromNotModified,
  hasNotModifiedPayloadConflict,
  SOURCE_FETCH_OUTCOMES,
} from '../lib/source-fetch-outcome.ts';
import { createMemoryPg } from './pg-memory.ts';

void test('fetch outcome classifies explicit 304 and rejects contradictory payloads', () => {
  assert.deepEqual(SOURCE_FETCH_OUTCOMES, [
    'unknown',
    'modified',
    'not_modified',
  ]);
  assert.equal(fetchOutcomeFromNotModified(true), 'not_modified');
  assert.equal(fetchOutcomeFromNotModified(false), 'modified');
  assert.equal(fetchOutcomeFromNotModified(undefined), 'unknown');
  assert.equal(
    hasNotModifiedPayloadConflict('not_modified', {
      fetchedCount: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      byteCount: 0,
    }),
    false,
  );
  assert.equal(
    hasNotModifiedPayloadConflict('not_modified', {
      fetchedCount: 0,
      acceptedCount: 1,
      rejectedCount: 0,
      byteCount: 0,
    }),
    true,
  );
});

void test('paged completion derives only registered fetch outcomes from checkpoint', () => {
  assert.equal(
    fetchOutcomeFromCheckpoint({ lastFetchOutcome: 'not_modified' }),
    'not_modified',
  );
  assert.equal(
    fetchOutcomeFromCheckpoint({ lastFetchOutcome: 'modified' }),
    'modified',
  );
  assert.equal(
    fetchOutcomeFromCheckpoint({ lastFetchOutcome: 'invented' }),
    'unknown',
  );
});

void test('worker, completion routes and OpenAPI keep fetch outcome wiring explicit', async () => {
  const [worker, commitRoute, completeRoute, openapi] = await Promise.all([
    readFile(new URL('../render-worker/worker.ts', import.meta.url), 'utf8'),
    readFile(
      new URL(
        '../app/api/v1/ingestion-runs/[id]/commit/route.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(
      new URL(
        '../app/api/v1/ingestion-runs/[id]/complete/route.ts',
        import.meta.url,
      ),
      'utf8',
    ),
    readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'),
  ]);
  assert.match(worker, /lastFetchOutcome:/);
  assert.match(worker, /notModified,/);
  assert.match(commitRoute, /fetch_outcome = \?/);
  assert.match(completeRoute, /fetch_outcome = \?/);
  assert.match(openapi, /fetchOutcome: \{ type: string, enum: \[unknown, modified, not_modified\] \}/);
  assert.match(openapi, /notModified: \{ type: boolean \}/);
});

void test('database rejects unregistered ingestion fetch outcomes', async () => {
  const db = await createMemoryPg();
  await db.client.query(
    "INSERT INTO source_configs (id, name, adapter, platform, config_json, rights_status, enabled, version, lifecycle_status, health_status, config_hash, created_at, updated_at) VALUES ('source-outcome', 'Outcome', 'rss', 'rss', '{}', 'pending', 0, 1, 'draft', 'unknown', 'hash', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')",
  );
  await db.client.query(
    "INSERT INTO ingestion_runs (id, source_config_id, status, fetch_outcome, created_at) VALUES ('run-outcome', 'source-outcome', 'queued', 'unknown', '2026-09-09T00:00:00.000Z')",
  );
  await assert.rejects(
    db.client.query(
      "UPDATE ingestion_runs SET fetch_outcome = 'cached' WHERE id = 'run-outcome'",
    ),
    /ingestion_runs_fetch_outcome_check/,
  );
});
