import type { Actor } from './control-plane.ts';
import type { SqlDatabase } from './sql.ts';
import { stableHash } from './workflow.ts';
import { sourceActionAllowed } from './source-authorization.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export async function requestCheckpointCutover(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    scope: 'live' | 'backfill';
    checkpointAfter: Record<string, unknown>;
    expectedSourceVersion: number;
    reason: string;
    idempotencyKey: string;
    actor: Actor;
  },
  now = new Date(),
) {
  if (!isRecord(input.checkpointAfter)) return { status: 422 as const, error: 'checkpointAfter 必须是对象。' };
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const replay = await tx.prepare(`
      SELECT id, source_config_id, scope, status FROM source_checkpoint_cutovers
      WHERE idempotency_key = ? LIMIT 1
    `).bind(input.idempotencyKey).first<{ id: string; source_config_id: string; scope: string; status: string }>();
    if (replay) {
      if (replay.source_config_id !== input.sourceConfigId || replay.scope !== input.scope) {
        return { status: 409 as const, error: 'Idempotency-Key 已用于其他 checkpoint cutover。' };
      }
      return { status: 200 as const, cutoverId: replay.id, cutoverStatus: replay.status, replayed: true };
    }
    const source = await tx.prepare(`
      SELECT version, lifecycle_status, active_run_id, checkpoint_version,
        backfill_checkpoint_version, checkpoint_json, backfill_checkpoint_json
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(input.sourceConfigId).first<{
      version: number; lifecycle_status: string; active_run_id: string | null;
      checkpoint_version: number; backfill_checkpoint_version: number;
      checkpoint_json: unknown; backfill_checkpoint_json: unknown;
    }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.lifecycle_status === 'archived') return { status: 409 as const, error: '已归档来源不能创建 checkpoint cutover。' };
    if (source.version !== input.expectedSourceVersion) return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    const pending = await tx.prepare(`
      SELECT id FROM source_checkpoint_cutovers
      WHERE source_config_id = ? AND scope = ? AND status = 'pending' LIMIT 1
    `).bind(input.sourceConfigId, input.scope).first<{ id: string }>();
    if (pending) return { status: 409 as const, error: `已有待审批的 checkpoint cutover ${pending.id}。` };
    const cutoverId = `checkpoint_cutover_${crypto.randomUUID()}`;
    const checkpointVersionBefore = input.scope === 'live' ? source.checkpoint_version : source.backfill_checkpoint_version;
    const checkpointBefore = input.scope === 'live' ? source.checkpoint_json : source.backfill_checkpoint_json;
    await tx.prepare(`
      INSERT INTO source_checkpoint_cutovers
        (id, source_config_id, scope, status, source_version,
         checkpoint_version_before, checkpoint_before_json, checkpoint_after_json,
         idempotency_key, requested_by, reason, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      cutoverId, input.sourceConfigId, input.scope, source.version,
      checkpointVersionBefore, JSON.stringify(checkpointBefore ?? {}),
      JSON.stringify(input.checkpointAfter), input.idempotencyKey, input.actor.id,
      input.reason.slice(0, 500), timestamp,
    ).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.checkpoint_cutover_requested', 'source_checkpoint_cutover',
        ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, cutoverId,
      stableHash(checkpointBefore ?? {}), stableHash(input.checkpointAfter),
      JSON.stringify({ sourceConfigId: input.sourceConfigId, scope: input.scope, sourceVersion: source.version, checkpointVersionBefore, reason: input.reason.slice(0, 500) }),
      crypto.randomUUID(), timestamp,
    ).run();
    return { status: 201 as const, cutoverId, cutoverStatus: 'pending' as const, replayed: false };
  });
}

export async function decideCheckpointCutover(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    cutoverId: string;
    decision: 'approve' | 'reject';
    note: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const cutover = await tx.prepare(`
      SELECT id, source_config_id, scope, status, source_version,
        checkpoint_version_before, checkpoint_before_json, checkpoint_after_json,
        requested_by
      FROM source_checkpoint_cutovers
      WHERE id = ? AND source_config_id = ?
      FOR UPDATE
    `).bind(input.cutoverId, input.sourceConfigId).first<{
      id: string; source_config_id: string; scope: 'live' | 'backfill'; status: string;
      source_version: number; checkpoint_version_before: number;
      checkpoint_before_json: unknown; checkpoint_after_json: unknown; requested_by: string;
    }>();
    if (!cutover) return { status: 404 as const, error: 'checkpoint cutover 不存在。' };
    if (cutover.status !== 'pending') return { status: 409 as const, error: `checkpoint cutover 已处于 ${cutover.status}。` };
    if (!sourceActionAllowed(input.actor, 'source.checkpoint.decide', { requestActorId: cutover.requested_by })) {
      return { status: 409 as const, error: '申请人不能批准或拒绝自己的 checkpoint cutover。' };
    }
    if (input.decision === 'reject') {
      await tx.prepare(`
        UPDATE source_checkpoint_cutovers
        SET status = 'rejected', approved_by = ?, decision_note = ?, decided_at = ?
        WHERE id = ? AND status = 'pending'
      `).bind(input.actor.id, input.note.slice(0, 500), timestamp, cutover.id).run();
      await auditCheckpointDecision(tx, cutover, input, timestamp, 'rejected');
      return { status: 200 as const, cutoverId: cutover.id, cutoverStatus: 'rejected' as const };
    }
    const source = await tx.prepare(`
      SELECT version, active_run_id, checkpoint_version, backfill_checkpoint_version
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(input.sourceConfigId).first<{
      version: number; active_run_id: string | null; checkpoint_version: number; backfill_checkpoint_version: number;
    }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.active_run_id) return { status: 409 as const, error: '来源存在活动采集运行，不能应用 checkpoint cutover。' };
    if (source.version !== cutover.source_version) return { status: 409 as const, error: '来源在申请后已变化，请重新创建 cutover。' };
    const currentCheckpointVersion = cutover.scope === 'live' ? source.checkpoint_version : source.backfill_checkpoint_version;
    if (currentCheckpointVersion !== cutover.checkpoint_version_before) {
      return { status: 409 as const, error: 'checkpoint 在申请后已推进，请重新创建 cutover。' };
    }
    const after = isRecord(cutover.checkpoint_after_json) ? cutover.checkpoint_after_json : {};
    const legacyCheckpoint = typeof after.watermark === 'string' ? after.watermark : null;
    const updated = cutover.scope === 'live'
      ? await tx.prepare(`
          UPDATE source_configs SET checkpoint = ?, checkpoint_json = ?,
            checkpoint_version = checkpoint_version + 1, version = version + 1,
            updated_at = ?
          WHERE id = ? AND version = ? AND checkpoint_version = ? AND active_run_id IS NULL
        `).bind(legacyCheckpoint, JSON.stringify(after), timestamp, input.sourceConfigId, source.version, currentCheckpointVersion).run()
      : await tx.prepare(`
          UPDATE source_configs SET backfill_checkpoint_json = ?,
            backfill_checkpoint_version = backfill_checkpoint_version + 1,
            version = version + 1, updated_at = ?
          WHERE id = ? AND version = ? AND backfill_checkpoint_version = ? AND active_run_id IS NULL
        `).bind(JSON.stringify(after), timestamp, input.sourceConfigId, source.version, currentCheckpointVersion).run();
    if (!updated.meta.changes) return { status: 409 as const, error: 'checkpoint cutover 应用时发生并发冲突。' };
    await tx.prepare(`
      UPDATE source_checkpoint_cutovers
      SET status = 'applied', approved_by = ?, decision_note = ?, decided_at = ?, applied_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(input.actor.id, input.note.slice(0, 500), timestamp, timestamp, cutover.id).run();
    await auditCheckpointDecision(tx, cutover, input, timestamp, 'applied');
    return { status: 200 as const, cutoverId: cutover.id, cutoverStatus: 'applied' as const, checkpointVersion: currentCheckpointVersion + 1, sourceVersion: source.version + 1 };
  });
}

async function auditCheckpointDecision(
  tx: SqlDatabase,
  cutover: { id: string; source_config_id: string; scope: string; checkpoint_before_json: unknown; checkpoint_after_json: unknown },
  input: { actor: Actor; note: string },
  timestamp: string,
  status: 'applied' | 'rejected',
) {
  await tx.prepare(`
    INSERT INTO audit_events
      (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
       after_hash, metadata_json, request_id, created_at)
    VALUES (?, ?, ?, 'source.checkpoint_cutover_decided', 'source_checkpoint_cutover',
      ?, ?, ?, ?, ?, ?)
  `).bind(
    `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, cutover.id,
    stableHash(cutover.checkpoint_before_json ?? {}), stableHash(cutover.checkpoint_after_json ?? {}),
    JSON.stringify({ sourceConfigId: cutover.source_config_id, scope: cutover.scope, status, note: input.note.slice(0, 500) }),
    crypto.randomUUID(), timestamp,
  ).run();
}
