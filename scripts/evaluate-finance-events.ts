import { financeEvaluationCases } from '../evaluation/finance-events.ts';
import { runPipeline } from '../lib/domain.ts';

const now = new Date('2026-09-08T03:00:00.000Z');
const results = financeEvaluationCases.map((item) => {
  const topic = runPipeline(item.articles, now)[0];
  return { id: item.id, expected: item.expectedGate, actual: topic?.gate.passed ?? false, score: topic?.score ?? 0 };
});
const correct = results.filter((item) => item.expected === item.actual).length;
const report = { corpus: 'synthetic-regression', caseCount: results.length, gateAccuracy: correct / results.length, failures: results.filter((item) => item.expected !== item.actual) };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (results.length !== 100 || report.gateAccuracy !== 1) process.exitCode = 1;
