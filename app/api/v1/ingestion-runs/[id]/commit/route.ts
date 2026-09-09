import { config, db } from '@/lib/runtime';
import { asSourceApiErrorCode, sourceApiError } from '@/lib/source-api-error';
import {
  normalizeArticles,
  SOURCE_TYPES,
  validateArticleInput,
  type ArticleInput,
  type SourceType,
} from '@/lib/domain';
import { authorizeWorker } from '@/lib/worker-auth';
import { sha256Hex } from '@/lib/hash';
import {
  commitRawPayloadUpload,
  RawPayloadUploadError,
  requireRawPayloadUploadForCommit,
} from '@/lib/source-raw-payloads';
import {
  ingestionRightsBlockReason,
  quarantineRightsBlockedIngestion,
} from '@/lib/source-rights';
import {
  commitShadowIngestion,
  effectiveConnectorRollout,
  quarantineConnectorDisabledIngestion,
  quarantineConnectorRolloutChangedIngestion,
} from '@/lib/source-release-control';
import { quarantineCredentialBlockedIngestion } from '@/lib/source-credentials';
import { pageReplayDecision, validateNextCommittedPage } from '@/lib/source-page-protocol';
import {
  countExistingOriginDuplicates,
  materializeIngestionPayload,
  type StagedIngestionPayload,
} from '@/lib/source-ingestion-materialization';
import {
  normalizedUpsertToArticle,
  parseNormalizedSourceItems,
} from '@/lib/source-normalized-item';
import {
  fetchOutcomeFromNotModified,
  hasNotModifiedPayloadConflict,
} from '@/lib/source-fetch-outcome';

const MAX_ARTICLES = 1_000;
const MAX_BODY_BYTES = 10_000_000;

type CommitBody = {
  jobId?: string;
  workerId?: string;
  leaseEpoch?: number;
  articles?: unknown;
  items?: unknown;
  fetchedCount?: number;
  skippedCount?: number;
  checkpoint?: string | null;
  checkpointJson?: unknown;
  rawObjectKey?: string | null;
  requestCount?: number;
  byteCount?: number;
  notModified?: boolean;
  origins?: unknown;
  rejections?: unknown;
  /** 仅由 pages/{pageKey} 路由注入，旧的整运行 commit 不接受客户端自报。 */
  pageKey?: string;
  pageOrdinal?: number;
  pageContentHash?: string;
  finalPage?: boolean;
  checkpointBeforeJson?: unknown;
};

type LockedRun = {
  id: string;
  source_config_id: string;
  status: string;
  job_id: string;
  job_status: string;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
  source_version: number;
  rights_grant_id: string | null;
  credential_ref: string | null;
  credential_version: number;
  connector_id: string;
  connector_version: string;
  cost_micros_per_request: number;
  shadow: number;
  connector_rollout_mode: 'disabled' | 'shadow' | 'enabled' | null;
  connector_canary_enabled: number | null;
  connector_canary_percent: number | null;
  connector_rollout_reason: string | null;
  checkpoint_scope: 'live' | 'backfill';
  checkpoint_before_json: unknown;
  checkpoint_after_json: unknown;
  result_json: unknown;
  current_source_version: number;
  current_checkpoint_json: unknown;
  current_backfill_checkpoint_json: unknown;
  current_checkpoint_version: number;
  current_backfill_checkpoint_version: number;
  active_run_id: string | null;
  platform: string;
  publisher_entity_id: string | null;
  source_name: string;
  source_type: SourceType | null;
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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * 原子接纳一次有界采集运行的结果（单页或有限多页）。
 *
 * 文章、修订、origin、运行结果与 checkpoint 必须共享最外层事务；否则 Worker
 * 在任一写入边界退出后重放，会出现“文章已经写入但游标没推进”或旧作业倒写
 * checkpoint。主题聚类通过事务中写入的独立幂等作业在事务后重算。R2 原始载荷
 * 先上传，数据库只在这里提交引用；孤儿对象由保留任务回收。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await authorizeWorker(request, config.sourceWorkerToken))) {
    return sourceApiError('Worker 未授权。', 401);
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return sourceApiError('采集提交不能超过 10 MB。', 413);
  }

  let body: CommitBody;
  try {
    body = JSON.parse(raw) as CommitBody;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (
    !body.jobId ||
    !body.workerId ||
    !Number.isInteger(body.leaseEpoch) ||
    Number(body.leaseEpoch) < 1 ||
    (!Array.isArray(body.articles) && !Array.isArray(body.items)) ||
    (Array.isArray(body.articles) && body.articles.length > MAX_ARTICLES) ||
    (Array.isArray(body.items) && body.items.length > MAX_ARTICLES)
  ) {
    return sourceApiError(`jobId、workerId、有效 leaseEpoch 与 0–${MAX_ARTICLES} 条 items 或兼容 articles 必填。`, 422);
  }
  const normalizedItemResult = body.items === undefined
    ? { items: [], issues: [] }
    : parseNormalizedSourceItems(body.items);
  if (normalizedItemResult.issues.length) {
    return sourceApiError('标准化来源事件校验失败。', 422, { issues: normalizedItemResult.issues.slice(0, 10) });
  }
  if (body.checkpointJson !== undefined && !isRecord(body.checkpointJson)) {
    return sourceApiError('checkpointJson 必须是对象。', 422);
  }
  const pageMode = typeof body.pageKey === 'string';
  if (
    pageMode &&
    (!/^[A-Za-z0-9._:-]{1,160}$/.test(body.pageKey ?? '') ||
      !Number.isInteger(body.pageOrdinal) ||
      Number(body.pageOrdinal) < 0 ||
      Number(body.pageOrdinal) > 9_999 ||
      !/^sha256:[a-f0-9]{64}$/.test(body.pageContentHash ?? '') ||
      typeof body.finalPage !== 'boolean' ||
      !isRecord(body.checkpointBeforeJson) ||
      Boolean(body.rawObjectKey))
  ) {
    return sourceApiError('逐页提交需要合法 pageKey、pageOrdinal、pageContentHash、finalPage 和 checkpointBeforeJson，原始载荷在运行终结时提交。', 422);
  }
  if (
    (body.origins !== undefined && !Array.isArray(body.origins)) ||
    (body.rejections !== undefined && !Array.isArray(body.rejections))
  ) {
    return sourceApiError('origins 与 rejections 必须是数组。', 422);
  }
  if (
    (body.origins as unknown[] | undefined)?.length &&
    (body.origins as unknown[]).length > MAX_ARTICLES
  ) {
    return sourceApiError(`origins 不能超过 ${MAX_ARTICLES} 条。`, 422);
  }
  if (
    (body.rejections as unknown[] | undefined)?.length &&
    (body.rejections as unknown[]).length > MAX_ARTICLES
  ) {
    return sourceApiError(`rejections 不能超过 ${MAX_ARTICLES} 条。`, 422);
  }
  if (
    body.fetchedCount !== undefined &&
    (!Number.isInteger(body.fetchedCount) ||
      body.fetchedCount < 0 ||
      body.fetchedCount > MAX_ARTICLES)
  ) {
    return sourceApiError(`fetchedCount 必须为 0–${MAX_ARTICLES} 的整数。`, 422);
  }
  if (
    body.skippedCount !== undefined &&
    (!Number.isInteger(body.skippedCount) ||
      body.skippedCount < 0 ||
      body.skippedCount > MAX_ARTICLES)
  ) {
    return sourceApiError(`skippedCount 必须为 0–${MAX_ARTICLES} 的整数。`, 422);
  }
  if (
    body.requestCount !== undefined &&
    (!Number.isInteger(body.requestCount) ||
      body.requestCount < 0 ||
      body.requestCount > 100)
  ) {
    return sourceApiError('requestCount 必须为 0–100 的整数。', 422);
  }
  if (
    body.byteCount !== undefined &&
    (!Number.isInteger(body.byteCount) ||
      body.byteCount < 0 ||
      body.byteCount > 10_000_000)
  ) {
    return sourceApiError('byteCount 必须为 0–10000000 的整数。', 422);
  }
  if (
    body.notModified !== undefined &&
    typeof body.notModified !== 'boolean'
  ) {
    return sourceApiError('notModified 必须是布尔值。', 422);
  }
  if (hasNotModifiedPayloadConflict(fetchOutcomeFromNotModified(body.notModified), {
    fetchedCount: Number(body.fetchedCount ?? 0),
    acceptedCount:
      (Array.isArray(body.items) ? body.items.length : 0) +
      (Array.isArray(body.articles) ? body.articles.length : 0),
    rejectedCount: Array.isArray(body.rejections) ? body.rejections.length : 0,
    byteCount: Number(body.byteCount ?? 0),
  })) {
    return sourceApiError('304 未修改运行不能同时提交内容、拒绝项或响应字节。', 422);
  }

  const now = new Date();
  const legacyArticles = Array.isArray(body.articles) ? body.articles : [];
  const issues = legacyArticles
    .map((article, index) => ({
      index,
      issue: validateArticleInput(article, now),
    }))
    .filter((item) => item.issue);
  if (issues.length) {
    return sourceApiError('采集数据校验失败。', 422, { issues: issues.slice(0, 10) });
  }

  const { id } = await context.params;
  try {
    const result = await db.transaction(async (tx) => {
      const run = await tx
        .prepare(`
          SELECT ir.id, ir.source_config_id, ir.status, ir.job_id,
            ir.source_version, ir.rights_grant_id, ir.credential_ref, ir.credential_version,
            ir.connector_id, ir.connector_version, ir.cost_micros_per_request,
            ir.shadow, ir.checkpoint_scope, ir.checkpoint_before_json, ir.checkpoint_after_json, ir.result_json,
            j.status AS job_status, j.lease_owner, j.lease_epoch, j.lease_expires_at,
            sc.version AS current_source_version,
            sc.checkpoint_json AS current_checkpoint_json,
            sc.backfill_checkpoint_json AS current_backfill_checkpoint_json,
            sc.checkpoint_version AS current_checkpoint_version,
            sc.backfill_checkpoint_version AS current_backfill_checkpoint_version,
            sc.active_run_id, sc.platform, sc.publisher_entity_id,
            sc.name AS source_name, sc.source_type,
            sc.enabled AS source_enabled, sc.lifecycle_status AS source_lifecycle_status,
            sc.rights_status AS source_rights_status, sc.retention_mode AS source_retention_mode,
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
        `)
        .bind(id)
        .first<LockedRun>();
      if (!run) return { error: '采集运行不存在。', status: 404 as const };
      if (run.job_id !== body.jobId) {
        return { error: '采集运行与作业不匹配。', status: 409 as const };
      }

      if (pageMode) {
        const existingPage = await tx.prepare(`
          SELECT content_hash, lease_epoch, result_json
          FROM ingestion_pages
          WHERE ingestion_run_id = ? AND page_key = ?
          FOR UPDATE
        `).bind(id, body.pageKey).first<{
          content_hash: string | null;
          lease_epoch: number;
          result_json: unknown;
        }>();
        if (existingPage) {
          const replayDecision = pageReplayDecision(
            { contentHash: existingPage.content_hash, leaseEpoch: existingPage.lease_epoch },
            { contentHash: String(body.pageContentHash), leaseEpoch: Number(body.leaseEpoch) },
          );
          if (replayDecision === 'conflict') {
            return { error: '相同 pageKey 已由不同内容或租约代次提交。', status: 409 as const };
          }
          return {
            replay: isRecord(existingPage.result_json) ? existingPage.result_json : { ingestionRunId: id, pageKey: body.pageKey, status: 'committed' },
            status: 200 as const,
          };
        }
      }

      // HTTP 响应丢失时允许同一个 Worker 重放已经提交的结果，而不是把成功作业送进 DLQ。
      if (
        ['succeeded', 'partial'].includes(run.status) &&
        isRecord(run.result_json)
      ) {
        return { replay: run.result_json, status: 200 as const };
      }
      if (
        run.job_status !== 'leased' ||
        run.lease_owner !== body.workerId ||
        run.lease_epoch !== body.leaseEpoch ||
        !run.lease_expires_at ||
        run.lease_expires_at <= now.toISOString()
      ) {
        return {
          error: '采集运行与当前 Worker 租约不匹配或租约已过期。',
          status: 409 as const,
        };
      }
      if (!['queued', 'running'].includes(run.status)) {
        return {
          error: `采集运行已处于 ${run.status}。`,
          status: 409 as const,
        };
      }
      if (
        !run.connector_rollout_mode ||
        run.connector_rollout_mode === 'disabled'
      ) {
        const reason =
          run.connector_rollout_reason ||
          `连接器 ${run.connector_id}@${run.connector_version} 当前已停用。`;
        await quarantineConnectorDisabledIngestion(
          tx,
          {
            sourceConfigId: run.source_config_id,
            ingestionRunId: id,
            connectorId: run.connector_id,
            connectorVersion: run.connector_version,
            reason,
          },
          now,
        );
        return {
          error: reason,
          errorCode: 'CONNECTOR_DISABLED',
          status: 409 as const,
        };
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
      if (!run.shadow && effectiveRollout.mode !== 'enabled') {
        const reason =
          '连接器发布范围已变更；该来源当前不在正式写入范围，本次旧运行已隔离。';
        await quarantineConnectorRolloutChangedIngestion(
          tx,
          {
            sourceConfigId: run.source_config_id,
            ingestionRunId: id,
            reason,
          },
          now,
        );
        return {
          error: reason,
          errorCode: 'CONNECTOR_ROLLOUT_CHANGED',
          status: 409 as const,
        };
      }
      if (run.active_run_id !== id) {
        return {
          error: '该来源已有更新的活动运行，本次结果不得推进 checkpoint。',
          status: 409 as const,
        };
      }
      const credentialBlocked =
        run.credential_ref !== run.current_credential_ref ||
        run.credential_version !== run.current_credential_version ||
        (Boolean(run.credential_ref) &&
          (run.credential_status !== 'active' ||
            Boolean(run.credential_revoked_at) ||
            Boolean(
              run.credential_expires_at &&
              run.credential_expires_at <= now.toISOString(),
            )));
      if (credentialBlocked) {
        const reason = '来源凭据已在采集期间轮换、撤销或过期，本次结果已隔离。';
        await quarantineCredentialBlockedIngestion(
          tx,
          {
            sourceConfigId: run.source_config_id,
            ingestionRunId: id,
            credentialRef: run.credential_ref,
            credentialVersion: run.credential_version,
            reason,
          },
          now,
        );
        return {
          error: reason,
          errorCode: 'AUTH_REQUIRED',
          status: 409 as const,
        };
      }
      const hasUpserts = normalizedItemResult.items.some((item) => item.kind === 'upsert') || legacyArticles.length > 0;
      const requiredFields = new Set(hasUpserts ? ['title', 'url', 'publishedAt'] : []);
      for (const article of legacyArticles as ArticleInput[]) {
        if (!isRecord(article)) continue;
        if (typeof article.summary === 'string' && article.summary.trim())
          requiredFields.add('summary');
        if (typeof article.author === 'string' && article.author.trim())
          requiredFields.add('author');
      }
      const rightsBlockedReason = ingestionRightsBlockReason(
        {
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
        },
        { now, requiredFields, hasRawPayload: Boolean(body.rawObjectKey) },
      );
      if (rightsBlockedReason) {
        await quarantineRightsBlockedIngestion(
          tx,
          {
            sourceConfigId: run.source_config_id,
            ingestionRunId: id,
            rightsGrantId: run.rights_grant_id,
            reason: rightsBlockedReason,
          },
          now,
        );
        return {
          error: rightsBlockedReason,
          errorCode: 'RIGHTS_BLOCKED',
          status: 409 as const,
        };
      }
      if (run.current_source_version !== run.source_version) {
        return {
          error: '来源配置已在采集期间变更，本次结果已隔离。',
          status: 409 as const,
        };
      }
      if (pageMode) {
        if (run.shadow || run.connector_rollout_mode === 'shadow') {
          return {
            error: 'shadow 运行使用整运行摘要提交，不接受正式逐页写入。',
            status: 409 as const,
          };
        }
        const previousPage = await tx.prepare(`
          SELECT page_ordinal, final_page
          FROM ingestion_pages
          WHERE ingestion_run_id = ? AND page_ordinal IS NOT NULL
          ORDER BY page_ordinal DESC
          LIMIT 1
          FOR UPDATE
        `).bind(id).first<{ page_ordinal: number; final_page: number }>();
        const currentCheckpointJson = previousPage
          ? run.checkpoint_after_json
          : run.checkpoint_before_json;
        const pageSequenceError = validateNextCommittedPage({
          previous: previousPage ? {
            pageOrdinal: previousPage.page_ordinal,
            finalPage: Boolean(previousPage.final_page),
          } : null,
          proposedOrdinal: Number(body.pageOrdinal),
          currentCheckpointJson,
          checkpointBeforeJson: body.checkpointBeforeJson,
        });
        if (pageSequenceError) return { error: pageSequenceError, status: 409 as const };
      }
      if (
        body.rawObjectKey &&
        !body.rawObjectKey.startsWith(
          `sources/${run.source_config_id}/raw/${id}/`,
        )
      ) {
        return {
          error: '原始载荷对象键与来源或运行不匹配。',
          status: 422 as const,
        };
      }
      if (run.shadow || run.connector_rollout_mode === 'shadow') {
        const shadowResult = await commitShadowIngestion(
          tx,
          {
            sourceConfigId: run.source_config_id,
            ingestionRunId: id,
            fetchedCount:
            body.fetchedCount ?? (Array.isArray(body.items) ? body.items.length : legacyArticles.length),
            rejectedCount: Array.isArray(body.rejections)
              ? body.rejections.length
              : 0,
            requestCount: body.requestCount ?? 0,
            byteCount: body.byteCount ?? 0,
            costMicrosPerRequest: run.cost_micros_per_request,
            connectorId: run.connector_id,
            connectorVersion: run.connector_version,
          },
          now,
        );
        return { response: shadowResult, status: 200 as const };
      }
      let rawUploadId: string | null = null;
      if (body.rawObjectKey) {
        const rawUpload = await requireRawPayloadUploadForCommit(
          tx,
          {
            sourceConfigId: run.source_config_id,
            ingestionRunId: id,
            objectKey: body.rawObjectKey,
          },
          now,
        );
        rawUploadId = rawUpload.id;
      }

      if (normalizedItemResult.items.length && (!run.source_type || !(SOURCE_TYPES as readonly string[]).includes(run.source_type))) {
        return { error: '来源缺少可用于控制面投影的 sourceType。', status: 409 as const };
      }
      const articles = normalizedItemResult.items.length
        ? normalizedItemResult.items
            .filter((item) => item.kind === 'upsert')
            .map((item) => normalizedUpsertToArticle(item, {
              name: run.source_name,
              sourceType: run.source_type as SourceType,
            }))
        : legacyArticles as ArticleInput[];
      const stagedPayload: StagedIngestionPayload = {
        items: normalizedItemResult.items.length ? normalizedItemResult.items : undefined,
        articles: normalizeArticles(articles),
        origins: Array.isArray(body.origins) ? body.origins : [],
        rejections: Array.isArray(body.rejections) ? body.rejections : [],
        skippedCount: Number.isInteger(body.skippedCount) ? Math.max(0, Number(body.skippedCount)) : 0,
      };
      const materialized = pageMode
        ? null
        : await materializeIngestionPayload(tx, {
            sourceConfigId: run.source_config_id,
            ingestionRunId: id,
            platform: run.platform,
            publisherEntityId: run.publisher_entity_id,
            payload: stagedPayload,
            observedAt: now,
            rawObjectKey: body.rawObjectKey ?? null,
          });
      const normalized = stagedPayload.articles;
      const acceptedCount = normalizedItemResult.items.length || normalized.length;
      const duplicateCount = materialized?.duplicateCount ?? await countExistingOriginDuplicates(
        tx,
        run.source_config_id,
        run.platform,
        stagedPayload,
      );
      await tx
        .prepare(
          "UPDATE ingestion_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
        )
        .bind(now.toISOString(), id)
        .run();
      const checkpoint = body.checkpoint ?? normalized[0]?.publishedAt ?? null;
      const checkpointJson = body.checkpointJson ?? {
        schemaVersion: 1,
        watermark: checkpoint,
      };
      const finishedAt = new Date().toISOString();
      const explicitRejectionCount = Array.isArray(body.rejections)
        ? body.rejections.length
        : 0;
      const fetchedCount = Math.max(
        acceptedCount + explicitRejectionCount,
        body.fetchedCount ?? acceptedCount,
      );
      const rejectedCount = explicitRejectionCount;
      if (pageMode) {
        const pageOrdinal = Number(body.pageOrdinal);
        const pageKey = String(body.pageKey);
        const pageCheckpointVersion = run.checkpoint_scope === 'backfill'
          ? run.current_backfill_checkpoint_version + 1
          : run.current_checkpoint_version + 1;
        const pageResponse = {
          ingestionRunId: id,
          pageKey,
          pageOrdinal,
          finalPage: body.finalPage === true,
          status: 'committed',
          acceptedCount,
          rejectedCount,
          duplicateCount,
          fetchedCount,
          requestCount: Math.max(0, body.requestCount ?? 1),
          byteCount: Math.max(0, body.byteCount ?? raw.length),
          checkpoint,
          checkpointJson,
          checkpointScope: run.checkpoint_scope,
          checkpointVersion: pageCheckpointVersion,
          leaseEpoch: body.leaseEpoch,
        };
        const pageId = `ingestion_page_${sha256Hex(`${id}:${pageKey}`).slice(0, 32)}`;
        await tx.batch([
          tx.prepare(`
            INSERT INTO ingestion_pages
              (id, ingestion_run_id, page_key, page_ordinal, content_hash, lease_epoch,
               final_page, checkpoint_before_json, checkpoint_after_json, status,
               result_json, staged_payload_json, fetched_count, accepted_count, rejected_count,
               duplicate_count, request_count, byte_count, created_at, committed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            pageId,
            id,
            pageKey,
            pageOrdinal,
            body.pageContentHash,
            body.leaseEpoch,
            body.finalPage ? 1 : 0,
            JSON.stringify(body.checkpointBeforeJson ?? {}),
            JSON.stringify(checkpointJson),
            JSON.stringify(pageResponse),
            JSON.stringify(stagedPayload),
            fetchedCount,
            acceptedCount,
            rejectedCount,
            duplicateCount,
            Math.max(0, body.requestCount ?? 1),
            Math.max(0, body.byteCount ?? raw.length),
            finishedAt,
            finishedAt,
          ),
          tx.prepare(`
            UPDATE ingestion_runs SET status = 'running', checkpoint_after = ?, checkpoint_after_json = ?,
              fetched_count = fetched_count + ?, accepted_count = accepted_count + ?,
              rejected_count = rejected_count + ?, duplicate_count = duplicate_count + ?,
              request_count = request_count + ?, byte_count = byte_count + ?,
              result_json = ?, started_at = COALESCE(started_at, ?)
            WHERE id = ?
          `).bind(
            checkpoint,
            JSON.stringify(checkpointJson),
            fetchedCount,
            acceptedCount,
            rejectedCount,
            duplicateCount,
            Math.max(0, body.requestCount ?? 1),
            Math.max(0, body.byteCount ?? raw.length),
            JSON.stringify({ protocol: 'page-v1', lastCommittedPage: pageResponse }),
            finishedAt,
            id,
          ),
        ]);
        return { response: pageResponse, status: 200 as const };
      }
      const ingestionStatus = rejectedCount > 0 ? 'partial' : 'succeeded';
      const fetchOutcome = fetchOutcomeFromNotModified(body.notModified);
      const pipelineJobId = `job_pipeline_${sha256Hex(id).slice(0, 32)}`;
      const checkpointVersion =
        run.checkpoint_scope === 'backfill'
          ? run.current_backfill_checkpoint_version + 1
          : run.current_checkpoint_version + 1;
      const response = {
        ingestionRunId: id,
        status: ingestionStatus,
        fetchOutcome,
        pipelineJobId,
        acceptedCount,
        rejectedCount,
        duplicateCount,
        checkpoint,
        checkpointScope: run.checkpoint_scope,
        checkpointVersion,
      };

      const sourceCheckpointUpdate =
        run.checkpoint_scope === 'backfill'
          ? tx
              .prepare(`
            UPDATE source_configs SET backfill_checkpoint_json = ?,
              backfill_checkpoint_version = backfill_checkpoint_version + 1,
              active_run_id = NULL, last_success_at = ?, last_healthy_at = ?,
              health_status = 'healthy', consecutive_failures = 0,
              last_error = NULL, last_error_code = NULL, retry_after = NULL,
              backoff_until = NULL, updated_at = ?
            WHERE id = ? AND version = ? AND backfill_checkpoint_version = ? AND active_run_id = ?
          `)
              .bind(
                JSON.stringify(checkpointJson),
                finishedAt,
                finishedAt,
                finishedAt,
                run.source_config_id,
                run.source_version,
                run.current_backfill_checkpoint_version,
                id,
              )
          : tx
              .prepare(`
            UPDATE source_configs SET checkpoint = ?, checkpoint_json = ?,
              checkpoint_version = checkpoint_version + 1, active_run_id = NULL,
              last_success_at = ?, last_healthy_at = ?, health_status = 'healthy',
              consecutive_failures = 0, last_error = NULL, last_error_code = NULL,
              retry_after = NULL, backoff_until = NULL,
              updated_at = ?
            WHERE id = ? AND version = ? AND checkpoint_version = ? AND active_run_id = ?
          `)
              .bind(
                checkpoint,
                JSON.stringify(checkpointJson),
                finishedAt,
                finishedAt,
                finishedAt,
                run.source_config_id,
                run.source_version,
                run.current_checkpoint_version,
                id,
              );
      const [, sourceUpdated] = await tx.batch([
        tx
          .prepare(`
            UPDATE ingestion_runs SET status = ?, fetch_outcome = ?, checkpoint_after = ?, checkpoint_after_json = ?,
              fetched_count = ?, accepted_count = ?, rejected_count = ?, duplicate_count = ?, request_count = ?, byte_count = ?,
              cost_micros = ?,
              result_json = ?, finished_at = ?
            WHERE id = ?
          `)
          .bind(
            ingestionStatus,
            fetchOutcome,
            checkpoint,
            JSON.stringify(checkpointJson),
            fetchedCount,
            acceptedCount,
            rejectedCount,
            duplicateCount,
            Math.max(0, body.requestCount ?? 1),
            Math.max(0, body.byteCount ?? raw.length),
            Math.max(0, body.requestCount ?? 1) * run.cost_micros_per_request,
            JSON.stringify(response),
            finishedAt,
            id,
          ),
        sourceCheckpointUpdate,
      ]);
      if (!sourceUpdated.meta.changes) {
        // 最外层事务会同时回滚文章、修订、origin 与运行结果，绝不留下半提交页。
        throw new Error('来源 checkpoint 已被更新，本次采集结果未提交。');
      }
      if (rawUploadId)
        await commitRawPayloadUpload(tx, rawUploadId, new Date(finishedAt));
      // 主题重算只在页提交成功后由独立作业执行。确定性 ID/幂等键
      // 使 Worker 在 HTTP 响应丢失后重放也不会生成两次派生运行。
      if ((materialized?.changedCount ?? acceptedCount) > 0) await tx
        .prepare(`
        INSERT INTO jobs
          (id, kind, required_capability, payload_schema_version, payload_json,
           status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
        VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
        ON CONFLICT (kind, idempotency_key) DO NOTHING
      `)
        .bind(
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
        )
        .run();
      return { response, status: 200 as const };
    });

    if ('error' in result)
      return sourceApiError(result.error ?? '采集提交失败。', result.status ?? 500, {
        errorCode: asSourceApiErrorCode('errorCode' in result ? result.errorCode : undefined),
      });
    if ('replay' in result)
      return Response.json(result.replay, { status: result.status });
    return Response.json(result.response);
  } catch (error) {
    if (error instanceof RawPayloadUploadError) {
      return sourceApiError(error.message, error.status, { errorCode: 'STORAGE_ERROR' });
    }
    return sourceApiError(error instanceof Error ? error.message : '采集提交失败。', 503, {
      errorCode: 'STORAGE_ERROR', retryable: true,
    });
  }
}
