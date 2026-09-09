import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { sourceApiError } from '@/lib/source-api-error';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.evidence.read')) return sourceApiError('当前角色无权查看证据 origin。', 403);
  const result = await db.prepare(`
    SELECT o.id, o.source_config_id, sc.name AS source_name, sc.platform, a.title,
      o.relationship AS detected_relationship, o.evidence_family_id AS detected_evidence_family_id,
      o.publisher_entity_id AS detected_publisher_entity_id, o.confidence AS detected_confidence,
      c.id AS correction_id, c.relationship, c.evidence_family_id, c.publisher_entity_id,
      c.confidence, c.reason, c.created_by, c.created_at
    FROM source_item_origins o
    JOIN source_configs sc ON sc.id = o.source_config_id
    JOIN articles a ON a.id = o.article_id
    LEFT JOIN source_origin_corrections c ON c.origin_id = o.id AND c.supersedes_correction_id IS NULL
    WHERE o.deleted_at IS NULL
    ORDER BY o.last_seen_at DESC, o.id DESC LIMIT 200
  `).all();
  return Response.json({ origins: result.results });
}
