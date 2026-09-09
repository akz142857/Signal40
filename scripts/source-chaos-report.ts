import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { enqueueIngestionRun, finishJob, leaseNextJob } from '../lib/control-plane.ts';
import { materializeIngestionPayload, type StagedIngestionPayload } from '../lib/source-ingestion-materialization.ts';
import { pageReplayDecision } from '../lib/source-page-protocol.ts';
import { storeRawPayloadUpload } from '../lib/source-raw-payloads.ts';
import type { ObjectStorage } from '../lib/storage.ts';
import { createMemoryPg } from '../test/pg-memory.ts';

const SEED = 'signal40-source-chaos-2026-09-09-v1';
const BASE_TIME = new Date('2030-01-01T00:00:00.000Z');
const ACTOR = { id: 'chaos-admin', email: 'chaos@signal40.test', role: 'admin' as const };

type Check = {
  id: string;
  status: 'passed';
  evidence: Record<string, unknown>;
};

type Snapshot = {
  activeRuns: number;
  pages: number;
  origins: number;
  duplicateOriginGroups: number;
  revisions: number;
  duplicateRevisionGroups: number;
  recomputeJobs: number;
  checkpointVersion: number;
  checkpointJson: unknown;
};

function at(seconds: number) {
  return new Date(BASE_TIME.valueOf() + seconds * 1_000);
}

function passing(id: string, evidence: Record<string, unknown>): Check {
  return { id, status: 'passed', evidence };
}

function storageThat(put: 'succeeds' | 'fails'): ObjectStorage {
  return {
    get: async () => null,
    put: async () => {
      if (put === 'fails') throw new Error('INJECTED_OBJECT_UPLOAD_FAILURE');
    },
    delete: async () => undefined,
    list: async () => ({ objects: [], truncated: false }),
    createMultipartUpload: async () => { throw new Error('not used'); },
    resumeMultipartUpload: () => { throw new Error('not used'); },
  };
}

async function snapshot(
  db: Awaited<ReturnType<typeof createMemoryPg>>,
  sourceId: string,
  runId: string,
): Promise<Snapshot> {
  const scalar = async (sql: string, values: unknown[] = []) => Number(
    ((await db.client.query(sql, values)).rows[0] as { total: number | string }).total,
  );
  const source = (await db.client.query(
    'SELECT checkpoint_version, checkpoint_json FROM source_configs WHERE id = $1',
    [sourceId],
  )).rows[0] as { checkpoint_version: number; checkpoint_json: unknown };
  return {
    activeRuns: await scalar(
      "SELECT COUNT(*) AS total FROM ingestion_runs WHERE source_config_id = $1 AND status IN ('queued', 'running')",
      [sourceId],
    ),
    pages: await scalar('SELECT COUNT(*) AS total FROM ingestion_pages WHERE ingestion_run_id = $1', [runId]),
    origins: await scalar('SELECT COUNT(*) AS total FROM source_item_origins WHERE ingestion_run_id = $1', [runId]),
    duplicateOriginGroups: await scalar(`
      SELECT COUNT(*) AS total FROM (
        SELECT source_config_id, namespace, platform_item_id
        FROM source_item_origins
        GROUP BY source_config_id, namespace, platform_item_id
        HAVING COUNT(*) > 1
      ) duplicate_origins
    `),
    revisions: await scalar(`
      SELECT COUNT(*) AS total FROM article_revisions revision
      JOIN source_item_origins origin ON origin.article_revision_id = revision.id
      WHERE origin.ingestion_run_id = $1
    `, [runId]),
    duplicateRevisionGroups: await scalar(`
      SELECT COUNT(*) AS total FROM (
        SELECT article_id, content_hash FROM article_revisions
        GROUP BY article_id, content_hash HAVING COUNT(*) > 1
      ) duplicate_revisions
    `),
    recomputeJobs: await scalar(`
      SELECT COUNT(*) AS total FROM jobs
      WHERE kind = 'ingestion' AND payload_json ->> 'sourceIngestionRunId' = $1
    `, [runId]),
    checkpointVersion: Number(source.checkpoint_version),
    checkpointJson: source.checkpoint_json,
  };
}

async function seedSource(db: Awaited<ReturnType<typeof createMemoryPg>>, sourceId: string) {
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, platform, source_type, config_json, config_hash,
       rights_config_hash, rights_status, enabled, lifecycle_status, health_status,
       version, checkpoint_json, created_at, updated_at)
    VALUES ($1, 'Chaos Public JSON', 'http', 'http_json', 'media',
      '{"sourceType":"media","url":"https://api.example.com/feed"}', 'chaos-config-v1',
      'chaos-config-v1', 'approved', 1, 'enabled', 'healthy', 1,
      '{"cursor":"0"}', $2, $2)
  `, [sourceId, BASE_TIME.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ($1, $2, 'chaos-admin', 'http_json',
      '["title","summary","url","publishedAt","author"]',
      'finance-editorial-ingestion', 'normalized-metadata', 'chaos-fixture', 'v1',
      'chaos-reviewer', $3, $3, 1, 'chaos-config-v1', $3)
  `, [`rights-${sourceId}`, sourceId, BASE_TIME.toISOString()]);
}

const stagedPayload: StagedIngestionPayload = {
  articles: [{
    id: 'chaos-article',
    source: 'Chaos source',
    sourceType: 'media',
    author: 'Chaos author',
    title: 'Deterministic chaos item',
    summary: 'A deterministic local transaction fixture.',
    url: 'https://example.com/chaos/item-1',
    publishedAt: '2030-01-01T00:00:10.000Z',
    metrics: {},
    contentHash: 'chaos-content-v1',
  }],
  origins: [{ namespace: 'http_json', platformItemId: 'item-1', url: 'https://example.com/chaos/item-1' }],
  rejections: [],
  skippedCount: 0,
};

async function stagePage(
  db: Awaited<ReturnType<typeof createMemoryPg>>,
  runId: string,
  leaseEpoch: number,
  failBeforeCommit: boolean,
) {
  await db.transaction(async (tx) => {
    await tx.prepare(`
      INSERT INTO ingestion_pages
        (id, ingestion_run_id, page_key, page_ordinal, content_hash, lease_epoch,
         final_page, checkpoint_before_json, checkpoint_after_json, status,
         result_json, staged_payload_json, fetched_count, accepted_count,
         rejected_count, duplicate_count, request_count, byte_count, created_at, committed_at)
      VALUES (?, ?, 'page-0', 0, ?, ?, 1, ?, ?, 'committed', ?, ?, 1, 1, 0, 0, 1, 128, ?, ?)
    `).bind(
      `page-${runId}`,
      runId,
      `sha256:${'a'.repeat(64)}`,
      leaseEpoch,
      JSON.stringify({ cursor: '0' }),
      JSON.stringify({ cursor: '1' }),
      JSON.stringify({ ingestionRunId: runId, pageKey: 'page-0', status: 'committed' }),
      JSON.stringify(stagedPayload),
      at(10).toISOString(),
      at(10).toISOString(),
    ).run();
    await tx.prepare(`
      UPDATE ingestion_runs SET checkpoint_after_json = ?, fetched_count = 1,
        accepted_count = 1, request_count = 1, byte_count = 128
      WHERE id = ?
    `).bind(JSON.stringify({ cursor: '1' }), runId).run();
    if (failBeforeCommit) throw new Error('INJECTED_PAGE_COMMIT_FAILURE');
  });
}

async function completeRun(
  db: Awaited<ReturnType<typeof createMemoryPg>>,
  sourceId: string,
  runId: string,
  failBeforeCommit: boolean,
) {
  await db.transaction(async (tx) => {
    const page = await tx.prepare(`
      SELECT staged_payload_json FROM ingestion_pages
      WHERE ingestion_run_id = ? AND page_key = 'page-0' FOR UPDATE
    `).bind(runId).first<{ staged_payload_json: unknown }>();
    assert.ok(page);
    await materializeIngestionPayload(tx, {
      sourceConfigId: sourceId,
      ingestionRunId: runId,
      platform: 'http_json',
      publisherEntityId: sourceId,
      payload: stagedPayload,
      observedAt: at(20),
    });
    const promoted = await tx.prepare(`
      UPDATE source_configs SET checkpoint_json = ?, checkpoint_version = checkpoint_version + 1,
        active_run_id = NULL, updated_at = ?
      WHERE id = ? AND checkpoint_version = 0 AND active_run_id = ?
    `).bind(JSON.stringify({ cursor: '1' }), at(20).toISOString(), sourceId, runId).run();
    assert.equal(Number(promoted.meta.changes), 1);
    await tx.prepare(`
      UPDATE ingestion_runs SET status = 'succeeded', checkpoint_after_json = ?,
        result_json = ?, finished_at = ? WHERE id = ?
    `).bind(
      JSON.stringify({ cursor: '1' }),
      JSON.stringify({ protocol: 'page-v1-complete', ingestionRunId: runId, status: 'succeeded' }),
      at(20).toISOString(),
      runId,
    ).run();
    await tx.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, payload_schema_version, payload_json,
         status, idempotency_key, available_at, created_at, updated_at)
      VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, ?, ?, ?)
      ON CONFLICT (kind, idempotency_key) DO NOTHING
    `).bind(
      `pipeline-${runId}`,
      JSON.stringify({ schemaVersion: 2, operation: 'topic_recompute', sourceIngestionRunId: runId }),
      `topic-recompute:${runId}`,
      at(20).toISOString(),
      at(20).toISOString(),
      at(20).toISOString(),
    ).run();
    if (failBeforeCommit) throw new Error('INJECTED_COMPLETE_COMMIT_FAILURE');
  });
}

export async function runLocalSourceChaosDrill() {
  const startedAt = new Date();
  const db = await createMemoryPg();
  const sourceId = 'source-chaos';
  const checks: Check[] = [];
  await seedSource(db, sourceId);

  const enqueues = await Promise.all([
    enqueueIngestionRun(db, {
      sourceConfigId: sourceId,
      idempotencyKey: 'schedule:source-chaos:2030-01-01T00:00:00.000Z',
      actor: ACTOR,
      trigger: 'automation',
      runTrigger: 'schedule',
      scheduledFor: BASE_TIME.toISOString(),
    }, BASE_TIME),
    enqueueIngestionRun(db, {
      sourceConfigId: sourceId,
      idempotencyKey: 'schedule:source-chaos:2030-01-01T00:00:00.000Z',
      actor: ACTOR,
      trigger: 'automation',
      runTrigger: 'schedule',
      scheduledFor: BASE_TIME.toISOString(),
    }, BASE_TIME),
  ]);
  const runId = enqueues[0].ingestionRunId;
  assert.ok(runId);
  assert.equal(enqueues[1].ingestionRunId, runId);
  assert.deepEqual(enqueues.map((item) => item.created).sort((left, right) => Number(left) - Number(right)), [false, true]);
  const afterSchedulers = await snapshot(db, sourceId, runId);
  assert.equal(afterSchedulers.activeRuns, 1);
  checks.push(passing('two-schedulers-idempotent-enqueue', {
    schedulers: 2,
    createdRuns: 1,
    activeRuns: afterSchedulers.activeRuns,
  }));

  await assert.rejects(enqueueIngestionRun(db, {
    sourceConfigId: sourceId,
    idempotencyKey: 'backfill:source-chaos:overlap',
    actor: ACTOR,
    runTrigger: 'backfill',
  }, at(1)), /\u6d3b\u52a8\u91c7\u96c6\u8fd0\u884c/);
  checks.push(passing('live-backfill-overlap-serialized', { activeRuns: 1, secondRun: 'rejected' }));

  const legacyLease = await leaseNextJob(db, {
    workerId: 'worker-legacy-v1',
    kinds: ['ingestion'],
    capabilities: ['source:http-json'],
    capabilityProtocolVersions: { 'source:http-json': 1 },
    maxPayloadSchemaVersion: 2,
    leaseSeconds: 30,
  }, at(2));
  assert.equal(legacyLease, null);
  const firstLease = await leaseNextJob(db, {
    workerId: 'worker-page-v2-a',
    kinds: ['ingestion'],
    capabilities: ['source:http-json'],
    capabilityProtocolVersions: { 'source:http-json': 2 },
    maxPayloadSchemaVersion: 2,
    leaseSeconds: 30,
  }, at(3)) as unknown as { id: string; lease_epoch: number };
  assert.ok(firstLease);
  assert.equal(Number(firstLease.lease_epoch), 1);
  checks.push(passing('mixed-worker-protocol-fencing', {
    workers: 3,
    legacyLease: false,
    acceptedProtocol: 2,
    leaseEpoch: 1,
  }));

  const rawObjectKey = `sources/${sourceId}/raw/${runId}/payload.json`;
  const rawInput = {
    sourceConfigId: sourceId,
    ingestionRunId: runId,
    objectKey: rawObjectKey,
    data: new TextEncoder().encode('{"fixture":true}').buffer,
    contentType: 'application/json',
    expiresAt: at(3_600).toISOString(),
    deleteAfter: at(7_200).toISOString(),
  };
  await assert.rejects(
    storeRawPayloadUpload(db, storageThat('fails'), rawInput, at(4)),
    /INJECTED_OBJECT_UPLOAD_FAILURE/,
  );
  const aborted = (await db.client.query(
    'SELECT state FROM raw_payload_uploads WHERE ingestion_run_id = $1',
    [runId],
  )).rows[0] as { state: string };
  assert.equal(aborted.state, 'aborted');
  const retriedUpload = await storeRawPayloadUpload(db, storageThat('succeeds'), rawInput, at(5));
  const uploaded = (await db.client.query(
    'SELECT state FROM raw_payload_uploads WHERE ingestion_run_id = $1',
    [runId],
  )).rows[0] as { state: string };
  assert.equal(uploaded.state, 'uploaded');
  assert.equal(retriedUpload.replayed, true);
  checks.push(passing('raw-upload-failure-replay', {
    failedState: aborted.state,
    replayed: retriedUpload.replayed,
    recoveredState: uploaded.state,
  }));

  await assert.rejects(stagePage(db, runId, 1, true), /INJECTED_PAGE_COMMIT_FAILURE/);
  const afterPageRollback = await snapshot(db, sourceId, runId);
  assert.equal(afterPageRollback.pages, 0);
  assert.equal(afterPageRollback.origins, 0);
  assert.equal(afterPageRollback.checkpointVersion, 0);
  await stagePage(db, runId, 1, false);
  const persistedPage = (await db.client.query(`
    SELECT content_hash, lease_epoch FROM ingestion_pages
    WHERE ingestion_run_id = $1 AND page_key = 'page-0'
  `, [runId])).rows[0] as { content_hash: string; lease_epoch: number };
  assert.equal(pageReplayDecision(
    { contentHash: persistedPage.content_hash, leaseEpoch: Number(persistedPage.lease_epoch) },
    { contentHash: `sha256:${'a'.repeat(64)}`, leaseEpoch: 1 },
  ), 'replay');
  assert.equal(pageReplayDecision(
    { contentHash: persistedPage.content_hash, leaseEpoch: Number(persistedPage.lease_epoch) },
    { contentHash: `sha256:${'b'.repeat(64)}`, leaseEpoch: 1 },
  ), 'conflict');
  const staged = await snapshot(db, sourceId, runId);
  assert.equal(staged.pages, 1);
  assert.equal(staged.origins, 0);
  assert.equal(staged.recomputeJobs, 0);
  assert.equal(staged.checkpointVersion, 0);
  checks.push(passing('page-commit-rollback-and-ack-loss', {
    rolledBackPages: afterPageRollback.pages,
    committedPages: staged.pages,
    replayDecision: 'replay',
    conflictingReplayDecision: 'conflict',
  }));
  checks.push(passing('staged-content-invisible', {
    stagedPages: staged.pages,
    visibleOrigins: staged.origins,
    recomputeJobs: staged.recomputeJobs,
    sourceCheckpointVersion: staged.checkpointVersion,
  }));

  const takeover = await leaseNextJob(db, {
    workerId: 'worker-page-v2-b',
    kinds: ['ingestion'],
    capabilities: ['source:http-json'],
    capabilityProtocolVersions: { 'source:http-json': 2 },
    maxPayloadSchemaVersion: 2,
    leaseSeconds: 300,
  }, at(40)) as unknown as { id: string; lease_epoch: number };
  assert.ok(takeover);
  assert.equal(Number(takeover.lease_epoch), 2);
  const staleFinish = await finishJob(db, {
    id: firstLease.id,
    workerId: 'worker-page-v2-a',
    leaseEpoch: 1,
    succeeded: true,
  }, at(41));
  assert.equal('error' in staleFinish, true);
  const afterStaleWorker = await snapshot(db, sourceId, runId);
  assert.deepEqual(afterStaleWorker, staged);
  checks.push(passing('expired-lease-takeover-and-old-epoch-fence', {
    previousEpoch: 1,
    takeoverEpoch: 2,
    staleMutation: false,
    snapshotUnchanged: true,
  }));

  await assert.rejects(completeRun(db, sourceId, runId, true), /INJECTED_COMPLETE_COMMIT_FAILURE/);
  const afterCompleteRollback = await snapshot(db, sourceId, runId);
  assert.deepEqual(afterCompleteRollback, staged);
  await completeRun(db, sourceId, runId, false);
  const completed = await snapshot(db, sourceId, runId);
  assert.equal(completed.activeRuns, 0);
  assert.equal(completed.origins, 1);
  assert.equal(completed.revisions, 1);
  assert.equal(completed.duplicateOriginGroups, 0);
  assert.equal(completed.duplicateRevisionGroups, 0);
  assert.equal(completed.recomputeJobs, 1);
  assert.equal(completed.checkpointVersion, 1);
  checks.push(passing('complete-transaction-rollback', {
    before: staged,
    afterInjectedFailure: afterCompleteRollback,
  }));
  checks.push(passing('complete-atomic-publication', { before: staged, after: completed }));

  const persistedResult = (await db.client.query(
    'SELECT result_json FROM ingestion_runs WHERE id = $1',
    [runId],
  )).rows[0] as { result_json: unknown };
  const replaySnapshot = await snapshot(db, sourceId, runId);
  assert.deepEqual(replaySnapshot, completed);
  checks.push(passing('complete-ack-loss-replay-read-only', {
    persistedResult: persistedResult.result_json,
    snapshotUnchanged: true,
    recomputeJobs: replaySnapshot.recomputeJobs,
  }));

  return {
    schemaVersion: 1,
    kind: 'source-ingestion-local-seeded-chaos',
    seed: SEED,
    scope: 'Local PGlite transactions and production control-plane/materialization helpers; not a process, container, network, cloud IAM, or remote object-store acceptance.',
    topology: {
      schedulers: ['scheduler-a', 'scheduler-b'],
      workers: [
        { id: 'worker-legacy-v1', protocol: 1 },
        { id: 'worker-page-v2-a', protocol: 2 },
        { id: 'worker-page-v2-b', protocol: 2 },
      ],
    },
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.valueOf(),
    checks,
    summary: { passed: checks.length, failed: 0 },
    externalPending: [
      'real process/container SIGKILL at every boundary',
      'real 429, timeout, socket disconnect, DNS and clock-skew injection',
      'real multipart/object-store partial failure and orphan sweeper',
      'credential and rights mutation through deployed APIs during an in-flight run',
      'mixed deployed image versions and remote before/after SQL evidence',
    ],
  };
}

function outputPathFromArgs() {
  const index = process.argv.indexOf('--output');
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runLocalSourceChaosDrill();
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  const output = outputPathFromArgs();
  if (output) await writeFile(output, rendered, 'utf8');
  process.stdout.write(rendered);
}
