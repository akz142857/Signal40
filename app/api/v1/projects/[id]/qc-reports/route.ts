import { config, db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';
import { authorizeWorker } from '@/lib/worker-auth';
import { loadActiveJobLease } from '@/lib/job-lease';
import { abandonIdempotentRequest, beginIdempotentRequest, completeIdempotencyStatement } from '@/lib/idempotency';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.renderWorkerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { renderJobId?: string; workerId?: string; leaseEpoch?: number; status?: string; checks?: unknown[] };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.renderJobId || !body.workerId || !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1 || !['passed', 'failed'].includes(body.status || '') || !Array.isArray(body.checks)) return Response.json({ error: 'QC 报告字段或租约身份无效。' }, { status: 422 });
  const { id: projectId } = await context.params;
  const renderJob = await loadActiveJobLease(db, { jobId: body.renderJobId, workerId: body.workerId.slice(0, 160), leaseEpoch: Number(body.leaseEpoch), projectId, kinds: ['render'] });
  if (!renderJob) return Response.json({ error: '渲染作业不存在或不在有效租约中。' }, { status: 409 });
  const idempotency = await beginIdempotentRequest(db, { scope: `worker.qc:${projectId}`, key: body.renderJobId, request: body });
  if (idempotency.kind === 'conflict') return Response.json({ error: '该渲染作业已经提交过不同的 QC 结果。' }, { status: 409 });
  if (idempotency.kind === 'pending') return Response.json({ error: '相同 QC 结果正在提交。' }, { status: 425 });
  if (idempotency.kind === 'replay') return Response.json(idempotency.body, { status: idempotency.status, headers: { 'Idempotency-Replayed': 'true' } });
  const now = new Date().toISOString();
  const reportId = `qc_${crypto.randomUUID()}`;
  const responseBody = { report: { id: reportId, projectId, ...body, createdAt: now } };
  try {
    await db.transaction(async (tx) => {
      const results = await tx.batch([
        tx.prepare(`INSERT INTO qc_reports (id, project_id, render_job_id, status, checks_json, created_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM jobs WHERE id = ? AND project_id = ? AND kind = 'render' AND status = 'leased'
              AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?
          )`).bind(reportId, projectId, body.renderJobId, body.status, JSON.stringify(body.checks), now, body.renderJobId, projectId, body.workerId!.slice(0, 160), Number(body.leaseEpoch), now),
        tx.prepare(`INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
          SELECT ?, ?, 'render-worker', 'producer', 'qc.recorded', 'qc_report', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM qc_reports WHERE id = ?)`)
          .bind(`audit_${crypto.randomUUID()}`, projectId, reportId, stableHash(body.checks), JSON.stringify({ status: body.status, renderJobId: body.renderJobId, workerId: body.workerId, leaseEpoch: body.leaseEpoch }), crypto.randomUUID(), now, reportId),
      ]);
      if (!results[0].meta.changes) throw new Error('LEASE_CONFLICT');
      await completeIdempotencyStatement(tx, idempotency.reservation, 201, responseBody).run();
    });
  } catch (error) {
    await abandonIdempotentRequest(db, idempotency.reservation);
    if (error instanceof Error && error.message === 'LEASE_CONFLICT') return Response.json({ error: '渲染租约已过期或已由其他 Worker 接管。' }, { status: 409 });
    return Response.json({ error: 'QC 报告保存失败。' }, { status: 503 });
  }
  return Response.json(responseBody, { status: 201 });
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await db.prepare('SELECT id, render_job_id, status, checks_json, created_at FROM qc_reports WHERE project_id = ? ORDER BY created_at DESC, seq DESC').bind(id).all();
  return Response.json({ reports: result.results.map((row) => ({ ...row, checks: JSON.parse(typeof row.checks_json === 'string' ? row.checks_json : '[]'), checks_json: undefined })) });
}
