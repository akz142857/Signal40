import { env } from 'cloudflare:workers';
import { resolveActor, stableHash } from '@/lib/workflow';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, env.WORKER_TOKEN))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { renderJobId?: string; status?: string; checks?: unknown[] };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.renderJobId || !['passed', 'failed'].includes(body.status || '') || !Array.isArray(body.checks)) return Response.json({ error: 'QC 报告字段无效。' }, { status: 422 });
  const { id: projectId } = await context.params;
  const renderJob = await env.DB.prepare("SELECT id FROM jobs WHERE id = ? AND project_id = ? AND kind = 'render' AND status = 'leased'").bind(body.renderJobId, projectId).first();
  if (!renderJob) return Response.json({ error: '渲染作业不存在或不在有效租约中。' }, { status: 409 });
  const now = new Date().toISOString();
  const reportId = `qc_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO qc_reports (id, project_id, render_job_id, status, checks_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).bind(reportId, projectId, body.renderJobId, body.status, JSON.stringify(body.checks), now),
    env.DB.prepare(`INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, 'render-worker', 'producer', 'qc.recorded', 'qc_report', ?, ?, ?, ?, ?)`).bind(`audit_${crypto.randomUUID()}`, projectId, reportId, stableHash(body.checks), JSON.stringify({ status: body.status, renderJobId: body.renderJobId }), crypto.randomUUID(), now),
  ]);
  return Response.json({ report: { id: reportId, projectId, ...body, createdAt: now } }, { status: 201 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await env.DB.prepare('SELECT id, render_job_id, status, checks_json, created_at FROM qc_reports WHERE project_id = ? ORDER BY created_at DESC, rowid DESC').bind(id).all();
  return Response.json({ reports: result.results.map((row) => ({ ...row, checks: JSON.parse(typeof row.checks_json === 'string' ? row.checks_json : '[]'), checks_json: undefined })) });
}
