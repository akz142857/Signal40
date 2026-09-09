import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { transferSourceOwnership } from '@/lib/source-ownership';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') {
    return sourceApiError('只有管理员可以转移来源负责人。', 403);
  }
  let body: {
    expectedVersion?: number;
    businessOwnerId?: string;
    credentialStewardId?: string;
    backupAdminId?: string | null;
    reason?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  const { id } = await context.params;
  const result = await transferSourceOwnership(db, {
    sourceId: id,
    expectedVersion: Number(body.expectedVersion),
    businessOwnerId: body.businessOwnerId ?? '',
    credentialStewardId: body.credentialStewardId ?? '',
    backupAdminId: body.backupAdminId,
    reason: body.reason ?? '',
    actor,
  });
  if ('error' in result) {
    return sourceResultError(result);
  }
  return Response.json(result);
}
