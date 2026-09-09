import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { enqueueIngestionRun } from '../lib/control-plane.ts';
import {
  commitShadowIngestion,
  connectorCanaryBucket,
  effectiveConnectorRollout,
  evaluateConnectorCanaries,
  getConnectorReleaseControl,
  quarantineConnectorRolloutChangedIngestion,
  setConnectorReleaseControl,
} from '../lib/source-release-control.ts';
import { sourceConnectorById } from '../lib/source-connectors/registry.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T02:10:00.000Z');
const actor = {
  id: 'admin-release',
  email: 'admin@signal40.test',
  role: 'admin' as const,
};

function rssConnector() {
  const connector = sourceConnectorById('rss-v1', '1');
  assert.ok(connector);
  return connector;
}

async function seedEnabledSource(
  db: Awaited<ReturnType<typeof createMemoryPg>>,
  id: string,
) {
  await db.client.query(
    `
    INSERT INTO source_configs
      (id, name, adapter, platform, config_json, config_hash, rights_status,
       enabled, lifecycle_status, health_status, created_at, updated_at)
    VALUES ($1, $1, 'rss', 'rss', '{}', $2, 'approved', 1, 'enabled',
      'healthy', $3, $3)
  `,
    [id, `hash-${id}`, now.toISOString()],
  );
  await db.client.query(
    `
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ($1, $2, 'admin', 'rss', '["title","url","publishedAt"]',
      'finance-editorial-ingestion', 'normalized-metadata', 'confirmation', 'v1',
      'admin', $3, $3, 1, $4, $3)
  `,
    [`rights-${id}`, id, now.toISOString(), `hash-${id}`],
  );
}

void test('canary uses a stable source bucket and sends non-selected sources to shadow', () => {
  const selected = Array.from({ length: 1_000 }, (_, index) => `source-${index}`)
    .find((id) => connectorCanaryBucket(id, 'rss-v1', '1') < 10);
  const notSelected = Array.from({ length: 1_000 }, (_, index) => `source-${index}`)
    .find((id) => connectorCanaryBucket(id, 'rss-v1', '1') >= 10);
  assert.ok(selected);
  assert.ok(notSelected);
  assert.equal(
    connectorCanaryBucket(selected, 'rss-v1', '1'),
    connectorCanaryBucket(selected, 'rss-v1', '1'),
  );
  const control = {
    connectorId: 'rss-v1',
    connectorVersion: '1',
    rolloutMode: 'enabled' as const,
    canaryEnabled: true,
    canaryPercent: 10,
  };
  assert.deepEqual(effectiveConnectorRollout(control, selected), {
    mode: 'enabled',
    canarySelected: true,
    canaryBucket: connectorCanaryBucket(selected, 'rss-v1', '1'),
  });
  assert.deepEqual(effectiveConnectorRollout(control, notSelected), {
    mode: 'shadow',
    canarySelected: false,
    canaryBucket: connectorCanaryBucket(notSelected, 'rss-v1', '1'),
  });
});

void test('canary selection is persisted in job payload and run visibility mode', async () => {
  const db = await createMemoryPg();
  const control = await getConnectorReleaseControl(db, 'rss-v1', '1');
  const changed = await setConnectorReleaseControl(db, {
    connector: rssConnector(),
    rolloutMode: 'enabled',
    expectedVersion: control?.version ?? 0,
    reason: '10% 来源灰度',
    actor,
    canary: { enabled: true, percent: 10, failureRateBps: 2_000, minRuns: 20 },
  }, now);
  assert.equal('error' in changed, false);

  const ids = Array.from({ length: 1_000 }, (_, index) => `canary-source-${index}`);
  const selected = ids.find((id) => connectorCanaryBucket(id, 'rss-v1', '1') < 10);
  const notSelected = ids.find((id) => connectorCanaryBucket(id, 'rss-v1', '1') >= 10);
  assert.ok(selected);
  assert.ok(notSelected);
  for (const id of [selected, notSelected]) await seedEnabledSource(db, id);
  const selectedJob = await enqueueIngestionRun(db, {
    sourceConfigId: selected,
    idempotencyKey: 'canary-selected',
    actor,
  }, now);
  const shadowJob = await enqueueIngestionRun(db, {
    sourceConfigId: notSelected,
    idempotencyKey: 'canary-shadow',
    actor,
  }, now);
  const jobs = await db.client.query(
    'SELECT id, payload_json FROM jobs WHERE id = ANY($1) ORDER BY id',
    [[selectedJob.id, shadowJob.id]],
  );
  const byId = new Map(
    (
      jobs.rows as Array<{
        id: string;
        payload_json: Record<string, unknown>;
      }>
    ).map((row) => [String(row.id), row.payload_json]),
  );
  assert.equal(byId.get(selectedJob.id)?.configuredRolloutMode, 'enabled');
  assert.equal(byId.get(selectedJob.id)?.canarySelected, true);
  assert.equal(byId.get(selectedJob.id)?.shadow, false);
  assert.equal(byId.get(shadowJob.id)?.canarySelected, false);
  assert.equal(byId.get(shadowJob.id)?.rolloutMode, 'shadow');
  assert.equal(byId.get(shadowJob.id)?.shadow, true);
  const runs = await db.client.query(
    'SELECT id, shadow FROM ingestion_runs WHERE id = ANY($1) ORDER BY id',
    [[selectedJob.ingestionRunId, shadowJob.ingestionRunId]],
  );
  const runMode = new Map(
    (runs.rows as Array<{ id: string; shadow: number }>).map((row) => [
      String(row.id),
      Number(row.shadow),
    ]),
  );
  assert.equal(runMode.get(String(selectedJob.ingestionRunId)), 0);
  assert.equal(runMode.get(String(shadowJob.ingestionRunId)), 1);
});

void test('starting or changing canary cancels unleased runs so they are rescheduled with the new bucket', async () => {
  const db = await createMemoryPg();
  await seedEnabledSource(db, 'canary-transition');
  const stale = await enqueueIngestionRun(db, {
    sourceConfigId: 'canary-transition',
    idempotencyKey: 'canary-before-transition',
    actor,
  }, now);
  const control = await getConnectorReleaseControl(db, 'rss-v1', '1');
  const changed = await setConnectorReleaseControl(db, {
    connector: rssConnector(),
    rolloutMode: 'enabled',
    expectedVersion: control?.version ?? 0,
    reason: '启动 10% 灰度',
    actor,
    canary: { enabled: true, percent: 10, failureRateBps: 2_000, minRuns: 20 },
  }, new Date(now.valueOf() + 1_000));
  assert.equal('error' in changed, false);
  if ('error' in changed) return;
  assert.equal(changed.cancelledJobs, 1);
  assert.equal(changed.cancelledRuns, 1);
  const job = await db.client.query('SELECT status FROM jobs WHERE id = $1', [stale.id]);
  assert.equal((job.rows[0] as { status: string }).status, 'cancelled');
  const run = await db.client.query(
    'SELECT status, quarantine_status, error_code FROM ingestion_runs WHERE id = $1',
    [stale.ingestionRunId],
  );
  assert.deepEqual(run.rows[0], {
    status: 'cancelled',
    quarantine_status: 'held',
    error_code: 'CONNECTOR_ROLLOUT_CHANGED',
  });
  const source = await db.client.query(
    "SELECT enabled, lifecycle_status, active_run_id FROM source_configs WHERE id = 'canary-transition'",
  );
  assert.deepEqual(source.rows[0], {
    enabled: 1,
    lifecycle_status: 'enabled',
    active_run_id: null,
  });
});

void test('a leased formal run invalidated by the current canary bucket is quarantined without pausing the source', async () => {
  const db = await createMemoryPg();
  const sourceId = Array.from({ length: 1_000 }, (_, index) => `leased-source-${index}`)
    .find((id) => connectorCanaryBucket(id, 'rss-v1', '1') >= 10);
  assert.ok(sourceId);
  await seedEnabledSource(db, sourceId);
  const stale = await enqueueIngestionRun(db, {
    sourceConfigId: sourceId,
    idempotencyKey: 'canary-leased-before-transition',
    actor,
  }, now);
  await db.client.query(
    "UPDATE jobs SET status = 'leased', lease_owner = 'source-worker', lease_epoch = 1, lease_expires_at = $1 WHERE id = $2",
    [new Date(now.valueOf() + 60_000).toISOString(), stale.id],
  );
  await db.client.query(
    "UPDATE ingestion_runs SET status = 'running', started_at = $1 WHERE id = $2",
    [now.toISOString(), stale.ingestionRunId],
  );
  const control = await getConnectorReleaseControl(db, 'rss-v1', '1');
  const changed = await setConnectorReleaseControl(db, {
    connector: rssConnector(),
    rolloutMode: 'enabled',
    expectedVersion: control?.version ?? 0,
    reason: '启动 10% 灰度',
    actor,
    canary: { enabled: true, percent: 10, failureRateBps: 2_000, minRuns: 20 },
  }, new Date(now.valueOf() + 1_000));
  assert.equal('error' in changed, false);
  if ('error' in changed) return;
  assert.equal(changed.cancelledJobs, 0);
  assert.equal(changed.cancelledRuns, 0);
  await db.transaction((tx) => quarantineConnectorRolloutChangedIngestion(tx, {
    sourceConfigId: sourceId,
    ingestionRunId: String(stale.ingestionRunId),
    reason: '当前 canary 稳定桶不允许正式写入。',
  }, new Date(now.valueOf() + 2_000)));
  const run = await db.client.query(
    'SELECT status, quarantine_status, error_code FROM ingestion_runs WHERE id = $1',
    [stale.ingestionRunId],
  );
  assert.deepEqual(run.rows[0], {
    status: 'failed',
    quarantine_status: 'held',
    error_code: 'CONNECTOR_ROLLOUT_CHANGED',
  });
  const source = await db.client.query(
    'SELECT enabled, lifecycle_status, active_run_id FROM source_configs WHERE id = $1',
    [sourceId],
  );
  assert.deepEqual(source.rows[0], {
    enabled: 1,
    lifecycle_status: 'enabled',
    active_run_id: null,
  });
});

void test('both ingestion completion routes re-check the current canary bucket before formal writes', async () => {
  for (const relative of [
    '../app/api/v1/ingestion-runs/[id]/commit/route.ts',
    '../app/api/v1/ingestion-runs/[id]/complete/route.ts',
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /effectiveConnectorRollout/);
    assert.match(source, /connector_canary_enabled/);
    assert.match(source, /CONNECTOR_ROLLOUT_CHANGED/);
    assert.match(source, /quarantineConnectorRolloutChangedIngestion/);
  }
});

void test('canary automatically disables the connector after its minimum sample reaches the failure threshold', async () => {
  const db = await createMemoryPg();
  const initial = await getConnectorReleaseControl(db, 'rss-v1', '1');
  const changed = await setConnectorReleaseControl(db, {
    connector: rssConnector(),
    rolloutMode: 'enabled',
    expectedVersion: initial?.version ?? 0,
    reason: '自动停止演练',
    actor,
    canary: { enabled: true, percent: 100, failureRateBps: 5_000, minRuns: 2 },
  }, now);
  assert.equal('error' in changed, false);
  await seedEnabledSource(db, 'canary-success');
  await seedEnabledSource(db, 'canary-failure');
  const succeeded = await enqueueIngestionRun(db, {
    sourceConfigId: 'canary-success', idempotencyKey: 'canary-success', actor,
  }, now);
  const failed = await enqueueIngestionRun(db, {
    sourceConfigId: 'canary-failure', idempotencyKey: 'canary-failure', actor,
  }, now);
  await db.client.query(
    "UPDATE ingestion_runs SET status = 'succeeded', finished_at = $1 WHERE id = $2",
    [new Date(now.valueOf() + 1_000).toISOString(), succeeded.ingestionRunId],
  );
  await db.client.query(
    "UPDATE ingestion_runs SET status = 'failed', finished_at = $1 WHERE id = $2",
    [new Date(now.valueOf() + 1_000).toISOString(), failed.ingestionRunId],
  );
  await db.client.query(
    "UPDATE jobs SET status = 'succeeded', updated_at = $1 WHERE id = ANY($2)",
    [new Date(now.valueOf() + 1_000).toISOString(), [succeeded.id, failed.id]],
  );
  await db.client.query(
    "UPDATE source_configs SET active_run_id = NULL WHERE id IN ('canary-success', 'canary-failure')",
  );
  const evaluation = await evaluateConnectorCanaries(
    db,
    actor,
    new Date(now.valueOf() + 2_000),
  );
  assert.equal(evaluation.stopped, 1);
  assert.deepEqual(evaluation.evaluated[0], {
    connectorId: 'rss-v1',
    connectorVersion: '1',
    total: 2,
    failed: 1,
    failureRateBps: 5_000,
    stopped: true,
  });
  const stopped = await getConnectorReleaseControl(db, 'rss-v1', '1');
  assert.equal(stopped?.rolloutMode, 'disabled');
  assert.equal(stopped?.canaryEnabled, false);
  assert.equal(stopped?.canaryStartedAt, now.toISOString());
  assert.equal(stopped?.canaryStoppedAt, new Date(now.valueOf() + 2_000).toISOString());
  const sources = await db.client.query(
    "SELECT id, enabled, lifecycle_status FROM source_configs WHERE id LIKE 'canary-%' ORDER BY id",
  );
  assert.deepEqual(sources.rows, [
    { id: 'canary-failure', enabled: 0, lifecycle_status: 'paused' },
    { id: 'canary-success', enabled: 0, lifecycle_status: 'paused' },
  ]);
});

void test('connector/version kill switch 取消未领取作业并停用受影响来源', async () => {
  const db = await createMemoryPg();
  await seedEnabledSource(db, 'source-kill');
  const job = await enqueueIngestionRun(
    db,
    {
      sourceConfigId: 'source-kill',
      idempotencyKey: 'release-kill',
      actor,
    },
    now,
  );
  const control = await getConnectorReleaseControl(db, 'rss-v1', '1');
  assert.equal(control?.rolloutMode, 'enabled');
  const result = await setConnectorReleaseControl(
    db,
    {
      connector: rssConnector(),
      rolloutMode: 'disabled',
      expectedVersion: control?.version ?? 0,
      reason: '测试紧急停用',
      actor,
    },
    new Date(now.valueOf() + 1_000),
  );
  assert.equal('error' in result, false);
  if ('error' in result) return;
  assert.equal(result.cancelledJobs, 1);
  assert.equal(result.cancelledRuns, 1);
  assert.equal(
    (
      (await db.client.query('SELECT status FROM jobs WHERE id = $1', [job.id]))
        .rows[0] as { status: string }
    ).status,
    'cancelled',
  );
  const source = await db.client.query(
    "SELECT enabled, lifecycle_status, health_status, active_run_id FROM source_configs WHERE id = 'source-kill'",
  );
  assert.deepEqual(source.rows[0], {
    enabled: 0,
    lifecycle_status: 'paused',
    health_status: 'paused',
    active_run_id: null,
  });
  assert.equal(
    Number(
      (
        (
          await db.client.query(
            "SELECT COUNT(*) AS total FROM audit_events WHERE action = 'source_connector.rollout_changed'",
          )
        ).rows[0] as { total: number }
      ).total,
    ),
    1,
  );
});

void test('shadow 发布模式被固化到 job/run，shadow commit 不写正式内容或 checkpoint', async () => {
  const db = await createMemoryPg();
  const control = await getConnectorReleaseControl(db, 'rss-v1', '1');
  const changed = await setConnectorReleaseControl(
    db,
    {
      connector: rssConnector(),
      rolloutMode: 'shadow',
      expectedVersion: control?.version ?? 0,
      reason: '灰度观察',
      actor,
    },
    now,
  );
  assert.equal('error' in changed, false);
  await seedEnabledSource(db, 'source-shadow');
  const job = await enqueueIngestionRun(
    db,
    {
      sourceConfigId: 'source-shadow',
      idempotencyKey: 'release-shadow',
      actor,
    },
    now,
  );
  const queued = await db.client.query(
    'SELECT payload_json FROM jobs WHERE id = $1',
    [job.id],
  );
  const payload = (queued.rows[0] as { payload_json: Record<string, unknown> })
    .payload_json;
  assert.equal(payload.rolloutMode, 'shadow');
  assert.equal(payload.shadow, true);
  const runBefore = await db.client.query(
    'SELECT shadow, connector_id, connector_version FROM ingestion_runs WHERE id = $1',
    [job.ingestionRunId],
  );
  assert.deepEqual(runBefore.rows[0], {
    shadow: 1,
    connector_id: 'rss-v1',
    connector_version: '1',
  });
  await db.client.query(
    `
    INSERT INTO raw_payload_uploads
      (id, team_id, source_config_id, ingestion_run_id, state, object_key, sha256,
       byte_size, created_at, updated_at, expires_at, delete_after)
    VALUES ('raw-shadow', 'default', 'source-shadow', $1, 'uploaded', 'shadow.bin',
      'sha', 10, $2, $2, $3, $3)
  `,
    [
      job.ingestionRunId,
      now.toISOString(),
      new Date(now.valueOf() + 3_600_000).toISOString(),
    ],
  );
  const summary = await db.transaction((tx) =>
    commitShadowIngestion(
      tx,
      {
        sourceConfigId: 'source-shadow',
        ingestionRunId: String(job.ingestionRunId),
        connectorId: 'rss-v1',
        connectorVersion: '1',
        fetchedCount: 3,
        rejectedCount: 1,
        requestCount: 1,
        byteCount: 500,
        costMicrosPerRequest: 1000,
      },
      new Date(now.valueOf() + 2_000),
    ),
  );
  assert.equal(summary.shadow, true);
  const pricedRun = await db.client.query(
    'SELECT cost_micros FROM ingestion_runs WHERE id = $1',
    [job.ingestionRunId],
  );
  assert.equal(
    Number((pricedRun.rows[0] as { cost_micros: number }).cost_micros),
    1000,
  );
  assert.equal(
    Number(
      (
        (await db.client.query('SELECT COUNT(*) AS total FROM articles'))
          .rows[0] as { total: number }
      ).total,
    ),
    0,
  );
  const source = await db.client.query(
    "SELECT checkpoint_version, health_status, active_run_id FROM source_configs WHERE id = 'source-shadow'",
  );
  assert.deepEqual(source.rows[0], {
    checkpoint_version: 0,
    health_status: 'healthy',
    active_run_id: null,
  });
  assert.equal(
    (
      (
        await db.client.query(
          "SELECT state FROM raw_payload_uploads WHERE id = 'raw-shadow'",
        )
      ).rows[0] as { state: string }
    ).state,
    'expired',
  );
});
