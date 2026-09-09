import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSourceSloDimensions,
  buildSourceSloSnapshot,
  loadSourceSloSnapshots,
  raiseSourceSloBurnAlerts,
  SOURCE_SLO_POLICY,
  type SourceSloRun,
} from '../lib/source-slo.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T06:00:00.000Z');

function source(id = 'source-slo') {
  return {
    id,
    name: '财经 RSS',
    platform: 'rss',
    enabled: 1,
    health_status: 'healthy',
    rate_limit_per_minute: 3,
    schedule_cron: null,
    last_success_at: new Date(now.valueOf() - 60_000).toISOString(),
    next_run_at: new Date(now.valueOf() + 60 * 60_000).toISOString(),
    cost_micros_per_request: 1000,
    monthly_budget_micros: 100_000,
    budget_soft_limit_percent: 80,
    schedule_priority: 50,
    auto_throttle_enabled: 1,
    effective_schedule_multiplier: 1,
    schedule_throttle_reason: null,
    schedule_throttle_recovery_at: null,
    affected_article_count: 12,
    affected_topic_count: 3,
  };
}

function scheduledRuns(
  sourceId: string,
  failureIndexes = new Set<number>(),
): SourceSloRun[] {
  return Array.from({ length: 30 }, (_, index) => {
    const scheduled = new Date(now.valueOf() - index * 18 * 60 * 60_000);
    return {
      source_config_id: sourceId,
      status: failureIndexes.has(index) ? 'failed' : 'succeeded',
      trigger: 'schedule',
      request_count: 2,
      byte_count: 1024,
      accepted_count: 4,
      rejected_count: 1,
      duplicate_count: 1,
      scheduled_for: scheduled.toISOString(),
      finished_at: new Date(scheduled.valueOf() + 2 * 60_000).toISOString(),
      created_at: scheduled.toISOString(),
      cost_micros: 2000,
      fetch_outcome: 'modified',
    };
  });
}

void test('source SLO never displays healthy before both windows reach minimum sample size', () => {
  const snapshot = buildSourceSloSnapshot(
    source(),
    scheduledRuns('source-slo').slice(0, 9),
    now,
  );
  assert.equal(snapshot.status, 'insufficient_data');
  assert.equal(snapshot.windows.days7.sampleSufficient, false);
  assert.equal(snapshot.windows.days28.sampleSufficient, false);
});

void test('source SLO policy freezes eligible failures and reports excluded outcomes separately', () => {
  assert.equal(SOURCE_SLO_POLICY.version, '2026-09-09.v2');
  assert.deepEqual(SOURCE_SLO_POLICY.lowFrequency, {
    expectedTriggers28dBelow: 30,
    statusUntilStandardSample: 'insufficient_data',
    acceptanceMinimumExpectedCycles: 2,
  });
  assert.deepEqual(SOURCE_SLO_POLICY.eligibleFailureStatuses, ['partial', 'failed']);
  const runs = scheduledRuns('source-classification');
  runs[0].status = 'partial';
  runs[1].status = 'failed';
  runs[2].status = 'rights_blocked';
  runs[3].status = 'cancelled';
  runs[4].status = 'running';
  runs[5].fetch_outcome = 'not_modified';
  runs[6].fetch_outcome = 'unknown';
  runs.push({ ...runs[5], trigger: 'manual' }, { ...runs[6], trigger: 'backfill' });
  const snapshot = buildSourceSloSnapshot(
    source('source-classification'),
    runs,
    now,
  );
  assert.equal(snapshot.windows.days28.total, 27);
  assert.equal(snapshot.windows.days28.succeeded, 25);
  assert.equal(snapshot.windows.days28.failed, 2);
  assert.deepEqual(snapshot.windows.days28.outcomes, {
    succeeded: 25,
    partial: 1,
    failed: 1,
    rightsBlocked: 1,
    cancelled: 1,
    inProgress: 1,
    manual: 1,
    backfill: 1,
    modified: 28,
    notModified: 1,
    unknownFetchOutcome: 1,
    excluded: 0,
    budgetThrottled: 0,
  });
});

void test('audited pause windows exclude scheduled runs without erasing other history', () => {
  const runs = scheduledRuns('source-excluded');
  runs[0].status = 'failed';
  const snapshot = buildSourceSloSnapshot(
    source('source-excluded'),
    runs,
    now,
    true,
    [
      {
        id: 'pause-one',
        source_config_id: 'source-excluded',
        kind: 'manual_pause',
        starts_at: new Date(now.valueOf() - 60 * 60_000).toISOString(),
        ends_at: new Date(now.valueOf() + 60 * 60_000).toISOString(),
        reason: '上游计划维护',
      },
    ],
  );
  assert.equal(snapshot.windows.days28.total, 29);
  assert.equal(snapshot.windows.days28.succeeded, 29);
  assert.equal(snapshot.windows.days28.outcomes.excluded, 1);
  assert.equal(snapshot.exclusions.length, 1);
});

void test('source SLO reports 7/28-day success, freshness, traffic and quota separately', () => {
  const runs = scheduledRuns('source-slo');
  runs.push({
    ...runs[0],
    trigger: 'manual',
    created_at: new Date(now.valueOf() - 10_000).toISOString(),
  });
  const snapshot = buildSourceSloSnapshot(source(), runs, now);
  assert.equal(snapshot.status, 'healthy');
  assert.equal(snapshot.windows.days28.successRate, 1);
  assert.equal(snapshot.windows.days28.requests, 60);
  assert.equal(snapshot.windows.days28.bytes, 30 * 1024);
  assert.equal(snapshot.windows.days28.p95FreshnessMs, 2 * 60_000);
  assert.equal(snapshot.windows.days28.estimatedCostMicros, 60_000);
  assert.equal(snapshot.budget.mode, 'tracking');
  assert.equal(snapshot.budget.monthSpentMicros, 26_000);
  assert.ok(Number(snapshot.budget.projectedMonthEndMicros) > 26_000);
  assert.equal(snapshot.budget.affectedArticleCount, 12);
  assert.equal(snapshot.budget.affectedTopicCount, 3);
  assert.equal(snapshot.quota.triggersLastMinute, 2);
  assert.equal(snapshot.quota.remainingTriggers, 1);
});

void test('source SLO counts expected cron occurrences so missed scheduler ticks consume error budget', () => {
  const monitoringStartedAt = new Date(now.valueOf() - 31 * 60 * 60_000);
  const scheduled = Array.from({ length: 30 }, (_, index) => {
    const scheduledAt = new Date(now.valueOf() - (index + 1) * 60 * 60_000);
    return {
      ...scheduledRuns('source-missed-tick')[0],
      source_config_id: 'source-missed-tick',
      scheduled_for: scheduledAt.toISOString(),
      finished_at: new Date(scheduledAt.valueOf() + 60_000).toISOString(),
      created_at: scheduledAt.toISOString(),
    };
  });
  const snapshot = buildSourceSloSnapshot(
    {
      ...source('source-missed-tick'),
      schedule_cron: '0 * * * *',
      monitoring_started_at: monitoringStartedAt.toISOString(),
    },
    scheduled,
    now,
  );
  assert.equal(snapshot.windows.days7.expectedTriggers, 31);
  assert.equal(snapshot.windows.days7.observedTriggers, 30);
  assert.equal(snapshot.windows.days7.triggerSampleSufficient, true);
  assert.ok(Number(snapshot.windows.days7.triggerRate) < 0.99);
  assert.equal(snapshot.status, 'breaching');
});

void test('source SLO removes only persisted budget-throttle occurrences and still exposes their count', () => {
  const monitoringStartedAt = new Date(now.valueOf() - 31 * 60 * 60_000);
  const scheduled = Array.from({ length: 30 }, (_, index) => {
    const scheduledAt = new Date(now.valueOf() - (index + 1) * 60 * 60_000);
    return {
      ...scheduledRuns('source-throttled-tick')[0],
      source_config_id: 'source-throttled-tick',
      scheduled_for: scheduledAt.toISOString(),
      finished_at: new Date(scheduledAt.valueOf() + 60_000).toISOString(),
      created_at: scheduledAt.toISOString(),
    };
  });
  const snapshot = buildSourceSloSnapshot(
    {
      ...source('source-throttled-tick'),
      schedule_cron: '0 * * * *',
      monitoring_started_at: monitoringStartedAt.toISOString(),
      effective_schedule_multiplier: 2,
      schedule_throttle_reason: 'budget_soft_limit',
      schedule_throttle_recovery_at: '2026-10-01T00:00:00.000Z',
    },
    scheduled,
    now,
    true,
    [],
    [
      {
        source_config_id: 'source-throttled-tick',
        scheduled_for: monitoringStartedAt.toISOString(),
        cadence_multiplier: 2,
        schedule_priority: 50,
        reason_code: 'budget_soft_limit',
        recovery_at: '2026-10-01T00:00:00.000Z',
      },
    ],
  );
  assert.equal(snapshot.windows.days7.expectedTriggers, 30);
  assert.equal(snapshot.windows.days7.observedTriggers, 30);
  assert.equal(snapshot.windows.days7.outcomes.budgetThrottled, 1);
  assert.equal(snapshot.status, 'healthy');
});

void test('source SLO aggregates connector, version, platform and capability slices without averaging percentages', () => {
  const first = buildSourceSloSnapshot(
    source('source-one'),
    scheduledRuns('source-one'),
    now,
  );
  const second = buildSourceSloSnapshot(
    source('source-two'),
    scheduledRuns('source-two', new Set([0])),
    now,
  );
  const dimensions = buildSourceSloDimensions([first, second]);
  assert.deepEqual(
    new Set(dimensions.map((dimension) => dimension.kind)),
    new Set(['connector', 'connector_version', 'platform', 'capability']),
  );
  const connector = dimensions.find(
    (dimension) => dimension.kind === 'connector',
  );
  assert.equal(connector?.key, 'rss-v1');
  assert.equal(connector?.sourceCount, 2);
  assert.equal(connector?.windows.days28.total, 60);
  assert.equal(connector?.windows.days28.succeeded, 59);
  assert.equal(connector?.windows.days28.successRate, 59 / 60);
  assert.equal(connector?.windows.days28.requests, 120);
  assert.equal(connector?.status, 'breaching');
});

void test('short and long window error-budget burn creates one deduplicated source alert', async () => {
  const db = await createMemoryPg();
  const sourceRow = source('source-burning');
  await db.client.query(
    `
    INSERT INTO source_configs
      (id, name, adapter, platform, config_json, rights_status, enabled, version,
       lifecycle_status, health_status, config_hash, rate_limit_per_minute, schedule_cron,
       last_success_at, next_run_at, created_at, updated_at)
    VALUES ($1, $2, 'rss', 'rss', '{}', 'approved', 1, 1, 'enabled', 'healthy',
      'slo-hash', $3, $4, $5, $6, $7, $7)
  `,
    [
      sourceRow.id,
      sourceRow.name,
      sourceRow.rate_limit_per_minute,
      sourceRow.schedule_cron,
      sourceRow.last_success_at,
      sourceRow.next_run_at,
      now.toISOString(),
    ],
  );
  const runs = scheduledRuns(sourceRow.id, new Set([0]));
  for (const [index, run] of runs.entries()) {
    await db.client.query(
      `
      INSERT INTO ingestion_runs
        (id, source_config_id, status, trigger, request_count, byte_count, accepted_count,
         rejected_count, duplicate_count, scheduled_for, finished_at, created_at)
      VALUES ($1, $2, $3, 'schedule', $4, $5, $6, $7, $8, $9, $10, $11)
    `,
      [
        `slo-run-${index}`,
        run.source_config_id,
        run.status,
        run.request_count,
        run.byte_count,
        run.accepted_count,
        run.rejected_count,
        run.duplicate_count,
        run.scheduled_for,
        run.finished_at,
        run.created_at,
      ],
    );
  }
  const report = await loadSourceSloSnapshots(db, now);
  assert.equal(report.policy.version, SOURCE_SLO_POLICY.version);
  assert.deepEqual(report.policy.eligibleFailureStatuses, [
    'partial',
    'failed',
  ]);
  const first = await raiseSourceSloBurnAlerts(db, now);
  const second = await raiseSourceSloBurnAlerts(
    db,
    new Date(now.valueOf() + 1_000),
  );
  assert.deepEqual(first, { raised: 1, dataComplete: true });
  assert.deepEqual(second, { raised: 1, dataComplete: true });
  const alerts = await db.client.query(
    "SELECT kind, severity, detail_json FROM attention_items WHERE dedupe_key = 'source_slo:source-burning'",
  );
  assert.equal(alerts.rows.length, 1);
  assert.equal((alerts.rows[0] as { kind: string }).kind, 'source_slo');
  assert.equal((alerts.rows[0] as { severity: string }).severity, 'critical');
});
