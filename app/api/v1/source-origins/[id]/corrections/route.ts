import { db, resolveRequestActor } from '@/lib/runtime';
import { recordSourceOriginCorrection } from '@/lib/source-origin-corrections';
import type { EvidenceRelationship } from '@/lib/social-evidence';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !sourceActionAllowed(actor, 'source.evidence.correct')) return sourceApiError('只有编辑或管理员可以修正证据关系。', 403);
  let body: { relationship?: EvidenceRelationship; evidenceFamilyId?: string; publisherEntityId?: string; confidence?: number; reason?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  const { id } = await context.params;
  const result = await recordSourceOriginCorrection(db, {
    originId: id,
    relationship: body.relationship as EvidenceRelationship,
    evidenceFamilyId: body.evidenceFamilyId ?? '',
    publisherEntityId: body.publisherEntityId ?? '',
    confidence: Number(body.confidence),
    reason: body.reason ?? '',
    actor,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result, { status: result.status });
}
