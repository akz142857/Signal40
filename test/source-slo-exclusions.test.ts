import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  cancelPlannedSourceSloExclusion,
  closeManualSourceSloExclusion,
  createPlannedSourceSloExclusion,
  listSourceSloExclusions,
  openManualSourceSloExclusion,
  sourceSloExcludesInstant,
} from '../lib/source-slo-exclusions.ts';
import { createMemoryPg } from './pg-memory.ts';

const actor = {
  id: 'admin-sre',
  email: 'admin-sre@signal40.local',
  role: 'admin' as const,
};

void test('manual pause opens one auditable interval and enable closes it', async () => {
  const db = await createMemoryPg();
  const started = new Date('2026-09-09T01:00:00.000Z');
  const first = await openManualSourceSloExclusion(
    db,
    { sourceId: 'source-pause', reason: '上游维护检查', actor },
    started,
  );
  const replay = await openManualSourceSloExclusion(
    db,
    { sourceId: 'source-pause', reason: '重复暂停动作', actor },
    new Date('2026-09-09T01:05:00.000Z'),
  );
  assert.equal(replay?.id, first?.id);
  assert.equal(
    sourceSloExcludesInstant(
      first ? [first] : [],
      new Date('2026-09-09T01:10:00.000Z').valueOf(),
    ),
    true,
  );
  assert.equal(
    await closeManualSourceSloExclusion(
      db,
      { sourceId: 'source-pause', actor },
      new Date('2026-09-09T02:00:00.000Z'),
    ),
    1,
  );
  const row = (
    await db.client.query(
      "SELECT ends_at, closed_by FROM source_slo_exclusions WHERE id = $1",
      [first?.id],
    )
  ).rows[0] as { ends_at: string; closed_by: string };
  assert.equal(row.ends_at, '2026-09-09T02:00:00.000Z');
  assert.equal(row.closed_by, actor.id);
});

void test('planned maintenance is bounded, audited, idempotent and cancellable only before start', async () => {
  const db = await createMemoryPg();
  await db.client.query(
    "INSERT INTO source_configs (id, name, adapter, platform, config_json, rights_status, enabled, version, lifecycle_status, health_status, config_hash, created_at, updated_at) VALUES ('source-planned', 'Planned', 'rss', 'rss', '{}', 'pending', 0, 1, 'draft', 'unknown', 'hash', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z')",
  );
  const now = new Date('2026-09-09T00:00:00.000Z');
  const input = {
    sourceId: 'source-planned',
    startsAt: '2026-09-10T01:00:00.000Z',
    endsAt: '2026-09-10T02:00:00.000Z',
    reason: '供应商公告的维护窗口',
    actor,
  };
  const created = await createPlannedSourceSloExclusion(db, input, now);
  const replay = await createPlannedSourceSloExclusion(db, input, now);
  assert.equal(created.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.exclusion.id, created.exclusion.id);
  assert.equal((await listSourceSloExclusions(db, input.sourceId)).length, 1);
  assert.equal(
    sourceSloExcludesInstant(
      [created.exclusion],
      new Date('2026-09-10T01:30:00.000Z').valueOf(),
    ),
    true,
  );
  const cancelled = await cancelPlannedSourceSloExclusion(
    db,
    {
      sourceId: input.sourceId,
      exclusionId: created.exclusion.id,
      reason: '供应商取消维护',
      actor,
    },
    new Date('2026-09-09T12:00:00.000Z'),
  );
  assert.equal(cancelled.replayed, false);
  const rows = await listSourceSloExclusions(db, input.sourceId);
  assert.ok(rows[0]?.cancelled_at);
  assert.equal(
    sourceSloExcludesInstant(
      rows,
      new Date('2026-09-10T01:30:00.000Z').valueOf(),
    ),
    false,
  );
  const audits = await db.client.query(
    "SELECT action FROM audit_events WHERE entity_id = 'source-planned' ORDER BY seq",
  );
  assert.deepEqual(
    audits.rows.map((row) => (row as { action: string }).action),
    ['source.slo_exclusion_created', 'source.slo_exclusion_cancelled'],
  );
});

void test('manual pause reason and database interval constraints fail closed', async () => {
  const db = await createMemoryPg();
  await assert.rejects(
    openManualSourceSloExclusion(
      db,
      { sourceId: 'source-invalid', reason: 'x', actor },
      new Date(),
    ),
    /3–500/,
  );
  await assert.rejects(
    db.client.query(`
      INSERT INTO source_slo_exclusions
        (id, source_config_id, kind, starts_at, ends_at, reason, created_by, created_at)
      VALUES ('bad-window', 'source-invalid', 'planned_maintenance',
        '2026-09-09T02:00:00.000Z', '2026-09-09T01:00:00.000Z',
        'invalid', 'admin-sre', '2026-09-09T00:00:00.000Z')
    `),
    /source_slo_exclusions_time_check/,
  );
});

void test('source manager exposes planned maintenance create, history and pre-start cancellation without a terminal', async () => {
  const sourceManager = await readFile(
    new URL('../components/source-manager.tsx', import.meta.url),
    'utf8',
  );
  assert.match(sourceManager, /计划维护与 SLO 排除/);
  assert.match(sourceManager, /type="datetime-local"/);
  assert.match(sourceManager, /method: 'POST'/);
  assert.match(sourceManager, /method: 'DELETE'/);
  assert.match(sourceManager, /slo-exclusions/);
  assert.match(sourceManager, /不能事后补窗/);
});
