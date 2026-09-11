import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createMemoryPg } from './pg-memory.ts';

void test('PostgreSQL rejects unregistered source, run, quarantine and release states', async () => {
  const db = await createMemoryPg();
  const now = '2026-09-09T03:00:00.000Z';
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, config_json, rights_status, lifecycle_status,
       health_status, created_at, updated_at)
    VALUES ('source-state-contract', 'State contract', 'rss', '{}', 'pending',
      'draft', 'unknown', $1, $1)
  `, [now]);
  await assert.rejects(
    db.client.query("UPDATE source_configs SET lifecycle_status = 'failed' WHERE id = 'source-state-contract'"),
    /source_configs_lifecycle_status_check/,
  );
  await assert.rejects(
    db.client.query("UPDATE source_configs SET health_status = 'disabled' WHERE id = 'source-state-contract'"),
    /source_configs_health_status_check/,
  );
  await assert.rejects(
    db.client.query("UPDATE source_configs SET rights_status = 'blocked' WHERE id = 'source-state-contract'"),
    /source_configs_rights_status_check/,
  );

  await db.client.query(`
    INSERT INTO ingestion_runs (id, source_config_id, status, quarantine_status, created_at)
    VALUES ('run-state-contract', 'source-state-contract', 'queued', 'none', $1)
  `, [now]);
  await assert.rejects(
    db.client.query("UPDATE ingestion_runs SET status = 'retrying' WHERE id = 'run-state-contract'"),
    /ingestion_runs_status_check/,
  );
  await assert.rejects(
    db.client.query("UPDATE ingestion_runs SET quarantine_status = 'blocked' WHERE id = 'run-state-contract'"),
    /ingestion_runs_quarantine_status_check/,
  );

  await assert.rejects(
    db.client.query(`
      INSERT INTO source_connector_releases
        (id, connector_id, connector_version, rollout_mode, updated_by, created_at, updated_at)
      VALUES ('release-invalid-state', 'invalid-state', '1', 'committed', 'admin', $1, $1)
    `, [now]),
    /source_connector_releases_rollout_mode_check/,
  );
  await assert.rejects(
    db.client.query(`
      UPDATE source_connector_releases SET canary_percent = 0
      WHERE connector_id = 'rss-v1' AND connector_version = '1'
    `),
    /source_connector_releases_canary_percent_check/,
  );
  await assert.rejects(
    db.client.query(`
      UPDATE source_connector_releases SET canary_failure_rate_bps = 10001
      WHERE connector_id = 'rss-v1' AND connector_version = '1'
    `),
    /source_connector_releases_canary_failure_rate_check/,
  );
  await assert.rejects(
    db.client.query(`
      INSERT INTO source_proposals
        (id, name, adapter, platform, source_type, url, status, requested_by,
         idempotency_key, created_at, updated_at)
      VALUES ('proposal-invalid-state', 'Invalid', 'rss', 'rss', 'media',
        'https://example.com/feed.xml', 'draft', 'researcher', 'invalid-state', $1, $1)
    `, [now]),
    /source_proposals_status_check/,
  );
});

void test('PostgreSQL restricts source legal capability to admin members', async () => {
  const db = await createMemoryPg();
  const now = '2026-09-09T03:00:00.000Z';
  await assert.rejects(
    db.client.query(`
      INSERT INTO team_members
        (user_id, email, role, status, can_manage_source_legal, created_at, updated_at)
      VALUES ('editor-legal', 'editor-legal@signal40.test', 'editor', 'active', 1, $1, $1)
    `, [now]),
    /team_members_source_legal_capability_check/,
  );
});

void test('source manager renders frozen states through Chinese product labels', async () => {
  const source = await readFile(
    new URL('../components/source-manager.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /waiting_capacity: '等待执行能力'/);
  assert.match(source, /rights_blocked: '权利阻断'/);
  // 连接器发布模式的词表跟着发布控制搬去了运维页，冻结的仍是同一批中文。
  const connectorRelease = await readFile(
    new URL('../components/connector-release-control.tsx', import.meta.url),
    'utf8',
  );
  assert.match(connectorRelease, /shadow: '影子运行'/);
  assert.doesNotMatch(source, /\{source\.lifecycleStatus\}/);
  assert.doesNotMatch(source, /\{source\.healthStatus\}/);
  assert.doesNotMatch(source, /\{item\.quarantineStatus\}/);
});
