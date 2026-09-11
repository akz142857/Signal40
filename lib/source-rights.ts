export const INGESTION_RIGHTS_PURPOSE = 'finance-editorial-ingestion';
export const NORMALIZED_METADATA_SCOPE = 'normalized-metadata';
export const AUTHORIZED_RAW_SCOPE = 'normalized-and-authorized-raw';

export type IngestionRightsSnapshot = {
  sourceEnabled: number | boolean;
  sourceLifecycleStatus: string;
  sourceRightsStatus: string;
  sourceRetentionMode: string;
  sourceConfigHash: string;
  runSourceVersion: number;
  runRightsGrantId: string | null;
  grantId: string | null;
  grantRevokedAt: string | null;
  grantExpiresAt: string | null;
  grantPurpose: string | null;
  grantUsageScope: string | null;
  grantPermittedFields: unknown;
  grantSourceVersion: number | null;
  grantConfigHash: string | null;
};

/**
 * 提交边界的纯判定器。调用方必须在同一事务里锁住 run/source，并在返回
 * null 后才写 article/origin/checkpoint，避免检查与提交之间再次失权。
 */
export function ingestionRightsBlockReason(
  snapshot: IngestionRightsSnapshot,
  input: { now: Date; requiredFields: Iterable<string>; hasRawPayload: boolean },
): string | null {
  if (!snapshot.sourceEnabled || !['enabled', 'degraded'].includes(snapshot.sourceLifecycleStatus)) {
    return '来源已在采集期间停用。';
  }
  if (snapshot.sourceRightsStatus !== 'approved') return '来源权利状态已不再批准。';
  if (!snapshot.runRightsGrantId || snapshot.grantId !== snapshot.runRightsGrantId) {
    return '采集运行绑定的权利授权不存在。';
  }
  if (snapshot.grantRevokedAt || (snapshot.grantExpiresAt && snapshot.grantExpiresAt <= input.now.toISOString())) {
    return '采集运行绑定的权利授权已撤销或过期。';
  }
  if (snapshot.grantPurpose !== INGESTION_RIGHTS_PURPOSE) return '权利授权不允许编辑采集。';
  if (![NORMALIZED_METADATA_SCOPE, AUTHORIZED_RAW_SCOPE].includes(snapshot.grantUsageScope ?? '')) {
    return '权利授权不允许写入规范化结果。';
  }
  if (!snapshot.grantConfigHash || snapshot.grantConfigHash !== snapshot.sourceConfigHash) {
    return '权利授权与当前来源配置不匹配。';
  }
  if (!snapshot.grantSourceVersion || snapshot.grantSourceVersion > snapshot.runSourceVersion) {
    return '权利授权版本与采集运行不匹配。';
  }
  if (input.hasRawPayload && snapshot.sourceRetentionMode !== 'raw') {
    return '来源保留策略不允许保存原始载荷。';
  }
  if (input.hasRawPayload && snapshot.grantUsageScope !== AUTHORIZED_RAW_SCOPE) {
    return '权利授权不允许保留原始载荷。';
  }
  const permittedFields = Array.isArray(snapshot.grantPermittedFields)
    ? new Set(snapshot.grantPermittedFields.filter((value): value is string => typeof value === 'string'))
    : new Set<string>();
  if ([...input.requiredFields].some((field) => !permittedFields.has(field))) {
    return '采集结果包含权利授权未允许的字段。';
  }
  return null;
}

/** 在提交事务中持久化 fail-closed 结果；调用方随后不得写业务内容。 */
export async function quarantineRightsBlockedIngestion(
  tx: SqlDatabase,
  input: { sourceConfigId: string; ingestionRunId: string; rightsGrantId: string | null; reason: string },
  now: Date,
) {
  const timestamp = now.toISOString();
  await tx.prepare(`
    UPDATE ingestion_runs
    SET status = 'rights_blocked', quarantine_status = 'held', error_code = 'RIGHTS_BLOCKED',
      error_json = ?, retryable = 0, retry_after = NULL,
      started_at = COALESCE(started_at, ?), finished_at = ?
    WHERE id = ?
  `).bind(JSON.stringify({ code: 'RIGHTS_BLOCKED', message: input.reason }), timestamp, timestamp, input.ingestionRunId).run();
  await tx.prepare(`
    UPDATE source_configs
    SET enabled = 0, lifecycle_status = 'paused', health_status = 'paused',
      last_error = ?, last_error_code = 'RIGHTS_BLOCKED',
      last_error_detail_redacted = ?, next_run_at = NULL,
      active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
      updated_at = ?
    WHERE id = ?
  `).bind(input.reason, input.reason, input.ingestionRunId, timestamp, input.sourceConfigId).run();
  await tx.prepare(`
    UPDATE raw_payload_uploads
    SET state = 'expired', expires_at = ?, delete_after = ?, updated_at = ?
    WHERE source_config_id = ? AND ingestion_run_id = ?
      AND state IN ('initiated', 'uploaded', 'aborted')
  `).bind(timestamp, timestamp, timestamp, input.sourceConfigId, input.ingestionRunId).run();
  await raiseAttentionItem(tx, {
    kind: 'source_rights',
    severity: 'critical',
    sourceConfigId: input.sourceConfigId,
    dedupeKey: `source_rights:${input.sourceConfigId}`,
    reason: `来源权利在提交前失效，采集结果未入库：${input.reason}`,
    detail: {
      sourceConfigId: input.sourceConfigId,
      ingestionRunId: input.ingestionRunId,
      rightsGrantId: input.rightsGrantId,
    },
  }, now);
}

/**
 * 调度 tick 的授权到期投影。每个来源单独事务化，避免一个坏行阻塞其余来源。
 * 已租约运行不在这里强杀，而是在提交边界由同一 grant 快照 fail closed。
 */
export async function expireDueSourceRights(
  db: SqlDatabase,
  actor: { id: string; role: string },
  now: Date,
  limit = 50,
) {
  const timestamp = now.toISOString();
  const due = await db.prepare(`
    SELECT grant_row.id AS grant_id, grant_row.source_config_id
    FROM source_rights_grants grant_row
    JOIN source_configs source_row ON source_row.id = grant_row.source_config_id
    WHERE grant_row.revoked_at IS NULL AND grant_row.expires_at IS NOT NULL
      AND grant_row.expires_at <= ? AND source_row.rights_status = 'approved'
      AND source_row.lifecycle_status <> 'archived'
    ORDER BY grant_row.expires_at ASC, grant_row.id ASC
    LIMIT ?
  `).bind(timestamp, limit).all<{ grant_id: string; source_config_id: string }>();
  const expired: Array<{ sourceConfigId: string; grantId: string; cancelledRuns: number }> = [];
  for (const candidate of due.results) {
    const projected = await db.transaction(async (tx) => {
      const row = await tx.prepare(`
        SELECT grant_row.id AS grant_id, grant_row.expires_at
        FROM source_rights_grants grant_row
        JOIN source_configs source_row ON source_row.id = grant_row.source_config_id
        WHERE grant_row.id = ? AND grant_row.source_config_id = ?
          AND grant_row.revoked_at IS NULL AND grant_row.expires_at IS NOT NULL
          AND grant_row.expires_at <= ? AND source_row.rights_status = 'approved'
          AND source_row.lifecycle_status <> 'archived'
        FOR UPDATE OF grant_row, source_row
      `).bind(candidate.grant_id, candidate.source_config_id, timestamp).first<{
        grant_id: string; expires_at: string;
      }>();
      if (!row) return null;
      const cancelledJobs = await tx.prepare(`
        UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          last_error = '来源授权已过期。', updated_at = ?
        WHERE kind = 'ingestion' AND status IN ('queued', 'retrying')
          AND payload_json ->> 'sourceConfigId' = ?
      `).bind(timestamp, candidate.source_config_id).run();
      const cancelledRuns = await tx.prepare(`
        UPDATE ingestion_runs SET status = 'cancelled', error_code = 'RIGHTS_BLOCKED',
          retryable = 0, retry_after = NULL, error_json = ?, finished_at = ?
        WHERE source_config_id = ? AND status = 'queued'
      `).bind(
        JSON.stringify({ code: 'RIGHTS_BLOCKED', message: '来源授权已过期。' }),
        timestamp, candidate.source_config_id,
      ).run();
      await tx.prepare(`
        UPDATE source_configs
        SET enabled = 0, lifecycle_status = 'paused', health_status = 'paused',
          rights_status = 'expired', next_run_at = NULL,
          active_run_id = CASE WHEN EXISTS (
            SELECT 1 FROM ingestion_runs WHERE id = source_configs.active_run_id AND status = 'cancelled'
          ) THEN NULL ELSE active_run_id END,
          last_error = '来源授权已过期。', last_error_code = 'RIGHTS_BLOCKED',
          last_error_detail_redacted = '请重新确认来源使用权后再启用。',
          version = version + 1, updated_at = ?
        WHERE id = ? AND rights_status = 'approved'
      `).bind(timestamp, candidate.source_config_id).run();
      await raiseAttentionItem(tx, {
        kind: 'source_rights',
        severity: 'critical',
        sourceConfigId: candidate.source_config_id,
        dedupeKey: `source_rights:${candidate.source_config_id}`,
        reason: '来源授权已过期，来源已停用；请重新确认使用权并完成连接测试。',
        detail: {
          sourceConfigId: candidate.source_config_id,
          rightsGrantId: candidate.grant_id,
          expiredAt: row.expires_at,
          cancelledJobs: cancelledJobs.meta.changes,
          cancelledRuns: cancelledRuns.meta.changes,
        },
      }, now);
      await tx.prepare(`
        INSERT INTO audit_events
          (id, actor_id, actor_role, action, entity_type, entity_id, after_hash,
           metadata_json, request_id, created_at)
        VALUES (?, ?, ?, 'source.rights_expired', 'source_config', ?, ?, ?, ?, ?)
      `).bind(
        `audit_${crypto.randomUUID()}`, actor.id, actor.role, candidate.source_config_id,
        candidate.grant_id,
        JSON.stringify({ rightsGrantId: candidate.grant_id, expiredAt: row.expires_at, cancelledJobs: cancelledJobs.meta.changes, cancelledRuns: cancelledRuns.meta.changes }),
        crypto.randomUUID(), timestamp,
      ).run();
      return { sourceConfigId: candidate.source_config_id, grantId: candidate.grant_id, cancelledRuns: cancelledRuns.meta.changes };
    });
    if (projected) expired.push(projected);
  }
  return expired;
}
import { raiseAttentionItem } from './attention.ts';
import type { SqlDatabase } from './sql.ts';
