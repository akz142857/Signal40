import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { changeIngestionQuarantine, type IngestionQuarantineAction } from '@/lib/source-quarantine';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') {
    return sourceApiError('只有管理员可以变更采集批次隔离状态。', 403);
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  let body: { action?: IngestionQuarantineAction; note?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!['hold', 'release', 'discard'].includes(body.action ?? '') || !body.note?.trim()) {
    return sourceApiError('action 与 note 必填。', 422);
  }
  const { id } = await context.params;
  const result = await changeIngestionQuarantine(db, {
    ingestionRunId: id,
    action: body.action as IngestionQuarantineAction,
    note: body.note.trim(),
    idempotencyKey,
    actor,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json({
    status: result.status,
    replayed: result.replayed,
    ingestionRunId: result.ingestionRunId,
    sourceConfigId: result.sourceConfigId,
    action: result.action,
    quarantineStatus: result.quarantineStatus,
    affectedOrigins: result.affectedOrigins,
  });
}
