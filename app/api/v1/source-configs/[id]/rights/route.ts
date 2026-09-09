import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import {
  decideSourceRightsRequest,
  listSourceRightsRequests,
  parseSourceRightsDecisionDossier,
  submitSourceRightsRequest,
} from '@/lib/source-rights-approval';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.read')) {
    return sourceApiError('无权读取来源权利记录。', 403);
  }
  const { id } = await context.params;
  const source = await db.prepare(`
    SELECT id FROM source_configs WHERE id = ? LIMIT 1
  `).bind(id).first<{ id: string }>();
  if (!source) return sourceApiError('来源不存在。', 404);
  return Response.json({ requests: await listSourceRightsRequests(db, id) });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') {
    return sourceApiError('只有管理员可以决定来源权利请求。', 403);
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  let body: {
    requestId?: string;
    expectedSourceVersion?: number;
    decision?: 'approve' | 'reject';
    note?: string;
    dossier?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  const note = body.note?.trim() ?? '';
  if (
    !body.requestId ||
    !Number.isInteger(body.expectedSourceVersion) ||
    Number(body.expectedSourceVersion) < 1 ||
    !body.decision ||
    !['approve', 'reject'].includes(body.decision) ||
    note.length < 10 ||
    note.length > 1000
  ) {
    return sourceApiError('requestId、expectedSourceVersion、decision 和 10–1000 字说明必填。', 422);
  }
  let dossier;
  if (body.decision === 'approve') {
    const parsed = parseSourceRightsDecisionDossier(body.dossier);
    if ('error' in parsed) return sourceApiError(parsed.error, 422);
    dossier = parsed.dossier;
  }
  const { id } = await context.params;
  const rightsRequest = await db.prepare(`
    SELECT requested_by FROM source_rights_requests
    WHERE id = ? AND source_config_id = ? LIMIT 1
  `).bind(body.requestId, id).first<{ requested_by: string }>();
  if (!rightsRequest) return sourceApiError('权利请求不存在。', 404);
  if (!sourceActionAllowed(actor, 'source.rights.decide', { requestedBy: rightsRequest.requested_by })) {
    return sourceApiError('权利声明提交者不能审批自己的请求。', 403);
  }
  const result = await decideSourceRightsRequest(db, {
    sourceConfigId: id,
    requestId: body.requestId,
    expectedSourceVersion: Number(body.expectedSourceVersion),
    decision: body.decision,
    note,
    dossier,
    idempotencyKey,
    actor,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.update')) {
    return sourceApiError('只有管理员可以提交来源权利声明。', 403);
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  let body: { expectedSourceVersion?: number; assertionRef?: string; note?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  const assertionRef = body.assertionRef?.trim() ?? '';
  const note = body.note?.trim() ?? '';
  if (!Number.isInteger(body.expectedSourceVersion) || Number(body.expectedSourceVersion) < 1 ||
      !/^[A-Za-z][A-Za-z0-9+.-]{1,80}:[^\s]{1,900}$/.test(assertionRef) || /^https?:/i.test(assertionRef) ||
      note.length < 10 || note.length > 1000) {
    return sourceApiError('expectedSourceVersion、非 HTTP 的 opaque assertionRef 和 10–1000 字说明必填。', 422);
  }
  const { id } = await context.params;
  const result = await submitSourceRightsRequest(db, {
    sourceConfigId: id,
    expectedSourceVersion: Number(body.expectedSourceVersion),
    assertionRef,
    note,
    idempotencyKey,
    actor: actor!,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result, { status: result.status });
}
