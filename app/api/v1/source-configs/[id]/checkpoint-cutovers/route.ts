import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { requestCheckpointCutover } from '@/lib/source-checkpoint-cutover';
import { boundedTrimmedText, positiveInteger } from '@/lib/source-action-validation';
import { projectPublicCheckpointCutover } from '@/lib/source-public-projection';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) {
    return sourceApiError('只有管理员或审计员可以查看 checkpoint cutover。', 403);
  }
  const { id } = await context.params;
  const result = await db.prepare(`
    SELECT id, source_config_id, scope, status, source_version,
      checkpoint_version_before, checkpoint_before_json, checkpoint_after_json,
      requested_by, approved_by, reason, decision_note, created_at, decided_at, applied_at
    FROM source_checkpoint_cutovers
    WHERE source_config_id = ? ORDER BY created_at DESC LIMIT 100
  `).bind(id).all();
  return Response.json({
    cutovers: result.results.map((row) =>
      projectPublicCheckpointCutover(row as Record<string, unknown>),
    ),
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以申请 checkpoint cutover。', 403);
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  let body: { scope?: 'live' | 'backfill'; checkpointAfter?: unknown; expectedSourceVersion?: number; reason?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const expectedSourceVersion = positiveInteger(body.expectedSourceVersion);
  const reason = boundedTrimmedText(body.reason, { minimum: 1, maximum: 500 });
  if (!['live', 'backfill'].includes(body.scope ?? '') || !body.checkpointAfter || typeof body.checkpointAfter !== 'object' || Array.isArray(body.checkpointAfter) || !expectedSourceVersion || !reason) {
    return sourceApiError('scope、checkpointAfter、正整数 expectedSourceVersion 与 1–500 字 reason 必填。', 422);
  }
  const { id } = await context.params;
  const result = await requestCheckpointCutover(db, {
    sourceConfigId: id,
    scope: body.scope as 'live' | 'backfill',
    checkpointAfter: body.checkpointAfter as Record<string, unknown>,
    expectedSourceVersion,
    reason,
    idempotencyKey,
    actor,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result, { status: result.status });
}
