import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { getSourceRun } from '@/lib/source-run-pagination';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; runId: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.read')) {
    return sourceApiError('用户未加入 Signal 40 团队。', 403);
  }
  const { id, runId } = await context.params;
  const run = await getSourceRun(db, { sourceConfigId: id, runId });
  if (!run) return sourceApiError('运行不存在。', 404);
  return Response.json({ run });
}
