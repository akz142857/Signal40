import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { parseSourceImport, persistSourceImportDrafts, type SourceImportCandidate } from '@/lib/source-import';
import { validateSourceConfig } from '@/lib/source-adapters';
import { sourceConnectorByPlatform } from '@/lib/source-connectors/registry';
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotencyStatement,
  validIdempotencyKey,
} from '@/lib/idempotency';
import { stableHash } from '@/lib/workflow';
import { validateSourceOwnershipMembers } from '@/lib/source-ownership';

type PreviewBody = {
  mode?: 'preview';
  content?: string;
  defaultPlatform?: 'rss' | 'http_json';
  defaultSourceType?: 'social' | 'media' | 'market' | 'filing' | 'company';
  scheduleCron?: string | null;
};

type ConfirmedCandidate = SourceImportCandidate & { publicUseConfirmed?: boolean };
type CommitBody = { mode: 'commit'; candidates?: ConfirmedCandidate[] };

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以批量导入来源。', 403);
  let body: PreviewBody | CommitBody;
  try { body = (await request.json()) as PreviewBody | CommitBody; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }

  if (body.mode !== 'commit') {
    if (typeof body.content !== 'string') return sourceApiError('content 必填。', 422);
    try {
      return Response.json(parseSourceImport(body.content, {
        platform: body.defaultPlatform,
        sourceType: body.defaultSourceType,
        scheduleCron: body.scheduleCron,
      }));
    } catch (error) {
      return sourceApiError(error instanceof Error ? error.message : '来源导入内容无法解析。', 422);
    }
  }

  const idempotencyKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(idempotencyKey)) return sourceApiError('有效的 Idempotency-Key 必填。', 400);
  if (!Array.isArray(body.candidates) || !body.candidates.length || body.candidates.length > 100) {
    return sourceApiError('candidates 必须包含 1–100 个来源。', 422);
  }
  const uniqueUrls = new Set<string>();
  for (const candidate of body.candidates) {
    if (candidate.publicUseConfirmed !== true) return sourceApiError(`第 ${candidate.row} 项尚未提交 provisional 使用权声明。`, 422);
    const validation = validateSourceConfig({
      name: candidate.name,
      adapter: candidate.adapter,
      sourceType: candidate.sourceType,
      url: candidate.url,
      scheduleCron: candidate.scheduleCron,
      rightsStatus: 'pending',
    }, false);
    if (!validation.valid) return sourceApiError(`第 ${candidate.row} 项无效。`, 422, { issues: validation.errors });
    if ((candidate.platform === 'rss') !== (candidate.adapter === 'rss')) return sourceApiError(`第 ${candidate.row} 项的平台与适配器不匹配。`, 422);
    const connector = sourceConnectorByPlatform(candidate.platform);
    if (!connector || connector.adapter !== candidate.adapter || connector.availability !== 'available') {
      return sourceApiError(`第 ${candidate.row} 项连接器不可用。`, 409, { errorCode: 'CONNECTOR_UNAVAILABLE' });
    }
    if (uniqueUrls.has(candidate.url)) return sourceApiError(`第 ${candidate.row} 项 URL 在本批次重复。`, 422);
    uniqueUrls.add(candidate.url);
  }
  const ownership = await validateSourceOwnershipMembers(db, {
    businessOwnerId: actor.id,
  });
  if ('error' in ownership) {
    return sourceApiError(`批量接入前请先在治理页登记有效负责人：${ownership.error ?? '维护责任无效。'}`, 422);
  }

  const start = await beginIdempotentRequest(db, {
    scope: 'source-config-import',
    key: idempotencyKey!,
    request: body,
  });
  if (start.kind === 'replay') return Response.json(start.body, { status: start.status });
  if (start.kind === 'conflict') return sourceApiError('该幂等键已经用于不同的批量来源请求。', 409, { errorCode: 'IDEMPOTENCY_CONFLICT' });
  if (start.kind === 'pending') return sourceApiError('相同批量来源请求正在处理中。', 425, {
    errorCode: 'IDEMPOTENCY_CONFLICT', retryable: true, retryAfterSeconds: 2,
    headers: { 'Retry-After': '2' },
  });

  const now = new Date();
  try {
    const response = await db.transaction(async (tx) => {
      const result = await persistSourceImportDrafts(tx, {
        actor,
        candidates: body.candidates!,
        idempotencyKey: idempotencyKey!,
        now,
      });
      await tx.prepare(`
        INSERT INTO audit_events
          (id, actor_id, actor_role, action, entity_type, entity_id, after_hash,
           metadata_json, request_id, created_at)
        VALUES (?, ?, ?, 'source.bulk_imported', 'source_import', ?, ?, ?, ?, ?)
      `).bind(
        `audit_${crypto.randomUUID()}`, actor.id, actor.role, `source_import_${crypto.randomUUID()}`,
        stableHash(result), JSON.stringify({ idempotencyKey, createdCount: result.created.length, skippedCount: result.skipped.length }),
        crypto.randomUUID(), now.toISOString(),
      ).run();
      await completeIdempotencyStatement(tx, start.reservation, 201, result).run();
      return result;
    });
    return Response.json(response, { status: 201 });
  } catch {
    await abandonIdempotentRequest(db, start.reservation);
    return sourceApiError('批量来源保存失败，未创建任何来源。', 503, {
      errorCode: 'STORAGE_ERROR', retryable: true,
    });
  }
}
