import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { retrySourceLegalDeletion } from '@/lib/source-legal-deletion';
import { boundedTrimmedText } from '@/lib/source-action-validation';

export async function POST(request: Request, context: { params: Promise<{ id: string; requestId: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor?.canManageSourceLegal) return sourceApiError('需要来源法律操作权限才能重试依法删除。', 403);
  let body: { reason?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const reason = boundedTrimmedText(body.reason, { minimum: 10, maximum: 2000 });
  if (!reason) return sourceApiError('重试原因必须为 10–2000 字。', 422);
  const { id, requestId } = await context.params;
  const result = await retrySourceLegalDeletion(db, { sourceId: id, deletionRequestId: requestId, reason, actor });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}
