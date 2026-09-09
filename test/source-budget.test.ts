import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueIngestionRun } from '../lib/control-plane.ts';
import {
  parseSourceBillingPolicy,
  SourceBudgetExceededError,
} from '../lib/source-budget.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-08T02:00:00.000Z');
const actor = {
  id: 'budget-admin',
  email: 'budget@signal40.test',
  role: 'admin' as const,
};

void test('source billing policy rejects budgets without a price model and unsafe ranges', () => {
  assert.match(
    parseSourceBillingPolicy({
      costMicrosPerRequest: 0,
      estimatedRequestsPerRun: 1,
      monthlyBudgetMicros: 10_000,
      softLimitPercent: 80,
    }).error ?? '',
    /非零/,
  );
  assert.match(
    parseSourceBillingPolicy({
      costMicrosPerRequest: 1000,
      estimatedRequestsPerRun: 101,
      monthlyBudgetMicros: 10_000,
      softLimitPercent: 100,
    }).error ?? '',
    /必须分别位于/,
  );
});

void test('source budget reserves estimated request cost, warns at soft threshold and blocks atomically at hard limit', async () => {
  const db = await createMemoryPg();
  await db.client.query(
    `
    INSERT INTO source_configs
      (id, name, adapter, platform, config_json, config_hash, rights_status,
       enabled, lifecycle_status, cost_micros_per_request,
       estimated_requests_per_run, monthly_budget_micros,
       budget_soft_limit_percent, created_at, updated_at)
    VALUES ('source-budget', 'Budget source', 'rss', 'rss', '{}', 'budget-hash',
      'approved', 1, 'enabled', 1000, 2, 5000, 80, $1, $1)
  `,
    [now.toISOString()],
  );
  await db.client.query(
    `
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at,
       verified_at, source_version, config_hash, created_at)
    VALUES ('rights-budget', 'source-budget', 'budget-admin', 'rss',
      '["title","summary","url","publishedAt","author"]',
      'finance-editorial-ingestion', 'normalized-metadata', 'confirmation',
      'v1', 'budget-admin', $1, $1, 1, 'budget-hash', $1)
  `,
    [now.toISOString()],
  );
  await db.client.query(
    `
    INSERT INTO ingestion_runs
      (id, source_config_id, status, cost_micros, created_at)
    VALUES ('spent-budget', 'source-budget', 'succeeded', 3000, $1)
  `,
    [now.toISOString()],
  );

  const first = await enqueueIngestionRun(
    db,
    {
      sourceConfigId: 'source-budget',
      idempotencyKey: 'budget-first',
      actor,
    },
    now,
  );
  const reserved = await db.client.query(
    'SELECT cost_micros, cost_micros_per_request FROM ingestion_runs WHERE id = $1',
    [first.ingestionRunId],
  );
  assert.deepEqual(reserved.rows[0], {
    cost_micros: 2000,
    cost_micros_per_request: 1000,
  });
  let attention = await db.client.query(
    "SELECT severity FROM attention_items WHERE dedupe_key = 'source_budget:source-budget:2026-09'",
  );
  assert.equal((attention.rows[0] as { severity: string }).severity, 'warning');

  await db.client.query("UPDATE jobs SET status = 'succeeded' WHERE id = $1", [
    first.id,
  ]);
  await db.client.query(
    "UPDATE ingestion_runs SET status = 'succeeded' WHERE id = $1",
    [first.ingestionRunId],
  );
  await db.client.query(
    "UPDATE source_configs SET active_run_id = NULL WHERE id = 'source-budget'",
  );
  await assert.rejects(
    enqueueIngestionRun(
      db,
      {
        sourceConfigId: 'source-budget',
        idempotencyKey: 'budget-blocked',
        actor,
      },
      new Date(now.valueOf() + 1000),
    ),
    SourceBudgetExceededError,
  );
  const blockedJobs = await db.client.query(
    "SELECT COUNT(*) AS total FROM jobs WHERE idempotency_key = 'budget-blocked'",
  );
  assert.equal(Number((blockedJobs.rows[0] as { total: number }).total), 0);
  attention = await db.client.query(
    "SELECT severity FROM attention_items WHERE dedupe_key = 'source_budget:source-budget:2026-09'",
  );
  assert.equal(
    (attention.rows[0] as { severity: string }).severity,
    'critical',
  );
});
