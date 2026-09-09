import type { Actor } from './control-plane.ts';
import type { SqlDatabase } from './sql.ts';
import { stableHash } from './workflow.ts';

export type IngestionQuarantineAction = 'hold' | 'release' | 'discard';

export async function changeIngestionQuarantine(
  db: SqlDatabase,
  input: {
    ingestionRunId: string;
    action: IngestionQuarantineAction;
    note: string;
    idempotencyKey: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const replay = await tx.prepare(`
      SELECT metadata_json FROM audit_events
      WHERE action = 'ingestion.quarantine_changed'
        AND metadata_json ->> 'idempotencyKey' = ?
      LIMIT 1
    `).bind(input.idempotencyKey).first<{ metadata_json: unknown }>();
    if (replay) {
      const metadata = typeof replay.metadata_json === 'string'
        ? JSON.parse(replay.metadata_json) as Record<string, unknown>
        : replay.metadata_json as Record<string, unknown>;
      if (metadata.ingestionRunId !== input.ingestionRunId || metadata.action !== input.action) {
        return { status: 409 as const, error: 'Idempotency-Key 已用于其他隔离操作。' };
      }
      return { status: 200 as const, replayed: true, ...metadata };
    }
    const run = await tx.prepare(`
      SELECT ingestion_row.id, ingestion_row.source_config_id, ingestion_row.status,
        ingestion_row.quarantine_status, source_row.rights_status,
        COALESCE(NULLIF(source_row.rights_config_hash, ''), source_row.config_hash) AS config_hash
      FROM ingestion_runs ingestion_row
      JOIN source_configs source_row ON source_row.id = ingestion_row.source_config_id
      WHERE ingestion_row.id = ?
      FOR UPDATE OF ingestion_row, source_row
    `).bind(input.ingestionRunId).first<{
      id: string; source_config_id: string; status: string; quarantine_status: string;
      rights_status: string; config_hash: string;
    }>();
    if (!run) return { status: 404 as const, error: '采集运行不存在。' };
    if (!['succeeded', 'partial', 'failed', 'rights_blocked'].includes(run.status)) {
      return { status: 409 as const, error: '只有已结束的采集运行可以变更隔离状态。' };
    }
    const targetStatus = input.action === 'hold' ? 'held' : input.action === 'release' ? 'released' : 'discarded';
    if (run.quarantine_status === 'discarded' && targetStatus !== 'discarded') {
      return { status: 409 as const, error: '已丢弃的采集批次不能恢复或重新挂起。' };
    }
    if (run.quarantine_status === targetStatus) {
      return {
        status: 200 as const,
        ingestionRunId: run.id,
        sourceConfigId: run.source_config_id,
        action: input.action,
        quarantineStatus: targetStatus,
        affectedOrigins: 0,
        replayed: true,
      };
    }
    if (input.action === 'release') {
      if (run.rights_status !== 'approved') {
        return { status: 409 as const, error: '来源权利状态未批准，不能释放隔离内容。' };
      }
      const grant = await tx.prepare(`
        SELECT id FROM source_rights_grants
        WHERE source_config_id = ? AND config_hash = ? AND revoked_at IS NULL
          AND purpose = 'finance-editorial-ingestion'
          AND usage_scope IN ('normalized-metadata', 'normalized-and-authorized-raw')
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1
      `).bind(run.source_config_id, run.config_hash, timestamp).first<{ id: string }>();
      if (!grant) return { status: 409 as const, error: '没有与当前配置绑定的有效授权，不能释放隔离内容。' };
    }
    const originResult = input.action === 'release'
      ? await tx.prepare(`
          UPDATE source_item_origins SET deleted_at = NULL, last_seen_at = ?
          WHERE ingestion_run_id = ? AND deleted_at IS NOT NULL
        `).bind(timestamp, run.id).run()
      : await tx.prepare(`
          UPDATE source_item_origins SET deleted_at = COALESCE(deleted_at, ?), last_seen_at = ?
          WHERE ingestion_run_id = ?
        `).bind(timestamp, timestamp, run.id).run();
    await tx.prepare(`
      UPDATE ingestion_runs SET quarantine_status = ? WHERE id = ?
    `).bind(targetStatus, run.id).run();
    if (input.action === 'discard') {
      await tx.prepare(`
        UPDATE raw_payload_uploads
        SET state = 'expired', expires_at = ?, delete_after = ?, updated_at = ?
        WHERE ingestion_run_id = ? AND state IN ('initiated', 'uploaded', 'committed', 'aborted')
      `).bind(timestamp, timestamp, timestamp, run.id).run();
    }
    const derivationKey = `ingestion-quarantine:${run.id}:${targetStatus}`;
    const pipelineJobId = `job_pipeline_${stableHash(derivationKey).slice(0, 32)}`;
    await tx.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, payload_schema_version, payload_json,
         status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
      VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
      ON CONFLICT (kind, idempotency_key) DO NOTHING
    `).bind(
      pipelineJobId,
      JSON.stringify({ schemaVersion: 2, operation: 'topic_recompute', derivationKey, sourceIngestionRunId: run.id, rollingWindowHours: 72 }),
      `topic-recompute:${derivationKey}`, timestamp, timestamp, timestamp,
    ).run();
    const metadata = {
      idempotencyKey: input.idempotencyKey,
      ingestionRunId: run.id,
      sourceConfigId: run.source_config_id,
      action: input.action,
      quarantineStatus: targetStatus,
      affectedOrigins: originResult.meta.changes,
      pipelineJobId,
      note: input.note.slice(0, 500),
    };
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'ingestion.quarantine_changed', 'ingestion_run', ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, run.id,
      stableHash({ quarantineStatus: run.quarantine_status }),
      stableHash({ quarantineStatus: targetStatus }), JSON.stringify(metadata),
      crypto.randomUUID(), timestamp,
    ).run();
    return { status: 200 as const, replayed: false, ...metadata };
  });
}
