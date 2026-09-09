import { config, db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { bindSourceCredential, parseSourceCredentialPolicies, revokeSourceCredential } from '@/lib/source-credentials';
import { sourceOwnershipReady } from '@/lib/source-ownership';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以绑定或轮换来源凭据。', 403);
  let body: { alias?: string; expectedVersion?: number; reason?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!body.alias || !Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1 || !body.reason?.trim()) {
    return sourceApiError('alias、expectedVersion 和 reason 必填。', 422);
  }
  let policies;
  try { policies = parseSourceCredentialPolicies(config.sourceCredentialPoliciesJson); }
  catch (error) {
    return sourceApiError(error instanceof Error ? error.message : '来源凭据策略配置无效。', 503, {
      errorCode: 'BROKER_CONFIG',
    });
  }
  const policy = policies[body.alias];
  if (!policy) return sourceApiError('credential alias 未由服务端预配。', 422);
  const { id } = await context.params;
  const ownership = await sourceOwnershipReady(db, id);
  if ('error' in ownership) {
    return sourceApiError(`绑定凭据前必须先分配有效维护责任：${ownership.error}`, 409);
  }
  const result = await bindSourceCredential(db, {
    sourceId: id, expectedVersion: Number(body.expectedVersion), alias: body.alias,
    policy, actor, reason: body.reason.trim(),
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json({
    status: result.status,
    credentialVersion: result.credentialVersion,
    sourceVersion: result.sourceVersion,
    cancelledJobs: result.cancelledJobs,
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以撤销来源凭据。', 403);
  let body: { expectedVersion?: number; reason?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1 || !body.reason?.trim()) {
    return sourceApiError('expectedVersion 和 reason 必填。', 422);
  }
  const { id } = await context.params;
  const result = await revokeSourceCredential(db, {
    sourceId: id, expectedVersion: Number(body.expectedVersion), actor, reason: body.reason.trim(),
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}
