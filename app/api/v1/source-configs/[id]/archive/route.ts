import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { archiveSource } from '@/lib/source-lifecycle';
import { boundedTrimmedText, positiveInteger } from '@/lib/source-action-validation';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以归档来源。', 403);
  let body: { expectedVersion?: number; reason?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const expectedVersion = positiveInteger(body.expectedVersion);
  const reason = boundedTrimmedText(body.reason, { minimum: 1, maximum: 500 });
  if (!expectedVersion || !reason) {
    return sourceApiError('expectedVersion 与 1–500 字的 reason 必填。', 422);
  }
  const { id } = await context.params;
  const result = await archiveSource(db, { sourceId: id, expectedVersion, reason, actor });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}
