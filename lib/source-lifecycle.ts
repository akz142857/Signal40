import type { Actor } from './control-plane.ts';
import type { SqlDatabase } from './sql.ts';
import { stableHash } from './workflow.ts';

type SourceState = {
  id: string;
  version: number;
  lifecycle_status: string;
  config_hash: string;
};

export type SourceLifecycleResult =
  | { status: 200; sourceId: string; version: number; cancelledRuns: number }
  | { status: 404 | 409; error: string };

export type SourceWithdrawalResult =
  | { status: 200; sourceId: string; version: number; withdrawnOrigins: number; cancelledRuns: number; pipelineJobId: string; replayed: boolean }
  | { status: 404 | 409; error: string };

async function cancelNotStartedRuns(db: SqlDatabase, sourceId: string, now: string) {
  await db.prepare(`
    UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
      last_error = '来源已停用，未开始的采集作业已取消。', updated_at = ?
    WHERE status IN ('queued', 'retrying') AND id IN (
      SELECT job_id FROM ingestion_runs WHERE source_config_id = ?
    )
  `).bind(now, sourceId).run();
  const cancelled = await db.prepare(`
    UPDATE ingestion_runs SET status = 'cancelled', finished_at = ?,
      error_code = 'SOURCE_DISABLED', retryable = 0,
      error_json = '{"message":"source disabled before execution"}'
    WHERE source_config_id = ? AND status = 'queued'
  `).bind(now, sourceId).run();
  return cancelled.meta.changes;
}

async function lockSource(db: SqlDatabase, sourceId: string) {
  return db.prepare(`
    SELECT id, version, lifecycle_status, config_hash
    FROM source_configs WHERE id = ? FOR UPDATE
  `).bind(sourceId).first<SourceState>();
}

async function auditLifecycle(
  db: SqlDatabase,
  input: { actor: Actor; action: string; source: SourceState; nextVersion: number; metadata: unknown; now: string },
) {
  await db.prepare(`
    INSERT INTO audit_events
      (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
       after_hash, metadata_json, request_id, created_at)
    VALUES (?, ?, ?, ?, 'source_config', ?, ?, ?, ?, ?, ?)
  `).bind(
    `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, input.action,
    input.source.id, stableHash({ configHash: input.source.config_hash, version: input.source.version, lifecycleStatus: input.source.lifecycle_status }),
    stableHash({ configHash: input.source.config_hash, version: input.nextVersion, action: input.action }),
    JSON.stringify(input.metadata), crypto.randomUUID(), input.now,
  ).run();
}

export async function archiveSource(
  db: SqlDatabase,
  input: { sourceId: string; expectedVersion: number; reason: string; actor: Actor },
  now = new Date(),
): Promise<SourceLifecycleResult> {
  return db.transaction(async (tx) => {
    const source = await lockSource(tx, input.sourceId);
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.version !== input.expectedVersion) return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    if (source.lifecycle_status === 'archived') {
      return { status: 200 as const, sourceId: source.id, version: source.version, cancelledRuns: 0 };
    }
    const timestamp = now.toISOString();
    const updated = await tx.prepare(`
      UPDATE source_configs SET enabled = 0, lifecycle_status = 'archived',
        health_status = 'paused', next_run_at = NULL, active_run_id = NULL,
        archived_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(timestamp, timestamp, source.id, source.version).run();
    if (!updated.meta.changes) return { status: 409 as const, error: '来源已被其他管理员修改。' };
    const cancelledRuns = await cancelNotStartedRuns(tx, source.id, timestamp);
    await auditLifecycle(tx, {
      actor: input.actor, action: 'source.archived', source, nextVersion: source.version + 1,
      metadata: { reason: input.reason.slice(0, 500), cancelledRuns }, now: timestamp,
    });
    return { status: 200 as const, sourceId: source.id, version: source.version + 1, cancelledRuns };
  });
}

export async function withdrawSourceContent(
  db: SqlDatabase,
  input: { sourceId: string; expectedVersion: number; reason: string; idempotencyKey: string; actor: Actor },
  now = new Date(),
): Promise<SourceWithdrawalResult> {
  return db.transaction(async (tx) => {
    const replay = await tx.prepare(`
      SELECT metadata_json FROM audit_events
      WHERE action = 'source.content_withdrawn'
        AND metadata_json ->> 'idempotencyKey' = ?
      LIMIT 1
    `).bind(input.idempotencyKey).first<{ metadata_json: unknown }>();
    if (replay) {
      const metadata = typeof replay.metadata_json === 'string'
        ? JSON.parse(replay.metadata_json) as Record<string, unknown>
        : replay.metadata_json as Record<string, unknown>;
      return {
        status: 200 as const,
        sourceId: String(metadata.sourceId),
        version: Number(metadata.version),
        withdrawnOrigins: Number(metadata.withdrawnOrigins),
        cancelledRuns: Number(metadata.cancelledRuns),
        pipelineJobId: String(metadata.pipelineJobId),
        replayed: true,
      };
    }
    const source = await lockSource(tx, input.sourceId);
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.version !== input.expectedVersion) return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    const timestamp = now.toISOString();
    const withdrawn = await tx.prepare(`
      UPDATE source_item_origins SET deleted_at = ?, last_seen_at = ?
      WHERE source_config_id = ? AND deleted_at IS NULL
    `).bind(timestamp, timestamp, source.id).run();
    await tx.prepare(`
      UPDATE source_rights_grants SET revoked_at = ?
      WHERE source_config_id = ? AND revoked_at IS NULL
    `).bind(timestamp, source.id).run();
    const updated = await tx.prepare(`
      UPDATE source_configs SET enabled = 0, lifecycle_status = 'paused',
        health_status = 'paused', rights_status = 'revoked', next_run_at = NULL,
        active_run_id = NULL, last_error_code = 'RIGHTS_BLOCKED',
        last_error = '来源权利已撤回。',
        last_error_detail_redacted = '已停止使用该来源内容，派生主题正在重算。',
        version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(timestamp, source.id, source.version).run();
    if (!updated.meta.changes) return { status: 409 as const, error: '来源已被其他管理员修改。' };
    const cancelledRuns = await cancelNotStartedRuns(tx, source.id, timestamp);
    const derivationKey = `withdrawal:${source.id}:${source.version + 1}`;
    const pipelineJobId = `job_pipeline_${stableHash(derivationKey).slice(0, 32)}`;
    await tx.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, payload_schema_version, payload_json,
         status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
      VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
      ON CONFLICT (kind, idempotency_key) DO NOTHING
    `).bind(
      pipelineJobId,
      JSON.stringify({ schemaVersion: 2, operation: 'topic_recompute', derivationKey, rollingWindowHours: 72 }),
      `topic-recompute:${derivationKey}`, timestamp, timestamp, timestamp,
    ).run();
    const metadata = {
      idempotencyKey: input.idempotencyKey,
      sourceId: source.id,
      version: source.version + 1,
      withdrawnOrigins: withdrawn.meta.changes,
      cancelledRuns,
      pipelineJobId,
      reason: input.reason.slice(0, 500),
    };
    await auditLifecycle(tx, {
      actor: input.actor, action: 'source.content_withdrawn', source,
      nextVersion: source.version + 1, metadata, now: timestamp,
    });
    return { status: 200 as const, sourceId: source.id, version: source.version + 1, withdrawnOrigins: withdrawn.meta.changes, cancelledRuns, pipelineJobId, replayed: false };
  });
}
