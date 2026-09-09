import { db, resolveRequestActor } from '@/lib/runtime';
import { assertPublicHttpUrl, validateSourceConfig } from '@/lib/source-adapters';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { sourceConnectorByPlatform } from '@/lib/source-connectors/registry';
import { listSourceProposals, createSourceProposal } from '@/lib/source-proposals';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.proposal.read', { requestedBy: actor?.id })) {
    return sourceApiError('当前角色无权查看来源提案。', 403);
  }
  return Response.json({ proposals: await listSourceProposals(db, actor!) });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.proposal.create')) {
    return sourceApiError('只有研究员或编辑可以发起来源提案。', 403);
  }
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  let body: {
    name?: string;
    adapter?: 'rss' | 'http' | 'web' | 'social';
    platform?: 'rss' | 'http_json' | 'web_page' | 'wechat' | 'xiaohongshu';
    sourceType?: 'social' | 'media' | 'market' | 'filing' | 'company';
    url?: string;
    discoveryMode?: 'opencli' | 'rss';
    accountName?: string;
    searchLimit?: number;
    scheduleCron?: string | null;
    requestNote?: string;
  };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!body.adapter || !['rss', 'http', 'web', 'social'].includes(body.adapter) || !body.platform ||
      !['rss', 'http_json', 'web_page', 'wechat', 'xiaohongshu'].includes(body.platform) ||
      !body.sourceType || !body.name?.trim() || !body.requestNote?.trim() ||
      body.requestNote.trim().length < 10 || body.requestNote.trim().length > 1000) {
    return sourceApiError('来源类型、名称与 10–1000 字的提案理由必填。', 422);
  }
  const connector = sourceConnectorByPlatform(body.platform);
  if (!connector || connector.adapter !== body.adapter || connector.availability !== 'available') {
    return sourceApiError(connector?.unavailableReason ?? '该来源类型当前不可提案。', 409, {
      errorCode: 'CONNECTOR_UNAVAILABLE',
    });
  }
  let normalizedUrl = '';
  try { normalizedUrl = body.url ? assertPublicHttpUrl(body.url) : ''; }
  catch (error) { return sourceApiError(error instanceof Error ? error.message : '来源 URL 无效。', 422); }
  const validation = validateSourceConfig({
    name: body.name,
    adapter: body.adapter,
    sourceType: body.sourceType,
    url: normalizedUrl,
    discoveryMode: body.discoveryMode,
    accountName: body.accountName,
    searchLimit: body.searchLimit,
    scheduleCron: body.scheduleCron,
    rightsStatus: 'pending',
    namespace: body.platform,
  }, false);
  if (!validation.valid) return sourceApiError('来源提案无效。', 422, { issues: validation.errors });
  const result = await createSourceProposal(db, {
    name: body.name.trim(),
    adapter: body.adapter,
    platform: body.platform,
    sourceType: body.sourceType,
    url: normalizedUrl,
    discoveryMode: body.discoveryMode,
    accountName: body.accountName?.trim(),
    searchLimit: body.searchLimit,
    scheduleCron: body.scheduleCron ?? null,
    requestNote: body.requestNote.trim(),
    idempotencyKey,
    actor: actor!,
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json({ proposal: result.proposal, replayed: result.replayed }, { status: result.status });
}
