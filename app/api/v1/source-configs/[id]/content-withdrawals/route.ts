import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { requestSourceLegalDeletion } from '@/lib/source-legal-deletion';
import { withdrawSourceContent } from '@/lib/source-lifecycle';
import { boundedTrimmedText, positiveInteger } from '@/lib/source-action-validation';
import { projectPublicDeletionRequest } from '@/lib/source-public-projection';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return sourceApiError('当前角色无权查看删除回执。', 403);
  const { id } = await context.params;
  const rows = await db.prepare(`
    SELECT id, source_version, status, reason, legal_hold_id, summary_json, receipt_hash,
      last_error_redacted, initialized_at, created_at, updated_at, completed_at
    FROM source_deletion_requests WHERE source_config_id = ? ORDER BY created_at DESC LIMIT 50
  `).bind(id).all();
  return Response.json({
    items: rows.results.map((row) =>
      projectPublicDeletionRequest(row as Record<string, unknown>),
    ),
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以撤回来源内容。', 403);
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  let body: { expectedVersion?: number; reason?: string; mode?: 'withdraw' | 'legal_delete' };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const expectedVersion = positiveInteger(body.expectedVersion);
  const reason = boundedTrimmedText(body.reason, { minimum: 10, maximum: 2000 });
  if (!expectedVersion || !reason || !['withdraw', 'legal_delete'].includes(body.mode ?? 'withdraw')) {
    return sourceApiError('正整数 expectedVersion、可选的 withdraw/legal_delete mode 与 10–2000 字 reason 必填。', 422);
  }
  const { id } = await context.params;
  if (body.mode === 'legal_delete') {
    if (!actor.canManageSourceLegal) {
      return sourceApiError('需要来源法律操作权限才能发起依法删除。', 403);
    }
    const result = await requestSourceLegalDeletion(db, {
      sourceId: id,
      expectedVersion,
      reason,
      idempotencyKey,
      actor,
    });
    if ('error' in result) return sourceResultError(result);
    return Response.json(result, { status: result.status });
  }
  const result = await withdrawSourceContent(db, {
    sourceId: id,
    expectedVersion,
    reason,
    idempotencyKey,
    actor,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json({
    status: result.status,
    sourceId: result.sourceId,
    version: result.version,
    withdrawnOrigins: result.withdrawnOrigins,
    cancelledRuns: result.cancelledRuns,
    replayed: result.replayed,
  });
}
