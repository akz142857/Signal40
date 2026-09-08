import { db, resolveRequestActor } from '@/lib/runtime';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看编排记录。' }, { status: 403 });
  const limit = Math.min(100, Math.max(1, Number(new URL(request.url).searchParams.get('limit') ?? 20)));
  const result = await db
    .prepare('SELECT id, trigger, status, started_at, finished_at, duration_ms, project_count, actions_json, breakers_json, errors_json FROM automation_runs ORDER BY started_at DESC LIMIT ?')
    .bind(limit)
    .all<Record<string, unknown>>();
  const parse = (value: unknown, fallback: unknown) => { try { return JSON.parse(String(value)); } catch { return fallback; } };
  return Response.json({
    runs: result.results.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      projectCount: row.project_count,
      actions: parse(row.actions_json, []),
      breakers: parse(row.breakers_json, {}),
      errors: parse(row.errors_json, []),
    })),
  });
}
