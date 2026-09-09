import { raiseAttentionItem } from './attention.ts';
import type { Actor } from './control-plane.ts';
import { sourceConnectorById, type ConnectorDescriptor } from './source-connectors/registry.ts';
import type { SqlDatabase } from './sql.ts';
import { stableHash } from './workflow.ts';
import type { ConnectorReleaseMode } from './source-lifecycle-status.ts';

export type ConnectorRolloutMode = ConnectorReleaseMode;

export type ConnectorReleaseControl = {
  id: string;
  connectorId: string;
  connectorVersion: string;
  rolloutMode: ConnectorRolloutMode;
  canaryEnabled: boolean;
  canaryPercent: number;
  canaryFailureRateBps: number;
  canaryMinRuns: number;
  canaryStartedAt: string | null;
  canaryStoppedAt: string | null;
  reason: string;
  version: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

type ControlRow = {
  id: string;
  connector_id: string;
  connector_version: string;
  rollout_mode: ConnectorRolloutMode;
  canary_enabled: number;
  canary_percent: number;
  canary_failure_rate_bps: number;
  canary_min_runs: number;
  canary_started_at: string | null;
  canary_stopped_at: string | null;
  reason: string;
  version: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
};

function toControl(row: ControlRow): ConnectorReleaseControl {
  return {
    id: row.id,
    connectorId: row.connector_id,
    connectorVersion: row.connector_version,
    rolloutMode: row.rollout_mode,
    canaryEnabled: Boolean(row.canary_enabled),
    canaryPercent: row.canary_percent,
    canaryFailureRateBps: row.canary_failure_rate_bps,
    canaryMinRuns: row.canary_min_runs,
    canaryStartedAt: row.canary_started_at,
    canaryStoppedAt: row.canary_stopped_at,
    reason: row.reason,
    version: row.version,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getConnectorReleaseControl(
  db: SqlDatabase,
  connectorId: string,
  connectorVersion: string,
) {
  const row = await db
    .prepare(`
    SELECT id, connector_id, connector_version, rollout_mode,
      canary_enabled, canary_percent, canary_failure_rate_bps, canary_min_runs,
      canary_started_at, canary_stopped_at, reason, version,
      updated_by, created_at, updated_at
    FROM source_connector_releases
    WHERE connector_id = ? AND connector_version = ?
    LIMIT 1
  `)
    .bind(connectorId, connectorVersion)
    .first<ControlRow>();
  return row ? toControl(row) : null;
}

export async function setConnectorReleaseControl(
  db: SqlDatabase,
  input: {
    connector: ConnectorDescriptor;
    rolloutMode: ConnectorRolloutMode;
    expectedVersion: number;
    reason: string;
    actor: Actor;
    canary?: {
      enabled: boolean;
      percent: number;
      failureRateBps: number;
      minRuns: number;
    };
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const current = await tx
      .prepare(`
      SELECT id, connector_id, connector_version, rollout_mode,
        canary_enabled, canary_percent, canary_failure_rate_bps, canary_min_runs,
        canary_started_at, canary_stopped_at, reason, version,
        updated_by, created_at, updated_at
      FROM source_connector_releases
      WHERE connector_id = ? AND connector_version = ?
      FOR UPDATE
    `)
      .bind(input.connector.id, input.connector.version)
      .first<ControlRow>();
    if (!current)
      return { status: 404 as const, error: '连接器发布控制记录不存在。' };
    if (current.version !== input.expectedVersion) {
      return {
        status: 409 as const,
        error: `版本冲突：当前版本为 ${current.version}。`,
      };
    }
    const requestedCanary = input.canary ?? {
      enabled: Boolean(current.canary_enabled),
      percent: current.canary_percent,
      failureRateBps: current.canary_failure_rate_bps,
      minRuns: current.canary_min_runs,
    };
    if (
      typeof requestedCanary.enabled !== 'boolean' ||
      !Number.isInteger(requestedCanary.percent) || requestedCanary.percent < 1 || requestedCanary.percent > 100 ||
      !Number.isInteger(requestedCanary.failureRateBps) || requestedCanary.failureRateBps < 1 || requestedCanary.failureRateBps > 10_000 ||
      !Number.isInteger(requestedCanary.minRuns) || requestedCanary.minRuns < 1 || requestedCanary.minRuns > 10_000
    ) return { status: 422 as const, error: 'Canary 配置超出允许范围。' };
    const canaryEnabled = input.rolloutMode === 'enabled' && requestedCanary.enabled;
    const canaryChanged =
      canaryEnabled !== Boolean(current.canary_enabled) ||
      requestedCanary.percent !== current.canary_percent ||
      requestedCanary.failureRateBps !== current.canary_failure_rate_bps ||
      requestedCanary.minRuns !== current.canary_min_runs;
    const canaryStartedAt = canaryEnabled
      ? (canaryChanged ? timestamp : current.canary_started_at ?? timestamp)
      : current.canary_started_at;
    const canaryStoppedAt = canaryEnabled
      ? null
      : current.canary_enabled
        ? timestamp
        : current.canary_stopped_at;
    const nextVersion = current.version + 1;
    const updated = await tx
      .prepare(`
      UPDATE source_connector_releases
      SET rollout_mode = ?, canary_enabled = ?, canary_percent = ?,
        canary_failure_rate_bps = ?, canary_min_runs = ?, canary_started_at = ?,
        canary_stopped_at = ?, reason = ?, version = version + 1,
        updated_by = ?, updated_at = ?
      WHERE id = ? AND version = ?
    `)
      .bind(
        input.rolloutMode,
        canaryEnabled ? 1 : 0,
        requestedCanary.percent,
        requestedCanary.failureRateBps,
        requestedCanary.minRuns,
        canaryStartedAt,
        canaryStoppedAt,
        input.reason.slice(0, 500),
        input.actor.id,
        timestamp,
        current.id,
        current.version,
      )
      .run();
    if (!updated.meta.changes)
      return {
        status: 409 as const,
        error: '连接器发布控制已被其他管理员修改。',
      };

    let cancelledJobs = 0;
    let cancelledRuns = 0;
    if (canaryEnabled && canaryChanged) {
      const cancellationReason =
        'Canary 配置已变更；未领取运行已取消，必须按新的稳定来源分桶重新调度。';
      cancelledJobs = (
        await tx
          .prepare(`
        UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          last_error = ?, updated_at = ?
        WHERE kind = 'ingestion' AND status IN ('queued', 'retrying')
          AND payload_json ->> 'connectorId' = ?
          AND payload_json ->> 'connectorVersion' = ?
      `)
          .bind(
            cancellationReason,
            timestamp,
            input.connector.id,
            input.connector.version,
          )
          .run()
      ).meta.changes;
      cancelledRuns = (
        await tx
          .prepare(`
        UPDATE ingestion_runs SET status = 'cancelled', quarantine_status = 'held',
          error_code = 'CONNECTOR_ROLLOUT_CHANGED', retryable = 0,
          error_json = ?, finished_at = ?
        WHERE connector_id = ? AND connector_version = ? AND status = 'queued'
      `)
          .bind(
            JSON.stringify({
              code: 'CONNECTOR_ROLLOUT_CHANGED',
              message: cancellationReason,
            }),
            timestamp,
            input.connector.id,
            input.connector.version,
          )
          .run()
      ).meta.changes;
      await tx
        .prepare(`
        UPDATE source_configs SET active_run_id = NULL, updated_at = ?
        WHERE platform = ? AND lifecycle_status <> 'archived'
          AND EXISTS (
            SELECT 1 FROM ingestion_runs cancelled_run
            WHERE cancelled_run.id = source_configs.active_run_id
              AND cancelled_run.status = 'cancelled'
              AND cancelled_run.connector_id = ?
              AND cancelled_run.connector_version = ?
          )
      `)
        .bind(
          timestamp,
          input.connector.platform,
          input.connector.id,
          input.connector.version,
        )
        .run();
    }
    if (input.rolloutMode === 'disabled') {
      cancelledJobs = (
        await tx
          .prepare(`
        UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          last_error = '连接器版本已被 kill switch 停用。', updated_at = ?
        WHERE kind = 'ingestion' AND status IN ('queued', 'retrying')
          AND payload_json ->> 'connectorId' = ?
          AND payload_json ->> 'connectorVersion' = ?
      `)
          .bind(timestamp, input.connector.id, input.connector.version)
          .run()
      ).meta.changes;
      cancelledRuns = (
        await tx
          .prepare(`
        UPDATE ingestion_runs SET status = 'cancelled', quarantine_status = 'held',
          error_code = 'CONNECTOR_DISABLED', retryable = 0,
          error_json = ?, finished_at = ?
        WHERE connector_id = ? AND connector_version = ? AND status = 'queued'
      `)
          .bind(
            JSON.stringify({
              code: 'CONNECTOR_DISABLED',
              message: input.reason.slice(0, 500),
            }),
            timestamp,
            input.connector.id,
            input.connector.version,
          )
          .run()
      ).meta.changes;
      await tx
        .prepare(`
        UPDATE source_configs SET enabled = 0, lifecycle_status = 'paused',
          health_status = 'paused', next_run_at = NULL,
          active_run_id = CASE WHEN EXISTS (
            SELECT 1 FROM ingestion_runs WHERE id = source_configs.active_run_id AND status = 'cancelled'
          ) THEN NULL ELSE active_run_id END,
          last_error = ?, last_error_code = 'CONNECTOR_DISABLED',
          last_error_detail_redacted = ?, version = version + 1, updated_at = ?
        WHERE platform = ? AND lifecycle_status <> 'archived'
      `)
        .bind(
          input.reason.slice(0, 500) || '连接器版本已停用。',
          '连接器版本 kill switch 已生效；恢复后需重新测试并启用来源。',
          timestamp,
          input.connector.platform,
        )
        .run();
      await raiseAttentionItem(
        tx,
        {
          kind: 'source_connector',
          severity: 'critical',
          dedupeKey: `source_connector:${input.connector.id}:${input.connector.version}`,
          reason: `连接器 ${input.connector.id}@${input.connector.version} 已停用：${input.reason || '未填写原因'}`,
          detail: {
            connectorId: input.connector.id,
            connectorVersion: input.connector.version,
            cancelledJobs,
            cancelledRuns,
          },
        },
        now,
      );
    }
    await tx
      .prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source_connector.rollout_changed', 'source_connector_release',
        ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        `audit_${crypto.randomUUID()}`,
        input.actor.id,
        input.actor.role,
        current.id,
        stableHash({
          rolloutMode: current.rollout_mode,
          version: current.version,
        }),
        stableHash({
          rolloutMode: input.rolloutMode,
          canaryEnabled,
          canaryPercent: requestedCanary.percent,
          canaryFailureRateBps: requestedCanary.failureRateBps,
          canaryMinRuns: requestedCanary.minRuns,
          version: nextVersion,
        }),
        JSON.stringify({
          connectorId: input.connector.id,
          connectorVersion: input.connector.version,
          rolloutMode: input.rolloutMode,
          canaryEnabled,
          canaryPercent: requestedCanary.percent,
          canaryFailureRateBps: requestedCanary.failureRateBps,
          canaryMinRuns: requestedCanary.minRuns,
          reason: input.reason.slice(0, 500),
          cancelledJobs,
          cancelledRuns,
        }),
        crypto.randomUUID(),
        timestamp,
      )
      .run();
    return {
      status: 200 as const,
      control: toControl({
        ...current,
        rollout_mode: input.rolloutMode,
        canary_enabled: canaryEnabled ? 1 : 0,
        canary_percent: requestedCanary.percent,
        canary_failure_rate_bps: requestedCanary.failureRateBps,
        canary_min_runs: requestedCanary.minRuns,
        canary_started_at: canaryStartedAt,
        canary_stopped_at: canaryStoppedAt,
        reason: input.reason.slice(0, 500),
        version: nextVersion,
        updated_by: input.actor.id,
        updated_at: timestamp,
      }),
      cancelledJobs,
      cancelledRuns,
    };
  });
}

export function connectorCanaryBucket(
  sourceConfigId: string,
  connectorId: string,
  connectorVersion: string,
) {
  const hash = stableHash({ sourceConfigId, connectorId, connectorVersion });
  return Number.parseInt(hash.slice('sha256:'.length, 'sha256:'.length + 8), 16) % 100;
}

export function effectiveConnectorRollout(
  control: Pick<ConnectorReleaseControl, 'rolloutMode' | 'canaryEnabled' | 'canaryPercent' | 'connectorId' | 'connectorVersion'>,
  sourceConfigId: string,
) {
  if (control.rolloutMode !== 'enabled') {
    return { mode: control.rolloutMode, canarySelected: false, canaryBucket: null } as const;
  }
  if (!control.canaryEnabled) {
    return { mode: 'enabled', canarySelected: false, canaryBucket: null } as const;
  }
  const canaryBucket = connectorCanaryBucket(sourceConfigId, control.connectorId, control.connectorVersion);
  const canarySelected = canaryBucket < control.canaryPercent;
  return {
    mode: canarySelected ? 'enabled' : 'shadow',
    canarySelected,
    canaryBucket,
  } as const;
}

export async function evaluateConnectorCanaries(
  db: SqlDatabase,
  actor: Actor,
  now = new Date(),
) {
  const controls = await db.prepare(`
    SELECT id, connector_id, connector_version, rollout_mode,
      canary_enabled, canary_percent, canary_failure_rate_bps, canary_min_runs,
      canary_started_at, canary_stopped_at, reason, version,
      updated_by, created_at, updated_at
    FROM source_connector_releases
    WHERE rollout_mode = 'enabled' AND canary_enabled = 1 AND canary_started_at IS NOT NULL
    ORDER BY connector_id, connector_version
  `).all<ControlRow>();
  const evaluated: Array<{
    connectorId: string; connectorVersion: string; total: number;
    failed: number; failureRateBps: number; stopped: boolean;
  }> = [];
  for (const row of controls.results) {
    const counts = await db.prepare(`
      SELECT COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status IN ('partial','failed','rights_blocked')) AS failed
      FROM ingestion_runs
      WHERE connector_id = ? AND connector_version = ? AND shadow = 0
        AND created_at >= ?
        AND status IN ('succeeded','partial','failed','rights_blocked')
    `).bind(row.connector_id, row.connector_version, row.canary_started_at).first<{ total: number | string; failed: number | string }>();
    const total = Number(counts?.total ?? 0);
    const failed = Number(counts?.failed ?? 0);
    const failureRateBps = total ? Math.floor((failed * 10_000) / total) : 0;
    let stopped = false;
    if (total >= row.canary_min_runs && failureRateBps >= row.canary_failure_rate_bps) {
      const connector = sourceConnectorById(row.connector_id, row.connector_version);
      if (connector) {
        const result = await setConnectorReleaseControl(
          db,
          {
            connector,
            rolloutMode: 'disabled',
            expectedVersion: row.version,
            reason: `Canary 自动停止：${failed}/${total} 个运行失败（${failureRateBps} bps），阈值 ${row.canary_failure_rate_bps} bps。`,
            actor,
            canary: {
              enabled: false,
              percent: row.canary_percent,
              failureRateBps: row.canary_failure_rate_bps,
              minRuns: row.canary_min_runs,
            },
          },
          now,
        );
        stopped = !('error' in result);
      }
    }
    evaluated.push({ connectorId: row.connector_id, connectorVersion: row.connector_version, total, failed, failureRateBps, stopped });
  }
  return { evaluated, stopped: evaluated.filter((item) => item.stopped).length };
}

export async function quarantineConnectorDisabledIngestion(
  tx: SqlDatabase,
  input: {
    sourceConfigId: string;
    ingestionRunId: string;
    connectorId: string;
    connectorVersion: string;
    reason: string;
  },
  now: Date,
) {
  const timestamp = now.toISOString();
  await tx
    .prepare(`
    UPDATE ingestion_runs SET status = 'failed', quarantine_status = 'held',
      error_code = 'CONNECTOR_DISABLED', retryable = 0, retry_after = NULL,
      error_json = ?, started_at = COALESCE(started_at, ?), finished_at = ?
    WHERE id = ?
  `)
    .bind(
      JSON.stringify({ code: 'CONNECTOR_DISABLED', message: input.reason }),
      timestamp,
      timestamp,
      input.ingestionRunId,
    )
    .run();
  await tx
    .prepare(`
    UPDATE source_configs SET enabled = 0, lifecycle_status = 'paused',
      health_status = 'paused', next_run_at = NULL,
      active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
      last_error = ?, last_error_code = 'CONNECTOR_DISABLED',
      last_error_detail_redacted = ?, updated_at = ?
    WHERE id = ?
  `)
    .bind(
      input.ingestionRunId,
      input.reason,
      input.reason.slice(0, 500),
      timestamp,
      input.sourceConfigId,
    )
    .run();
  await tx
    .prepare(`
    UPDATE raw_payload_uploads
    SET state = 'expired', expires_at = ?, delete_after = ?, updated_at = ?
    WHERE source_config_id = ? AND ingestion_run_id = ?
      AND state IN ('initiated', 'uploaded', 'aborted')
  `)
    .bind(
      timestamp,
      timestamp,
      timestamp,
      input.sourceConfigId,
      input.ingestionRunId,
    )
    .run();
  await raiseAttentionItem(
    tx,
    {
      kind: 'source_connector',
      severity: 'critical',
      sourceConfigId: input.sourceConfigId,
      dedupeKey: `source_connector:${input.connectorId}:${input.connectorVersion}`,
      reason: `连接器版本在提交前被停用，采集结果已隔离：${input.reason}`,
      detail: {
        sourceConfigId: input.sourceConfigId,
        ingestionRunId: input.ingestionRunId,
        connectorId: input.connectorId,
        connectorVersion: input.connectorVersion,
      },
    },
    now,
  );
}

/**
 * 发布范围变更后的旧正式运行只能隔离，不能把来源本身停用；下一次调度会按
 * 当前 canary 分桶重新决定正式或 shadow。
 */
export async function quarantineConnectorRolloutChangedIngestion(
  tx: SqlDatabase,
  input: {
    sourceConfigId: string;
    ingestionRunId: string;
    reason: string;
  },
  now: Date,
) {
  const timestamp = now.toISOString();
  await tx
    .prepare(`
    UPDATE ingestion_runs SET status = 'failed', quarantine_status = 'held',
      error_code = 'CONNECTOR_ROLLOUT_CHANGED', retryable = 0, retry_after = NULL,
      error_json = ?, started_at = COALESCE(started_at, ?), finished_at = ?
    WHERE id = ?
  `)
    .bind(
      JSON.stringify({ code: 'CONNECTOR_ROLLOUT_CHANGED', message: input.reason }),
      timestamp,
      timestamp,
      input.ingestionRunId,
    )
    .run();
  await tx
    .prepare(`
    UPDATE source_configs SET
      active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
      updated_at = ?
    WHERE id = ?
  `)
    .bind(input.ingestionRunId, timestamp, input.sourceConfigId)
    .run();
  await tx
    .prepare(`
    UPDATE raw_payload_uploads
    SET state = 'expired', expires_at = ?, delete_after = ?, updated_at = ?
    WHERE source_config_id = ? AND ingestion_run_id = ?
      AND state IN ('initiated', 'uploaded', 'aborted')
  `)
    .bind(
      timestamp,
      timestamp,
      timestamp,
      input.sourceConfigId,
      input.ingestionRunId,
    )
    .run();
}

/** Shadow 运行只保存有界统计，不写文章、origin、checkpoint、健康或通知。 */
export async function commitShadowIngestion(
  tx: SqlDatabase,
  input: {
    sourceConfigId: string;
    ingestionRunId: string;
    connectorId: string;
    connectorVersion: string;
    fetchedCount: number;
    rejectedCount: number;
    requestCount: number;
    byteCount: number;
    costMicrosPerRequest: number;
  },
  now: Date,
) {
  const timestamp = now.toISOString();
  const result = {
    shadow: true as const,
    fetchedCount: input.fetchedCount,
    acceptedCount: 0,
    rejectedCount: input.rejectedCount,
    duplicateCount: 0,
    requestCount: input.requestCount,
    byteCount: input.byteCount,
    connectorId: input.connectorId,
    connectorVersion: input.connectorVersion,
  };
  await tx
    .prepare(`
    UPDATE raw_payload_uploads
    SET state = 'expired', expires_at = ?, delete_after = ?, updated_at = ?
    WHERE source_config_id = ? AND ingestion_run_id = ?
      AND state IN ('initiated', 'uploaded', 'aborted')
  `)
    .bind(
      timestamp,
      timestamp,
      timestamp,
      input.sourceConfigId,
      input.ingestionRunId,
    )
    .run();
  await tx
    .prepare(`
    UPDATE ingestion_runs SET status = 'succeeded', shadow = 1,
      fetched_count = ?, accepted_count = 0, rejected_count = ?, duplicate_count = 0,
      request_count = ?, byte_count = ?, cost_micros = ?, result_json = ?, finished_at = ?
    WHERE id = ?
  `)
    .bind(
      result.fetchedCount,
      result.rejectedCount,
      result.requestCount,
      result.byteCount,
      result.requestCount * input.costMicrosPerRequest,
      JSON.stringify(result),
      timestamp,
      input.ingestionRunId,
    )
    .run();
  await tx
    .prepare(`
    UPDATE source_configs
    SET active_run_id = CASE WHEN active_run_id = ? THEN NULL ELSE active_run_id END,
      updated_at = ?
    WHERE id = ?
  `)
    .bind(input.ingestionRunId, timestamp, input.sourceConfigId)
    .run();
  return result;
}
