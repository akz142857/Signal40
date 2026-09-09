import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  estimateSourceBackfill,
  parseSourceBackfillWindow,
  sourceBackfillConfirmationValid,
} from '../lib/source-backfill-estimate.ts';

const range = {
  from: '2026-09-02T00:00:00.000Z',
  to: '2026-09-09T00:00:00.000Z',
  maxItems: 100,
};

void test('backfill estimate freezes conservative item, request, cost and duration planning', () => {
  const parsed = parseSourceBackfillWindow(range);
  assert.ok('window' in parsed);
  if (!('window' in parsed)) return;
  const estimate = estimateSourceBackfill({
    sourceId: 'source-estimate',
    sourceVersion: 3,
    window: parsed.window,
    configuredRequestsPerRun: 2,
    costMicrosPerRequest: 2500,
    rateLimitPerMinute: 10,
  });
  assert.equal(estimate.itemUpperBound, 100);
  assert.equal(estimate.estimatedRequests, 5);
  assert.equal(estimate.estimatedCostMicros, 12_500);
  assert.equal(estimate.estimatedDurationSeconds, 30);
  assert.equal(estimate.requiresConfirmation, true);
  assert.match(estimate.confirmationHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(estimate, estimateSourceBackfill({
    sourceId: 'source-estimate',
    sourceVersion: 3,
    window: parsed.window,
    configuredRequestsPerRun: 2,
    costMicrosPerRequest: 2500,
    rateLimitPerMinute: 10,
  }));
});

void test('default small backfill is allowed without confirmation and malformed ranges fail', () => {
  const parsed = parseSourceBackfillWindow({ ...range, maxItems: 20 });
  assert.ok('window' in parsed);
  if ('window' in parsed) {
    assert.equal(estimateSourceBackfill({
      sourceId: 'source-small', sourceVersion: 1, window: parsed.window,
      configuredRequestsPerRun: 1, costMicrosPerRequest: 0,
      rateLimitPerMinute: 30,
    }).requiresConfirmation, false);
  }
  assert.ok('error' in parseSourceBackfillWindow({ ...range, from: range.to }));
  assert.ok('error' in parseSourceBackfillWindow({ ...range, maxItems: 101 }));
});

void test('large backfill rejects missing and stale confirmation hashes', () => {
  const parsed = parseSourceBackfillWindow(range);
  assert.ok('window' in parsed);
  if (!('window' in parsed)) return;
  const estimate = estimateSourceBackfill({
    sourceId: 'source-confirmation',
    sourceVersion: 3,
    window: parsed.window,
    configuredRequestsPerRun: 2,
    costMicrosPerRequest: 2500,
    rateLimitPerMinute: 10,
  });
  assert.equal(sourceBackfillConfirmationValid(estimate, {}), false);
  assert.equal(sourceBackfillConfirmationValid(estimate, {
    confirmed: true,
    confirmationHash: estimate.confirmationHash,
  }), true);

  const changedEstimate = estimateSourceBackfill({
    sourceId: 'source-confirmation',
    sourceVersion: 4,
    window: parsed.window,
    configuredRequestsPerRun: 2,
    costMicrosPerRequest: 2500,
    rateLimitPerMinute: 10,
  });
  assert.notEqual(changedEstimate.confirmationHash, estimate.confirmationHash);
  assert.equal(sourceBackfillConfirmationValid(changedEstimate, {
    confirmed: true,
    confirmationHash: estimate.confirmationHash,
  }), false);
});

void test('source console obtains and confirms the server estimate before a large backfill', async () => {
  const [manager, route] = await Promise.all([
    readFile(new URL('../components/source-manager.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/v1/source-configs/[id]/backfills/route.ts', import.meta.url), 'utf8'),
  ]);
  for (const marker of [
    '/backfills/estimates',
    'estimate.estimatedRequests',
    'estimate.estimatedCostMicros',
    'confirmationHash: estimate.confirmationHash',
    '该估算是上界规划值',
  ]) assert.ok(manager.includes(marker), marker);
  assert.ok(route.includes('sourceBackfillConfirmationValid(estimate, body)'));
});
