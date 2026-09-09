import { EVIDENCE_RELATIONSHIPS, type EvidenceRelationship } from './social-evidence.ts';
import type { SqlDatabase } from './sql.ts';
import { stableHash, type Actor } from './workflow.ts';

export type SourceOriginCorrectionInput = {
  originId: string;
  relationship: EvidenceRelationship;
  evidenceFamilyId: string;
  publisherEntityId: string;
  confidence: number;
  reason: string;
  actor: Actor;
};

export async function recordSourceOriginCorrection(
  db: SqlDatabase,
  input: SourceOriginCorrectionInput,
  now = new Date(),
) {
  if (!EVIDENCE_RELATIONSHIPS.includes(input.relationship)) return { status: 422 as const, error: 'relationship 无效。' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(input.evidenceFamilyId)) return { status: 422 as const, error: 'evidenceFamilyId 必须是 1–200 位稳定标识。' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(input.publisherEntityId)) return { status: 422 as const, error: 'publisherEntityId 必须是 1–200 位稳定标识。' };
  if (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100) return { status: 422 as const, error: 'confidence 必须是 0–100 的整数。' };
  if (input.reason.trim().length < 10 || input.reason.length > 1000) return { status: 422 as const, error: '人工修正原因必须为 10–1000 字。' };
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const origin = await tx.prepare(`
      SELECT o.id, o.source_config_id, o.relationship, o.evidence_family_id,
        o.publisher_entity_id, o.confidence, o.deleted_at
      FROM source_item_origins o WHERE o.id = ? FOR UPDATE
    `).bind(input.originId).first<Record<string, unknown>>();
    if (!origin) return { status: 404 as const, error: '来源 origin 不存在。' };
    if (origin.deleted_at) return { status: 409 as const, error: '已删除 origin 不能晋级为生产证据。' };
    const publisher = await tx.prepare('SELECT id FROM publisher_entities WHERE id = ? LIMIT 1')
      .bind(input.publisherEntityId).first<{ id: string }>();
    if (!publisher) return { status: 422 as const, error: 'publisher entity 不存在；请先完成受控主体登记。' };
    const previous = await tx.prepare(`
      SELECT id, relationship, evidence_family_id, publisher_entity_id, confidence
      FROM source_origin_corrections
      WHERE origin_id = ? AND supersedes_correction_id IS NULL
      ORDER BY created_at DESC, id DESC LIMIT 1 FOR UPDATE
    `).bind(input.originId).first<Record<string, unknown>>();
    const next = {
      relationship: input.relationship,
      evidenceFamilyId: input.evidenceFamilyId,
      publisherEntityId: input.publisherEntityId,
      confidence: input.confidence,
    };
    const current = previous ? {
      relationship: previous.relationship,
      evidenceFamilyId: previous.evidence_family_id,
      publisherEntityId: previous.publisher_entity_id,
      confidence: Number(previous.confidence),
    } : {
      relationship: origin.relationship,
      evidenceFamilyId: origin.evidence_family_id,
      publisherEntityId: origin.publisher_entity_id,
      confidence: Number(origin.confidence),
    };
    if (stableHash(current) === stableHash(next)) return { status: 409 as const, error: '修正内容没有变化。' };
    const correctionId = `origin_correction_${crypto.randomUUID()}`;
    if (previous) {
      await tx.prepare('UPDATE source_origin_corrections SET supersedes_correction_id = ? WHERE id = ? AND supersedes_correction_id IS NULL')
        .bind(correctionId, previous.id).run();
    }
    await tx.prepare(`
      INSERT INTO source_origin_corrections
        (id, origin_id, relationship, evidence_family_id, publisher_entity_id,
         confidence, reason, created_by, supersedes_correction_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    `).bind(
      correctionId, input.originId, input.relationship, input.evidenceFamilyId,
      input.publisherEntityId, input.confidence, input.reason.trim(), input.actor.id, timestamp,
    ).run();
    const derivationKey = `origin-correction:${input.originId}:${correctionId}`;
    const pipelineJobId = `job_pipeline_${stableHash(derivationKey).slice(0, 32)}`;
    await tx.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, payload_schema_version, payload_json,
         status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
      VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
      ON CONFLICT (kind, idempotency_key) DO NOTHING
    `).bind(
      pipelineJobId,
      JSON.stringify({ schemaVersion: 2, operation: 'topic_recompute', derivationKey, originId: input.originId, rollingWindowHours: 72 }),
      `topic-recompute:${derivationKey}`, timestamp, timestamp, timestamp,
    ).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source_origin.corrected', 'source_item_origin', ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, input.originId,
      stableHash(current), stableHash(next),
      JSON.stringify({ correctionId, sourceConfigId: origin.source_config_id, reason: input.reason.trim(), pipelineJobId }),
      crypto.randomUUID(), timestamp,
    ).run();
    return { status: 201 as const, correctionId, pipelineJobId };
  });
}

