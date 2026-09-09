import { config, db } from '@/lib/runtime';
import { asSourceApiErrorCode, sourceApiError } from '@/lib/source-api-error';
import { authorizeWorker } from '@/lib/worker-auth';
import { stableHash, sha256Hex } from '@/lib/hash';
import {
  commitRawPayloadUpload,
  RawPayloadUploadError,
  requireRawPayloadUploadForCommit,
} from '@/lib/source-raw-payloads';
import {
  ingestionRightsBlockReason,
  quarantineRightsBlockedIngestion,
} from '@/lib/source-rights';
import { quarantineCredentialBlockedIngestion } from '@/lib/source-credentials';
import {
  effectiveConnectorRollout,
  quarantineConnectorDisabledIngestion,
  quarantineConnectorRolloutChangedIngestion,
} from '@/lib/source-release-control';
import {
  type CommittedPageManifestRow,
  validateCompletionManifest,
} from '@/lib/source-page-protocol';
import {
  materializeIngestionPayload,
  parseStagedIngestionPayload,
} from '@/lib/source-ingestion-materialization';
import {
  fetchOutcomeFromCheckpoint,
  hasNotModifiedPayloadConflict,
} from '@/lib/source-fetch-outcome';

type CompleteBody = {
  jobId?: string;
  workerId?: string;
  leaseEpoch?: number;
  pageCount?: number;
  lastPageKey?: string;
  fetchedCount?: number;
  acceptedCount?: number;
  rejectedCount?: number;
  duplicateCount?: number;
  requestCount?: number;
  byteCount?: number;
  rawObjectKey?: string | null;
};

type LockedRun = {
  id: string;
  source_config_id: string;
  status: string;
  job_id: string;
  result_json: unknown;
  source_version: number;
  rights_grant_id: string | null;
  credential_ref: string | null;
  credential_version: number;
  connector_id: string;
  connector_version: string;
  cost_micros_per_request: number;
  checkpoint_scope: 'live' | 'backfill';
  checkpoint_before_json: unknown;
  checkpoint_after_json: unknown;
  job_status: string;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  current_source_version: number;
  current_checkpoint_json: unknown;
  current_backfill_checkpoint_json: unknown;
  current_checkpoint_version: number;
  current_backfill_checkpoint_version: number;
  active_run_id: string | null;
  platform: string;
  publisher_entity_id: string | null;
  source_enabled: number;
  source_lifecycle_status: string;
  source_rights_status: string;
  source_retention_mode: string;
  source_config_hash: string;
  current_credential_ref: string | null;
  current_credential_version: number;
  credential_status: string | null;
  credential_revoked_at: string | null;
  credential_expires_at: string | null;
  grant_id: string | null;
  grant_revoked_at: string | null;
  grant_expires_at: string | null;
  grant_purpose: string | null;
  grant_usage_scope: string | null;
  grant_permitted_fields_json: unknown;
  grant_source_version: number | null;
  grant_config_hash: string | null;
  connector_rollout_mode: 'disabled' | 'shadow' | 'enabled' | null;
  connector_canary_enabled: number | null;
  connector_canary_percent: number | null;
  connector_rollout_reason: string | null;
};

function validCount(value: unknown, max: number) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= max;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await authorizeWorker(request, config.sourceWorkerToken))) {
    return sourceApiError('Worker 未授权。', 401);
  }
  let body: CompleteBody;
  try {
    body = (await request.json()) as CompleteBody;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (
    !body.jobId ||
    !body.workerId ||
    !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1 ||
    !Number.isInteger(body.pageCount) || Number(body.pageCount) < 1 || Number(body.pageCount) > 10_000 ||
    !/^[A-Za-z0-9._:-]{1,160}$/.test(body.lastPageKey ?? '') ||
    !validCount(body.fetchedCount, 1_000_000) ||
    !validCount(body.acceptedCount, 1_000_000) ||
    !validCount(body.rejectedCount, 1_000_000) ||
    !validCount(body.duplicateCount, 1_000_000) ||
    !validCount(body.requestCount, 100_000) ||
    !validCount(body.byteCount, 1_000_000_000)
  ) {
    return sourceApiError('jobId、workerId、leaseEpoch、页面终点和累计计数不完整或无效。', 422);
  }

  const { id } = await context.params;
  const now = new Date();
  try {
    const result = await db.transaction(async (tx) => {
      const run = await tx.prepare(`
        SELECT ir.id, ir.source_config_id, ir.status, ir.job_id, ir.result_json,
          ir.source_version, ir.rights_grant_id, ir.credential_ref, ir.credential_version,
          ir.connector_id, ir.connector_version, ir.cost_micros_per_request, ir.checkpoint_scope,
          ir.checkpoint_before_json, ir.checkpoint_after_json,
          j.status AS job_status, j.lease_owner, j.lease_epoch, j.lease_expires_at,
          sc.version AS current_source_version, sc.checkpoint_json AS current_checkpoint_json,
          sc.backfill_checkpoint_json AS current_backfill_checkpoint_json,
          sc.checkpoint_version AS current_checkpoint_version,
          sc.backfill_checkpoint_version AS current_backfill_checkpoint_version,
          sc.platform, sc.publisher_entity_id,
          sc.active_run_id, sc.enabled AS source_enabled,
          sc.lifecycle_status AS source_lifecycle_status, sc.rights_status AS source_rights_status,
          sc.retention_mode AS source_retention_mode,
          COALESCE(NULLIF(sc.rights_config_hash, ''), sc.config_hash) AS source_config_hash,
          sc.credential_ref AS current_credential_ref,
          sc.credential_version AS current_credential_version,
          credential_row.status AS credential_status,
          credential_row.revoked_at AS credential_revoked_at,
          credential_row.expires_at AS credential_expires_at,
          grant_row.id AS grant_id, grant_row.revoked_at AS grant_revoked_at,
          grant_row.expires_at AS grant_expires_at, grant_row.purpose AS grant_purpose,
          grant_row.usage_scope AS grant_usage_scope,
          grant_row.permitted_fields_json AS grant_permitted_fields_json,
          grant_row.source_version AS grant_source_version,
          grant_row.config_hash AS grant_config_hash,
          release_control.rollout_mode AS connector_rollout_mode,
          release_control.canary_enabled AS connector_canary_enabled,
          release_control.canary_percent AS connector_canary_percent,
          release_control.reason AS connector_rollout_reason
        FROM ingestion_runs ir
        JOIN jobs j ON j.id = ir.job_id
        JOIN source_configs sc ON sc.id = ir.source_config_id
        LEFT JOIN source_rights_grants grant_row ON grant_row.id = ir.rights_grant_id
        LEFT JOIN source_credentials credential_row ON credential_row.id = ir.credential_ref
        LEFT JOIN source_connector_releases release_control
          ON release_control.connector_id = ir.connector_id
          AND release_control.connector_version = ir.connector_version
        WHERE ir.id = ?
        FOR UPDATE OF ir, j, sc
      `).bind(id).first<LockedRun>();
      if (!run) return { error: '采集运行不存在。', status: 404 as const };
      if (run.job_id !== body.jobId) return { error: '采集运行与作业不匹配。', status: 409 as const };
      if (['succeeded', 'partial'].includes(run.status) && run.result_json && typeof run.result_json === 'object') {
        return { replay: run.result_json, status: 200 as const };
      }
      if (
        run.job_status !== 'leased' ||
        run.lease_owner !== body.workerId ||
        run.lease_epoch !== body.leaseEpoch ||
        !run.lease_expires_at || run.lease_expires_at <= now.toISOString()
      ) {
        return { error: '采集运行与当前 Worker 租约或 leaseEpoch 不匹配。', status: 409 as const };
      }
      if (run.status !== 'running' || run.active_run_id !== id) {
        return { error: '采集运行不是当前活动运行。', status: 409 as const };
      }
      if (!run.connector_rollout_mode || run.connector_rollout_mode === 'disabled') {
        const reason = run.connector_rollout_reason || `连接器 ${run.connector_id}@${run.connector_version} 当前未启用。`;
        await quarantineConnectorDisabledIngestion(tx, {
          sourceConfigId: run.source_config_id,
          ingestionRunId: id,
          connectorId: run.connector_id,
          connectorVersion: run.connector_version,
          reason,
        }, now);
        return { error: reason, errorCode: 'CONNECTOR_DISABLED', status: 409 as const };
      }
      const effectiveRollout = effectiveConnectorRollout(
        {
          connectorId: run.connector_id,
          connectorVersion: run.connector_version,
          rolloutMode: run.connector_rollout_mode,
          canaryEnabled: Boolean(run.connector_canary_enabled),
          canaryPercent: Number(run.connector_canary_percent ?? 10),
        },
        run.source_config_id,
      );
      if (effectiveRollout.mode !== 'enabled') {
        const reason =
          '连接器发布范围已变更；该来源当前不在正式写入范围，本次旧运行已隔离。';
        await quarantineConnectorRolloutChangedIngestion(tx, {
          sourceConfigId: run.source_config_id,
          ingestionRunId: id,
          reason,
        }, now);
        return {
          error: reason,
          errorCode: 'CONNECTOR_ROLLOUT_CHANGED',
          status: 409 as const,
        };
      }
      const credentialBlocked =
        run.credential_ref !== run.current_credential_ref ||
        run.credential_version !== run.current_credential_version ||
        (Boolean(run.credential_ref) && (
          run.credential_status !== 'active' || Boolean(run.credential_revoked_at) ||
          Boolean(run.credential_expires_at && run.credential_expires_at <= now.toISOString())
        ));
      if (credentialBlocked) {
        const reason = '来源凭据已在逐页采集期间轮换、撤销或过期，本次运行已隔离。';
        await quarantineCredentialBlockedIngestion(tx, {
          sourceConfigId: run.source_config_id,
          ingestionRunId: id,
          credentialRef: run.credential_ref,
          credentialVersion: run.credential_version,
          reason,
        }, now);
        return { error: reason, errorCode: 'AUTH_REQUIRED', status: 409 as const };
      }
      const rightsBlockedReason = ingestionRightsBlockReason({
        sourceEnabled: run.source_enabled,
        sourceLifecycleStatus: run.source_lifecycle_status,
        sourceRightsStatus: run.source_rights_status,
        sourceRetentionMode: run.source_retention_mode,
        sourceConfigHash: run.source_config_hash,
        runSourceVersion: run.source_version,
        runRightsGrantId: run.rights_grant_id,
        grantId: run.grant_id,
        grantRevokedAt: run.grant_revoked_at,
        grantExpiresAt: run.grant_expires_at,
        grantPurpose: run.grant_purpose,
        grantUsageScope: run.grant_usage_scope,
        grantPermittedFields: run.grant_permitted_fields_json,
        grantSourceVersion: run.grant_source_version,
        grantConfigHash: run.grant_config_hash,
      }, {
        now,
        requiredFields: new Set(['title', 'url', 'publishedAt']),
        hasRawPayload: Boolean(body.rawObjectKey),
      });
      if (rightsBlockedReason) {
        await quarantineRightsBlockedIngestion(tx, {
          sourceConfigId: run.source_config_id,
          ingestionRunId: id,
          rightsGrantId: run.rights_grant_id,
          reason: rightsBlockedReason,
        }, now);
        return { error: rightsBlockedReason, errorCode: 'RIGHTS_BLOCKED', status: 409 as const };
      }
      if (run.current_source_version !== run.source_version) {
        return { error: '来源配置已在逐页采集期间变更。', status: 409 as const };
      }

      const pages = (await tx.prepare(`
        SELECT page_key, page_ordinal, content_hash, lease_epoch, final_page, status,
          checkpoint_after_json, fetched_count, accepted_count, rejected_count,
          duplicate_count, request_count, byte_count, staged_payload_json
        FROM ingestion_pages
        WHERE ingestion_run_id = ?
        ORDER BY page_ordinal ASC
        FOR UPDATE
      `).bind(id).all<CommittedPageManifestRow & { staged_payload_json: unknown }>()).results;
      const manifest = validateCompletionManifest(pages, {
        pageCount: Number(body.pageCount),
        lastPageKey: String(body.lastPageKey),
        totals: {
          fetchedCount: Number(body.fetchedCount),
          acceptedCount: Number(body.acceptedCount),
          rejectedCount: Number(body.rejectedCount),
          duplicateCount: Number(body.duplicateCount),
          requestCount: Number(body.requestCount),
          byteCount: Number(body.byteCount),
        },
      });
      if ('error' in manifest) return { error: manifest.error, status: 409 as const };
      const { lastPage, totals } = manifest;
      const currentCheckpointJson = run.checkpoint_scope === 'backfill'
        ? run.current_backfill_checkpoint_json
        : run.current_checkpoint_json;
      if (stableHash(run.checkpoint_after_json ?? {}) !== stableHash(lastPage.checkpoint_after_json ?? {})) {
        return { error: '运行内部 checkpoint 与最后提交页不一致。', status: 409 as const };
      }
      if (stableHash(currentCheckpointJson ?? {}) !== stableHash(run.checkpoint_before_json ?? {})) {
        return { error: '来源 checkpoint 已在运行期间变化。', status: 409 as const };
      }

      let rawUploadId: string | null = null;
      if (run.source_retention_mode === 'raw' && totals.byteCount > 0) {
        if (!body.rawObjectKey || !body.rawObjectKey.startsWith(`sources/${run.source_config_id}/raw/${id}/`)) {
          return { error: 'raw 保留模式需要与该运行匹配的原始载荷 manifest。', status: 422 as const };
        }
        const upload = await requireRawPayloadUploadForCommit(tx, {
          sourceConfigId: run.source_config_id,
          ingestionRunId: id,
          objectKey: body.rawObjectKey,
        }, now);
        rawUploadId = upload.id;
      } else if (body.rawObjectKey) {
        return { error: 'metadata 保留模式不能提交原始载荷。', status: 422 as const };
      }

      const finishedAt = now.toISOString();
      const status = totals.rejectedCount > 0 ? 'partial' : 'succeeded';
      const fetchOutcome = fetchOutcomeFromCheckpoint(
        lastPage.checkpoint_after_json,
      );
      if (hasNotModifiedPayloadConflict(fetchOutcome, totals)) {
        return {
          error: '304 未修改运行的页面清单不能包含内容、拒绝项或响应字节。',
          status: 409 as const,
        };
      }
      const pipelineJobId = `job_pipeline_${sha256Hex(id).slice(0, 32)}`;
      const checkpointJson = lastPage.checkpoint_after_json ?? {};
      const checkpoint = checkpointJson && typeof checkpointJson === 'object' && !Array.isArray(checkpointJson) && typeof (checkpointJson as Record<string, unknown>).watermark === 'string'
        ? String((checkpointJson as Record<string, unknown>).watermark)
        : null;
      const response = {
        protocol: 'page-v1-complete',
        ingestionRunId: id,
        status,
        fetchOutcome,
        pageCount: pages.length,
        lastPageKey: lastPage.page_key,
        ...totals,
        checkpoint,
        checkpointJson,
        checkpointScope: run.checkpoint_scope,
        pipelineJobId,
        leaseEpoch: body.leaseEpoch,
      };
      let changedCount = 0;
      for (const page of pages) {
        const payload = parseStagedIngestionPayload(page.staged_payload_json);
        if (!payload) throw new Error(`页面 ${page.page_key} 缺少可验证的 staged payload。`);
        const materialized = await materializeIngestionPayload(tx, {
          sourceConfigId: run.source_config_id,
          ingestionRunId: id,
          platform: run.platform,
          publisherEntityId: run.publisher_entity_id,
          payload,
          observedAt: now,
        });
        changedCount += materialized.changedCount;
      }
      const sourceCheckpointUpdate = run.checkpoint_scope === 'backfill'
        ? tx.prepare(`
            UPDATE source_configs SET backfill_checkpoint_json = ?,
              backfill_checkpoint_version = backfill_checkpoint_version + 1,
              active_run_id = NULL, last_success_at = ?, last_healthy_at = ?,
              health_status = 'healthy', consecutive_failures = 0, last_error = NULL,
              last_error_code = NULL, retry_after = NULL, backoff_until = NULL, updated_at = ?
            WHERE id = ? AND version = ? AND backfill_checkpoint_version = ? AND active_run_id = ?
          `).bind(
            JSON.stringify(checkpointJson), finishedAt, finishedAt, finishedAt,
            run.source_config_id, run.source_version, run.current_backfill_checkpoint_version, id,
          )
        : tx.prepare(`
            UPDATE source_configs SET checkpoint = ?, checkpoint_json = ?,
              checkpoint_version = checkpoint_version + 1, active_run_id = NULL,
              last_success_at = ?, last_healthy_at = ?, health_status = 'healthy',
              consecutive_failures = 0, last_error = NULL, last_error_code = NULL,
              retry_after = NULL, backoff_until = NULL, updated_at = ?
            WHERE id = ? AND version = ? AND checkpoint_version = ? AND active_run_id = ?
          `).bind(
            checkpoint, JSON.stringify(checkpointJson), finishedAt, finishedAt, finishedAt,
            run.source_config_id, run.source_version, run.current_checkpoint_version, id,
          );
      const sourceUpdated = await sourceCheckpointUpdate.run();
      if (!sourceUpdated.meta.changes) throw new Error('来源活动运行已变化，本次终结已回滚。');
      await tx.prepare(`
        UPDATE ingestion_runs SET status = ?, fetch_outcome = ?, checkpoint_after = ?, checkpoint_after_json = ?,
          fetched_count = ?, accepted_count = ?, rejected_count = ?, duplicate_count = ?,
          request_count = ?, byte_count = ?, cost_micros = ?, result_json = ?, finished_at = ?
        WHERE id = ?
      `).bind(
        status,
        fetchOutcome,
        checkpoint,
        JSON.stringify(checkpointJson),
        totals.fetchedCount,
        totals.acceptedCount,
        totals.rejectedCount,
        totals.duplicateCount,
        totals.requestCount,
        totals.byteCount,
        totals.requestCount * run.cost_micros_per_request,
        JSON.stringify(response),
        finishedAt,
        id,
      ).run();
      if (rawUploadId) {
        await commitRawPayloadUpload(tx, rawUploadId, now);
        await tx.prepare(`
          UPDATE article_revisions SET raw_object_key = ?
          WHERE raw_object_key IS NULL AND id IN (
            SELECT article_revision_id FROM source_item_origins
            WHERE ingestion_run_id = ? AND article_revision_id IS NOT NULL
          )
        `).bind(body.rawObjectKey, id).run();
      }
      if (changedCount > 0) await tx.prepare(`
        INSERT INTO jobs
          (id, kind, required_capability, payload_schema_version, payload_json,
           status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
        VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
        ON CONFLICT (kind, idempotency_key) DO NOTHING
      `).bind(
        pipelineJobId,
        JSON.stringify({
          schemaVersion: 2,
          operation: 'topic_recompute',
          derivationKey: `ingestion:${id}`,
          sourceIngestionRunId: id,
          rollingWindowHours: 72,
        }),
        `topic-recompute:${id}`,
        finishedAt,
        finishedAt,
        finishedAt,
      ).run();
      return { response, status: 200 as const };
    });
    if ('error' in result) {
      return sourceApiError(result.error ?? '采集运行终结失败。', result.status ?? 500, {
        errorCode: asSourceApiErrorCode('errorCode' in result ? result.errorCode : undefined),
      });
    }
    if ('replay' in result) return Response.json(result.replay, { status: result.status });
    return Response.json(result.response);
  } catch (error) {
    if (error instanceof RawPayloadUploadError) {
      return sourceApiError(error.message, error.status, { errorCode: 'STORAGE_ERROR' });
    }
    return sourceApiError(error instanceof Error ? error.message : '采集运行终结失败。', 503, {
      errorCode: 'STORAGE_ERROR', retryable: true,
    });
  }
}
