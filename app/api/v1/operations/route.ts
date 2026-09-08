import { env } from 'cloudflare:workers';
import { resolveActor } from '@/lib/workflow';

function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export async function GET(request: Request) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看运行数据。' }, { status: 403 });
  const since = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const [jobs, ingestion, qc, incidents, attention] = await Promise.all([
    env.DB.prepare('SELECT kind, status, attempt, cost_micros, created_at, updated_at FROM jobs WHERE created_at >= ? ORDER BY created_at DESC LIMIT 5000').bind(since).all<{ kind: string; status: string; attempt: number; cost_micros: number; created_at: string; updated_at: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM ingestion_runs WHERE created_at >= ?").bind(since).first<Record<string, number | null>>(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'passed' THEN 1 ELSE 0 END) AS passed, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM qc_reports WHERE created_at >= ?").bind(since).first<Record<string, number | null>>(),
    env.DB.prepare("SELECT COUNT(*) AS open FROM content_incidents WHERE status = 'open'").first<{ open: number }>(),
    env.DB.prepare("SELECT id, kind, project_id, status, attempt, max_attempts, last_error, updated_at FROM jobs WHERE status IN ('dead_letter', 'failed', 'retrying') ORDER BY updated_at DESC LIMIT 50").all(),
  ]);
  const byKind: Record<string, { total: number; succeeded: number; failed: number; deadLetter: number; retries: number; p50Ms: number | null; p95Ms: number | null; costMicros: number }> = {};
  for (const row of jobs.results) {
    const metric = byKind[row.kind] ?? { total: 0, succeeded: 0, failed: 0, deadLetter: 0, retries: 0, p50Ms: null, p95Ms: null, costMicros: 0 };
    metric.total += 1;
    metric.succeeded += row.status === 'succeeded' ? 1 : 0;
    metric.failed += row.status === 'failed' ? 1 : 0;
    metric.deadLetter += row.status === 'dead_letter' ? 1 : 0;
    metric.retries += Math.max(0, row.attempt - 1);
    metric.costMicros += Number(row.cost_micros ?? 0);
    byKind[row.kind] = metric;
  }
  for (const [kind, metric] of Object.entries(byKind)) {
    const durations = jobs.results.filter((row) => row.kind === kind && ['succeeded', 'failed', 'dead_letter'].includes(row.status)).map((row) => new Date(row.updated_at).valueOf() - new Date(row.created_at).valueOf()).filter((value) => value >= 0);
    metric.p50Ms = percentile(durations, 0.5);
    metric.p95Ms = percentile(durations, 0.95);
  }
  return Response.json({ windowDays: 30, generatedAt: new Date().toISOString(), jobs: byKind, ingestion: { total: Number(ingestion?.total ?? 0), succeeded: Number(ingestion?.succeeded ?? 0), failed: Number(ingestion?.failed ?? 0) }, qc: { total: Number(qc?.total ?? 0), passed: Number(qc?.passed ?? 0), failed: Number(qc?.failed ?? 0) }, openIncidents: Number(incidents?.open ?? 0), attention: attention.results, slo: { ingestionSuccessTarget: 0.98, renderSuccessTarget: 0.95, auditCoverageTarget: 1 } });
}
