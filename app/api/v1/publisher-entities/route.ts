import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { sourceApiError } from '@/lib/source-api-error';
import { stableHash } from '@/lib/workflow';

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.evidence.read')) return sourceApiError('当前角色无权查看 publisher entity。', 403);
  const result = await db.prepare('SELECT id, legal_name, ownership_group, entity_type, identifiers_json, created_at, updated_at FROM publisher_entities ORDER BY legal_name, id LIMIT 500').all();
  return Response.json({ entities: result.results });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.evidence.manage')) return sourceApiError('只有管理员可以登记 publisher entity。', 403);
  let body: { id?: string; legalName?: string; ownershipGroup?: string; entityType?: string; identifiers?: Record<string, string> };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!ID_PATTERN.test(body.id ?? '') || !ID_PATTERN.test(body.ownershipGroup ?? '') || !body.legalName?.trim() || body.legalName.length > 300 || !body.entityType?.trim() || body.entityType.length > 80) {
    return sourceApiError('稳定 ID、法定主体、所有权集团和主体类型必填。', 422);
  }
  if (body.identifiers && (typeof body.identifiers !== 'object' || Array.isArray(body.identifiers) || Object.keys(body.identifiers).length > 30 || Object.entries(body.identifiers).some(([key, value]) => !ID_PATTERN.test(key) || typeof value !== 'string' || value.length > 500))) {
    return sourceApiError('identifiers 必须是最多 30 项的受限字符串映射。', 422);
  }
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare('INSERT INTO publisher_entities (id, legal_name, ownership_group, entity_type, identifiers_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(body.id, body.legalName.trim(), body.ownershipGroup, body.entityType.trim(), JSON.stringify(body.identifiers ?? {}), now, now),
      db.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'publisher_entity.created', 'publisher_entity', ?, ?, ?, ?, ?)")
        .bind(`audit_${crypto.randomUUID()}`, actor!.id, actor!.role, body.id, stableHash(body), JSON.stringify({ ownershipGroup: body.ownershipGroup, entityType: body.entityType }), crypto.randomUUID(), now),
    ]);
  } catch {
    return sourceApiError('publisher entity 已存在或保存失败。', 409);
  }
  return Response.json({ entity: { id: body.id } }, { status: 201 });
}
