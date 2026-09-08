import assert from 'node:assert/strict';
import test from 'node:test';
import { financeEvaluationCases } from '../evaluation/finance-events.ts';
import { runPipeline } from '../lib/domain.ts';

void test('100-case finance regression corpus preserves evidence-gate expectations', () => {
  assert.equal(financeEvaluationCases.length, 100);
  const now = new Date('2026-09-08T03:00:00.000Z');
  for (const item of financeEvaluationCases) {
    const topic = runPipeline(item.articles, now)[0];
    assert.equal(topic?.gate.passed ?? false, item.expectedGate, item.id);
  }
});
