import { db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';
import { socialEvidenceCalibrationPasses } from '@/lib/social-evidence';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['editor', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权审批校准运行。' }, { status: 403 });
  let body: { decision?: string; note?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!['approved', 'rejected'].includes(body.decision || '') || !body.note?.trim() || body.note.trim().length < 10) return Response.json({ error: 'decision 与至少 10 字审批说明必填。' }, { status: 422 });
  const { id } = await context.params;
  const now = new Date().toISOString();
  const derivationKey = `social-evidence-policy:${id}:${body.decision}`;
  const pipelineJobId = `job_pipeline_${stableHash(derivationKey).slice(0, 32)}`;
  const result = await db.transaction(async (tx) => {
    const run = await tx.prepare("SELECT id, status, created_by, calibration_kind, case_count, metrics_json, policy_json FROM calibration_runs WHERE id = ? LIMIT 1 FOR UPDATE").bind(id).first<{ id: string; status: string; created_by: string; calibration_kind: string; case_count: number; metrics_json: unknown; policy_json: unknown }>();
    if (!run) return { status: 404 as const, error: '校准运行不存在。' };
    if (run.status !== 'candidate') return { status: 409 as const, error: `校准运行已处于 ${run.status}。` };
    if (run.created_by === actor.id) return { status: 409 as const, error: '校准提交者不能审批自己的结果。' };
    if (body.decision === 'approved' && run.calibration_kind === 'social_evidence' && !socialEvidenceCalibrationPasses(run.case_count, run.policy_json, run.metrics_json)) {
      return { status: 409 as const, error: 'Social Evidence 的标注量、误独立率、召回率或生产抽样未达到冻结策略。' };
    }
    await tx.prepare('UPDATE calibration_runs SET status = ?, approved_by = ?, note = ?, updated_at = ? WHERE id = ?').bind(body.decision, actor.id, body.note!.trim(), now, id).run();
    const activatesPolicy = run.calibration_kind === 'social_evidence' && body.decision === 'approved';
    await tx.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'calibration_run', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, `calibration.${body.decision}`, id, stableHash(body), JSON.stringify({ calibrationKind: run.calibration_kind, note: body.note!.trim(), pipelineJobId: activatesPolicy ? pipelineJobId : null }), crypto.randomUUID(), now).run();
    if (activatesPolicy) await tx.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, payload_schema_version, payload_json,
         status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
      VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
      ON CONFLICT (kind, idempotency_key) DO NOTHING
    `).bind(
      pipelineJobId,
      JSON.stringify({ schemaVersion: 2, operation: 'topic_recompute', derivationKey, calibrationId: id, rollingWindowHours: 72 }),
      `topic-recompute:${derivationKey}`, now, now, now,
    ).run();
    return { status: 200 as const, calibrationKind: run.calibration_kind, activatesPolicy };
  });
  if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ run: { id, status: body.decision }, ...(result.activatesPolicy ? { pipelineJobId } : {}) });
}
