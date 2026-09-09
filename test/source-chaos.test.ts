import assert from 'node:assert/strict';
import test from 'node:test';

import { runLocalSourceChaosDrill } from '../scripts/source-chaos-report.ts';

void test('fixed-seed local source chaos drill preserves ingestion invariants', async () => {
  const report = await runLocalSourceChaosDrill();
  assert.equal(report.seed, 'signal40-source-chaos-2026-09-09-v1');
  assert.equal(report.topology.schedulers.length, 2);
  assert.equal(report.topology.workers.length, 3);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passed, 10);
  assert.ok(report.externalPending.length > 0, 'local smoke must not claim external acceptance');
});
