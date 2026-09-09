import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { decideCheckpointCutover } from '@/lib/source-checkpoint-cutover';
import { boundedTrimmedText } from '@/lib/source-action-validation';

export async function PATCH(request: Request, context: { params: Promise<{ id: string; cutoverId: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以审批 checkpoint cutover。', 403);
  let body: { decision?: 'approve' | 'reject'; note?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const note = boundedTrimmedText(body.note, { minimum: 1, maximum: 500 });
  if (!['approve', 'reject'].includes(body.decision ?? '') || !note) {
    return sourceApiError('decision 与 1–500 字 note 必填。', 422);
  }
  const { id, cutoverId } = await context.params;
  const result = await decideCheckpointCutover(db, {
    sourceConfigId: id,
    cutoverId,
    decision: body.decision as 'approve' | 'reject',
    note,
    actor,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}
