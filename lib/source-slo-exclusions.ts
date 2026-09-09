import type { Actor } from './control-plane.ts';
import type { SqlDatabase } from './sql.ts';
import { stableHash } from './workflow.ts';

export type SourceSloExclusionKind = 'manual_pause' | 'planned_maintenance';

export type SourceSloExclusion = {
  id: string;
  source_config_id: string;
  kind: SourceSloExclusionKind;
  starts_at: string;
  ends_at: string | null;
  reason: string;
  cancelled_at?: string | null;
};

function validReason(reason: string) {
  const value = reason.trim();
  return value.length >= 3 && value.length <= 500 ? value : null;
}

export async function openManualSourceSloExclusion(
  db: SqlDatabase,
  input: { sourceId: string; reason: string; actor: Actor },
  now = new Date(),
) {
  const reason = validReason(input.reason);
  if (!reason) throw new Error('暂停原因必须为 3–500 个字符。');
  const timestamp = now.toISOString();
  const id = `source_slo_exclusion_${crypto.randomUUID()}`;
  await db
    .prepare(`
      INSERT INTO source_slo_exclusions
        (id, source_config_id, kind, starts_at, ends_at, reason,
         created_by, closed_by, cancelled_by, created_at, closed_at, cancelled_at)
      VALUES (?, ?, 'manual_pause', ?, NULL, ?, ?, NULL, NULL, ?, NULL, NULL)
      ON CONFLICT DO NOTHING
    `)
    .bind(
      id,
      input.sourceId,
      timestamp,
      reason,
      input.actor.id,
      timestamp,
    )
    .run();
  return db
    .prepare(`
      SELECT id, source_config_id, kind, starts_at, ends_at, reason
      FROM source_slo_exclusions
      WHERE source_config_id = ? AND kind = 'manual_pause' AND ends_at IS NULL
      LIMIT 1
    `)
    .bind(input.sourceId)
    .first<SourceSloExclusion>();
}

export async function createPlannedSourceSloExclusion(
  db: SqlDatabase,
  input: {
    sourceId: string;
    startsAt: string;
    endsAt: string;
    reason: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const reason = validReason(input.reason);
  const start = new Date(input.startsAt).valueOf();
  const end = new Date(input.endsAt).valueOf();
  const nowValue = now.valueOf();
  if (!reason) throw new Error('维护原因必须为 3–500 个字符。');
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < nowValue ||
    end <= start ||
    end - start > 7 * 24 * 60 * 60_000 ||
    start - nowValue > 90 * 24 * 60 * 60_000
  ) {
    throw new Error('计划维护必须在未来 90 天内开始，结束晚于开始且不超过 7 天。');
  }
  return db.transaction(async (tx) => {
    const source = await tx
      .prepare(
        "SELECT id FROM source_configs WHERE id = ? AND lifecycle_status <> 'archived' LIMIT 1",
      )
      .bind(input.sourceId)
      .first<{ id: string }>();
    if (!source) throw new Error('来源不存在或已归档。');
    const timestamp = now.toISOString();
    const startsAt = new Date(start).toISOString();
    const endsAt = new Date(end).toISOString();
    const existing = await tx
      .prepare(`
        SELECT id, source_config_id, kind, starts_at, ends_at, reason, cancelled_at
        FROM source_slo_exclusions
        WHERE source_config_id = ? AND kind = 'planned_maintenance'
          AND starts_at = ? AND ends_at = ? AND cancelled_at IS NULL
        LIMIT 1
      `)
      .bind(input.sourceId, startsAt, endsAt)
      .first<SourceSloExclusion>();
    if (existing) return { exclusion: existing, replayed: true };
    const id = `source_slo_exclusion_${crypto.randomUUID()}`;
    const exclusion = {
      id,
      source_config_id: input.sourceId,
      kind: 'planned_maintenance' as const,
      starts_at: startsAt,
      ends_at: endsAt,
      reason,
      cancelled_at: null,
    };
    await tx
      .prepare(`
        INSERT INTO source_slo_exclusions
          (id, source_config_id, kind, starts_at, ends_at, reason,
           created_by, created_at)
        VALUES (?, ?, 'planned_maintenance', ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        input.sourceId,
        startsAt,
        endsAt,
        reason,
        input.actor.id,
        timestamp,
      )
      .run();
    await tx
      .prepare(`
        INSERT INTO audit_events
          (id, actor_id, actor_role, action, entity_type, entity_id,
           after_hash, metadata_json, request_id, created_at)
        VALUES (?, ?, ?, 'source.slo_exclusion_created', 'source_config', ?, ?, ?, ?, ?)
      `)
      .bind(
        `audit_${crypto.randomUUID()}`,
        input.actor.id,
        input.actor.role,
        input.sourceId,
        stableHash(exclusion),
        JSON.stringify({
          exclusionId: id,
          kind: exclusion.kind,
          startsAt,
          endsAt,
          reason,
        }),
        crypto.randomUUID(),
        timestamp,
      )
      .run();
    return { exclusion, replayed: false };
  });
}

export async function cancelPlannedSourceSloExclusion(
  db: SqlDatabase,
  input: {
    sourceId: string;
    exclusionId: string;
    reason: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const reason = validReason(input.reason);
  if (!reason) throw new Error('取消原因必须为 3–500 个字符。');
  return db.transaction(async (tx) => {
    const exclusion = await tx
      .prepare(`
        SELECT id, source_config_id, kind, starts_at, ends_at, reason, cancelled_at
        FROM source_slo_exclusions
        WHERE id = ? AND source_config_id = ? AND kind = 'planned_maintenance'
        FOR UPDATE
      `)
      .bind(input.exclusionId, input.sourceId)
      .first<SourceSloExclusion>();
    if (!exclusion) throw new Error('计划维护窗口不存在。');
    if (exclusion.cancelled_at) {
      return { exclusionId: exclusion.id, replayed: true };
    }
    const timestamp = now.toISOString();
    if (new Date(exclusion.starts_at).valueOf() <= now.valueOf()) {
      throw new Error('已经开始的维护窗口不能取消，只能等待其结束。');
    }
    await tx
      .prepare(`
        UPDATE source_slo_exclusions SET cancelled_by = ?, cancelled_at = ?
        WHERE id = ? AND cancelled_at IS NULL
      `)
      .bind(input.actor.id, timestamp, exclusion.id)
      .run();
    await tx
      .prepare(`
        INSERT INTO audit_events
          (id, actor_id, actor_role, action, entity_type, entity_id,
           before_hash, after_hash, metadata_json, request_id, created_at)
        VALUES (?, ?, ?, 'source.slo_exclusion_cancelled', 'source_config', ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        `audit_${crypto.randomUUID()}`,
        input.actor.id,
        input.actor.role,
        input.sourceId,
        stableHash(exclusion),
        stableHash({ ...exclusion, cancelledAt: timestamp }),
        JSON.stringify({ exclusionId: exclusion.id, reason }),
        crypto.randomUUID(),
        timestamp,
      )
      .run();
    return { exclusionId: exclusion.id, replayed: false };
  });
}

export async function listSourceSloExclusions(
  db: SqlDatabase,
  sourceId: string,
) {
  return (
    await db
      .prepare(`
        SELECT id, source_config_id, kind, starts_at, ends_at, reason, cancelled_at
        FROM source_slo_exclusions
        WHERE source_config_id = ?
        ORDER BY starts_at DESC, id DESC LIMIT 200
      `)
      .bind(sourceId)
      .all<SourceSloExclusion>()
  ).results;
}

export async function closeManualSourceSloExclusion(
  db: SqlDatabase,
  input: { sourceId: string; actor: Actor },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  const result = await db
    .prepare(`
      UPDATE source_slo_exclusions
      SET ends_at = ?, closed_by = ?, closed_at = ?
      WHERE source_config_id = ? AND kind = 'manual_pause' AND ends_at IS NULL
        AND starts_at < ?
    `)
    .bind(timestamp, input.actor.id, timestamp, input.sourceId, timestamp)
    .run();
  return Number(result.meta.changes ?? 0);
}

export function sourceSloExcludesInstant(
  exclusions: SourceSloExclusion[],
  instant: number,
) {
  return exclusions.some((exclusion) => {
    if (exclusion.cancelled_at) return false;
    const start = new Date(exclusion.starts_at).valueOf();
    const end = exclusion.ends_at
      ? new Date(exclusion.ends_at).valueOf()
      : Number.POSITIVE_INFINITY;
    return Number.isFinite(start) && instant >= start && instant < end;
  });
}
