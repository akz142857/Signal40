import { db, resolveRequestActor } from '@/lib/runtime';
import { boundedTrimmedText } from '@/lib/source-action-validation';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { decideSourceProposal } from '@/lib/source-proposals';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') {
    return sourceApiError('只有管理员可以审批来源提案。', 403);
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  let body: { decision?: 'approve' | 'reject'; note?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const note = boundedTrimmedText(body.note, { minimum: 10, maximum: 1000 });
  if (!body.decision || !['approve', 'reject'].includes(body.decision) || !note) {
    return sourceApiError('decision 和 10–1000 字的决定说明必填。', 422);
  }
  const { id } = await context.params;
  const proposal = await db.prepare(`
    SELECT requested_by FROM source_proposals WHERE id = ? LIMIT 1
  `).bind(id).first<{ requested_by: string }>();
  if (!proposal) return sourceApiError('来源提案不存在。', 404);
  if (!sourceActionAllowed(actor, 'source.proposal.decide', { requestedBy: proposal.requested_by })) {
    return sourceApiError('提案发起人不能审批自己的提案。', 403);
  }
  const result = await decideSourceProposal(db, {
    proposalId: id,
    decision: body.decision,
    note,
    idempotencyKey,
    actor,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json({ proposal: result.proposal, replayed: result.replayed });
}
