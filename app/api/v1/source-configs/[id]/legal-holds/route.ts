import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { createSourceLegalHold } from '@/lib/source-legal-deletion';
import { boundedTrimmedText } from '@/lib/source-action-validation';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return sourceApiError('当前角色无权查看 legal hold。', 403);
  const { id } = await context.params;
  const rows = await db.prepare(`
    SELECT id, status, reason, authority_ref, hold_epoch, created_by, released_by, created_at, released_at
    FROM source_legal_holds WHERE source_config_id = ? ORDER BY created_at DESC LIMIT 50
  `).bind(id).all();
  return Response.json({ items: rows.results });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor?.canManageSourceLegal) return sourceApiError('需要来源法律操作权限才能创建 legal hold。', 403);
  let body: { reason?: string; authorityRef?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const reason = boundedTrimmedText(body.reason, { minimum: 10, maximum: 2000 });
  const authorityRef = boundedTrimmedText(body.authorityRef, { minimum: 1, maximum: 500 });
  if (!reason || !authorityRef) {
    return sourceApiError('reason 必须为 10–2000 字，authorityRef 必填且不超过 500 字。', 422);
  }
  const { id } = await context.params;
  const result = await createSourceLegalHold(db, { sourceId: id, reason, authorityRef, actor });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result, { status: result.status });
}
