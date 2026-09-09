import type { Actor } from './workflow.ts';
import type { SqlDatabase } from './sql.ts';
import type { ObjectStorage } from './storage.ts';
import { stableHash } from './workflow.ts';
import { sourceActionAllowed } from './source-authorization.ts';
import { activeLeaseMatches } from './job-lease.ts';

type DeletionRequestRow = {
  id: string;
  source_config_id: string;
  status: string;
  reason: string;
  requested_by: string;
  initialized_at: string | null;
};

async function hasActiveHold(db: SqlDatabase, sourceId: string) {
  return Boolean(await db.prepare("SELECT id FROM source_legal_holds WHERE source_config_id = ? AND status = 'active' LIMIT 1")
    .bind(sourceId).first());
}

export async function createSourceLegalHold(
  db: SqlDatabase,
  input: { sourceId: string; reason: string; authorityRef: string; actor: Actor },
  now = new Date(),
) {
  if (!sourceActionAllowed(input.actor, 'source.legal-hold.create')) {
    return { status: 403 as const, error: '需要有效的来源法律操作权限才能创建 legal hold。' };
  }
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const legalOperators = await tx.prepare(`
      SELECT user_id FROM team_members
      WHERE role = 'admin' AND status = 'active' AND can_manage_source_legal = 1
      ORDER BY user_id FOR UPDATE
    `).all<{ user_id: string }>();
    const source = await tx.prepare('SELECT id, legal_hold_epoch FROM source_configs WHERE id = ? FOR UPDATE')
      .bind(input.sourceId).first<{ id: string; legal_hold_epoch: number }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    const existing = await tx.prepare("SELECT id, hold_epoch FROM source_legal_holds WHERE source_config_id = ? AND status = 'active' LIMIT 1")
      .bind(input.sourceId).first<{ id: string; hold_epoch: number }>();
    if (existing) return { status: 200 as const, legalHoldId: existing.id, holdEpoch: existing.hold_epoch, replayed: true };
    const independentOperator = legalOperators.results.some(
      (operator) => operator.user_id !== input.actor.id,
    );
    if (!independentOperator) {
      return { status: 409 as const, error: '创建 legal hold 前必须任命另一名有效法律操作人，以保证异人解除。' };
    }
    const legalHoldId = `legal_hold_${crypto.randomUUID()}`;
    const holdEpoch = Number(source.legal_hold_epoch) + 1;
    await tx.prepare('UPDATE source_configs SET legal_hold_epoch = ? WHERE id = ?')
      .bind(holdEpoch, input.sourceId).run();
    await tx.prepare(`
      INSERT INTO source_legal_holds
        (id, source_config_id, status, reason, authority_ref, hold_epoch, created_by, created_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, ?)
    `).bind(legalHoldId, input.sourceId, input.reason.slice(0, 2000), input.authorityRef.slice(0, 500), holdEpoch, input.actor.id, timestamp).run();
    await tx.prepare(`
      UPDATE source_deletion_requests SET status = 'blocked', legal_hold_id = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE source_config_id = ? AND status NOT IN ('completed', 'blocked')
    `).bind(legalHoldId, timestamp, input.sourceId).run();
    await tx.prepare(`
      UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
        lease_epoch = CASE WHEN status = 'leased' THEN lease_epoch + 1 ELSE lease_epoch END,
        updated_at = ?
      WHERE kind = 'publish' AND payload_json ->> 'deletionRequestId' IN (
        SELECT id FROM source_deletion_requests WHERE source_config_id = ? AND status = 'blocked'
      ) AND status IN ('queued', 'retrying', 'leased')
    `).bind(timestamp, input.sourceId).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.legal_hold_created', 'source_legal_hold', ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, legalHoldId,
      JSON.stringify({ sourceConfigId: input.sourceId, authorityRef: input.authorityRef.slice(0, 500), holdEpoch }), crypto.randomUUID(), timestamp).run();
    return { status: 201 as const, legalHoldId, holdEpoch, replayed: false };
  });
}

export async function releaseSourceLegalHold(
  db: SqlDatabase,
  input: { sourceId: string; legalHoldId: string; reason: string; actor: Actor },
  now = new Date(),
) {
  if (!sourceActionAllowed(input.actor, 'source.legal-hold.release')) {
    return { status: 403 as const, error: '需要有效的来源法律操作权限才能解除 legal hold。' };
  }
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const source = await tx.prepare('SELECT legal_hold_epoch FROM source_configs WHERE id = ? FOR UPDATE')
      .bind(input.sourceId).first<{ legal_hold_epoch: number }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    const hold = await tx.prepare(`
      SELECT id, status, created_by, hold_epoch FROM source_legal_holds WHERE id = ? AND source_config_id = ? FOR UPDATE
    `).bind(input.legalHoldId, input.sourceId).first<{ id: string; status: string; created_by: string; hold_epoch: number }>();
    if (!hold) return { status: 404 as const, error: 'Legal hold 不存在。' };
    if (hold.status === 'released') return { status: 200 as const, legalHoldId: hold.id, holdEpoch: hold.hold_epoch, replayed: true };
    if (!sourceActionAllowed(input.actor, 'source.legal-hold.release', { createdBy: hold.created_by })) {
      return { status: 403 as const, error: '建立 legal hold 的管理员不能单人解除同一个 hold。' };
    }
    await tx.prepare("UPDATE source_legal_holds SET status = 'released', released_by = ?, released_at = ? WHERE id = ? AND status = 'active'")
      .bind(input.actor.id, timestamp, hold.id).run();
    await tx.prepare(`
      UPDATE source_deletion_requests SET status = 'pending', legal_hold_id = NULL,
        last_error_redacted = NULL, updated_at = ?
      WHERE source_config_id = ? AND status = 'blocked' AND legal_hold_id = ?
    `).bind(timestamp, input.sourceId, hold.id).run();
    await tx.prepare(`
      UPDATE jobs SET status = 'queued', available_at = ?, lease_owner = NULL,
        lease_expires_at = NULL,
        payload_json = jsonb_set(payload_json, '{legalHoldEpoch}', to_jsonb(CAST(? AS integer)), true),
        updated_at = ?
      WHERE kind = 'publish' AND payload_json ->> 'deletionRequestId' IN (
        SELECT id FROM source_deletion_requests WHERE source_config_id = ? AND status = 'pending'
      ) AND status = 'cancelled'
    `).bind(timestamp, source.legal_hold_epoch, timestamp, input.sourceId).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.legal_hold_released', 'source_legal_hold', ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, hold.id,
      JSON.stringify({ sourceConfigId: input.sourceId, reason: input.reason.slice(0, 500), holdEpoch: hold.hold_epoch }), crypto.randomUUID(), timestamp).run();
    return { status: 200 as const, legalHoldId: hold.id, holdEpoch: hold.hold_epoch, replayed: false };
  });
}

type SourceVersionRow = { id: string; version: number };

async function initializeSourceDeletion(
  tx: SqlDatabase,
  request: { id: string; reason: string; requestedBy: string },
  source: SourceVersionRow,
  timestamp: string,
) {
  const articleRows = await tx.prepare(`
    SELECT DISTINCT own.article_id
    FROM source_item_origins own
    WHERE own.source_config_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM source_item_origins shared
        WHERE shared.article_id = own.article_id
          AND shared.source_config_id <> own.source_config_id
          AND shared.deleted_at IS NULL
      )
  `).bind(source.id).all<{ article_id: string }>();
  const articleIds = articleRows.results.map((row) => row.article_id);
  for (const articleId of articleIds) await tx.prepare(`
    INSERT INTO source_deletion_items (id, request_id, kind, target_ref, status, created_at, updated_at)
    VALUES (?, ?, 'normalized_article', ?, 'pending', ?, ?) ON CONFLICT (request_id, kind, target_ref) DO NOTHING
  `).bind(`delete_item_${crypto.randomUUID()}`, request.id, articleId, timestamp, timestamp).run();

  const projects = articleIds.length ? await tx.prepare(`
    SELECT DISTINCT cp.id
    FROM content_projects cp
    LEFT JOIN claims c ON c.project_id = cp.id
    LEFT JOIN evidence_links el ON el.claim_id = c.id
    LEFT JOIN topic_articles ta ON ta.topic_id = cp.topic_id
    WHERE el.article_id IN (${articleIds.map(() => '?').join(', ')})
       OR ta.article_id IN (${articleIds.map(() => '?').join(', ')})
  `).bind(...articleIds, ...articleIds).all<{ id: string }>() : { results: [] as Array<{ id: string }> };
  const projectIds = projects.results.map((row) => row.id);
  for (const projectId of projectIds) await tx.prepare(`
    INSERT INTO source_deletion_items (id, request_id, kind, target_ref, status, created_at, updated_at)
    VALUES (?, ?, 'derived_project', ?, 'pending', ?, ?) ON CONFLICT (request_id, kind, target_ref) DO NOTHING
  `).bind(`delete_item_${crypto.randomUUID()}`, request.id, projectId, timestamp, timestamp).run();

  const rawObjects = await tx.prepare("SELECT object_key FROM raw_payload_uploads WHERE source_config_id = ? AND state <> 'deleted'")
    .bind(source.id).all<{ object_key: string }>();
  const projectObjects = projectIds.length ? await tx.prepare(`
    SELECT object_key FROM assets WHERE project_id IN (${projectIds.map(() => '?').join(', ')})
    UNION SELECT object_key FROM voice_tracks WHERE project_id IN (${projectIds.map(() => '?').join(', ')})
    UNION SELECT package_object_key AS object_key FROM publish_jobs WHERE project_id IN (${projectIds.map(() => '?').join(', ')}) AND package_object_key IS NOT NULL
    UNION SELECT output_object_key AS object_key FROM jobs WHERE project_id IN (${projectIds.map(() => '?').join(', ')}) AND output_object_key IS NOT NULL
    UNION SELECT log_object_key AS object_key FROM jobs WHERE project_id IN (${projectIds.map(() => '?').join(', ')}) AND log_object_key IS NOT NULL
  `).bind(...projectIds, ...projectIds, ...projectIds, ...projectIds, ...projectIds).all<{ object_key: string }>() : { results: [] as Array<{ object_key: string }> };
  for (const [kind, rows] of [['raw_object', rawObjects.results], ['project_object', projectObjects.results]] as const) {
    for (const row of rows) await tx.prepare(`
      INSERT INTO source_deletion_items
        (id, request_id, kind, target_ref, object_key, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (request_id, kind, target_ref) DO NOTHING
    `).bind(`delete_item_${crypto.randomUUID()}`, request.id, kind, stableHash(row.object_key), row.object_key, timestamp, timestamp).run();
  }

  if (projectIds.length) {
    const published = await tx.prepare(`
      SELECT id FROM publish_jobs
      WHERE project_id IN (${projectIds.map(() => '?').join(', ')}) AND status = 'published' AND external_id IS NOT NULL
    `).bind(...projectIds).all<{ id: string }>();
    for (const publish of published.results) await tx.prepare(`
      INSERT INTO source_deletion_items
        (id, request_id, kind, target_ref, status, created_at, updated_at)
      VALUES (?, ?, 'external_publish', ?, 'awaiting_external', ?, ?)
      ON CONFLICT (request_id, kind, target_ref) DO NOTHING
    `).bind(`delete_item_${crypto.randomUUID()}`, request.id, publish.id, timestamp, timestamp).run();
  }

  await tx.prepare(`
    UPDATE source_item_origins SET deleted_at = COALESCE(deleted_at, ?), last_seen_at = ? WHERE source_config_id = ?
  `).bind(timestamp, timestamp, source.id).run();
  await tx.prepare("UPDATE source_rights_grants SET revoked_at = COALESCE(revoked_at, ?) WHERE source_config_id = ?")
    .bind(timestamp, source.id).run();
  await tx.prepare(`
    UPDATE source_configs SET enabled = 0, lifecycle_status = 'paused', health_status = 'paused',
      rights_status = 'revoked', next_run_at = NULL, last_error = '依法删除处理中。',
      last_error_code = 'RIGHTS_BLOCKED', version = version + 1, updated_at = ? WHERE id = ? AND version = ?
  `).bind(timestamp, source.id, source.version).run();
  await tx.prepare(`
    UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE kind = 'ingestion' AND payload_json ->> 'sourceConfigId' = ? AND status IN ('queued', 'retrying')
  `).bind(timestamp, source.id).run();
  const derivationKey = `legal-deletion:${source.id}:${source.version + 1}`;
  await tx.prepare(`
    INSERT INTO jobs
      (id, kind, required_capability, payload_schema_version, payload_json,
       status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
    VALUES (?, 'ingestion', 'source:pipeline', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
    ON CONFLICT (kind, idempotency_key) DO NOTHING
  `).bind(
    `job_pipeline_${stableHash(derivationKey).slice(0, 32)}`,
    JSON.stringify({ schemaVersion: 2, operation: 'topic_recompute', derivationKey, rollingWindowHours: 72 }),
    `topic-recompute:${derivationKey}`, timestamp, timestamp, timestamp,
  ).run();
  await tx.prepare(`
    UPDATE source_deletion_requests SET source_version = ?, initialized_at = ?, updated_at = ? WHERE id = ? AND initialized_at IS NULL
  `).bind(source.version, timestamp, timestamp, request.id).run();
  await tx.prepare(`
    INSERT INTO audit_events
      (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
    VALUES (?, ?, 'admin', 'source.legal_deletion_initialized', 'source_deletion_request', ?, ?, ?, ?)
  `).bind(`audit_${crypto.randomUUID()}`, request.requestedBy, request.id,
    JSON.stringify({ sourceConfigId: source.id, articleCount: articleIds.length, projectCount: projectIds.length }), crypto.randomUUID(), timestamp).run();
}

async function ensureExternalWithdrawalJobs(db: SqlDatabase, request: DeletionRequestRow, timestamp: string) {
  const fence = await db.prepare(`
    SELECT legal_hold_epoch,
      EXISTS (
        SELECT 1 FROM source_legal_holds
        WHERE source_config_id = source_configs.id AND status = 'active'
      ) AS active_hold
    FROM source_configs WHERE id = ? LIMIT 1
  `).bind(request.source_config_id).first<{ legal_hold_epoch: number; active_hold: boolean | number }>();
  if (!fence || Boolean(fence.active_hold)) return { queued: 0, failed: 0, blocked: true as const };
  const items = await db.prepare(`
    SELECT id, target_ref FROM source_deletion_items
    WHERE request_id = ? AND kind = 'external_publish' AND status IN ('awaiting_external','failed')
    ORDER BY created_at
  `).bind(request.id).all<{ id: string; target_ref: string }>();
  let queued = 0;
  let failed = 0;
  for (const item of items.results) {
    const publish = await db.prepare(`
      SELECT id, project_id, channel, external_id, status FROM publish_jobs WHERE id = ? LIMIT 1
    `).bind(item.target_ref).first<{ id: string; project_id: string; channel: string; external_id: string | null; status: string }>();
    if (!publish) {
      await db.prepare(`
        UPDATE source_deletion_items SET status = 'failed', last_error_redacted = 'PUBLISH_RECORD_MISSING', updated_at = ? WHERE id = ?
      `).bind(timestamp, item.id).run();
      failed += 1;
      continue;
    }
    if (publish.status === 'withdrawn') {
      const receiptHash = stableHash({ deletionItemId: item.id, publishJobId: publish.id, outcome: 'already_withdrawn', completedAt: timestamp });
      await db.prepare(`
        UPDATE source_deletion_items SET status = 'confirmed', receipt_hash = ?, receipt_json = ?,
          last_error_redacted = NULL, completed_at = ?, updated_at = ? WHERE id = ?
      `).bind(receiptHash, JSON.stringify({ outcome: 'already_withdrawn', publishJobId: publish.id }), timestamp, timestamp, item.id).run();
      continue;
    }
    if (!publish.external_id) {
      await db.prepare(`
        UPDATE source_deletion_items SET status = 'failed', last_error_redacted = 'EXTERNAL_ID_MISSING', updated_at = ? WHERE id = ?
      `).bind(timestamp, item.id).run();
      failed += 1;
      continue;
    }
    const existing = await db.prepare(`
      SELECT id, status FROM jobs WHERE kind = 'publish' AND idempotency_key = ? LIMIT 1
    `).bind(`legal-delete-external:${request.id}:${publish.id}`).first<{ id: string; status: string }>();
    if (existing?.status === 'dead_letter') {
      await db.prepare(`
        UPDATE source_deletion_items SET status = 'failed', last_error_redacted = 'EXTERNAL_DELETE_FAILED', updated_at = ? WHERE id = ?
      `).bind(timestamp, item.id).run();
      failed += 1;
      continue;
    }
    if (!existing) {
      await db.prepare(`
        INSERT INTO jobs
          (id, kind, project_id, required_capability, payload_schema_version, payload_json,
           status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
        VALUES (?, 'publish', ?, '', 2, ?, 'queued', ?, 0, 5, ?, ?, ?)
      `).bind(
        `job_${crypto.randomUUID()}`, publish.project_id,
        JSON.stringify({
          schemaVersion: 2,
          operation: 'withdraw',
          publishJobId: publish.id,
          channel: publish.channel,
          externalId: publish.external_id,
          reason: request.reason.slice(0, 500),
          deletionRequestId: request.id,
          deletionItemId: item.id,
          legalHoldEpoch: Number(fence.legal_hold_epoch),
        }),
        `legal-delete-external:${request.id}:${publish.id}`, timestamp, timestamp, timestamp,
      ).run();
      queued += 1;
    }
  }
  return { queued, failed, blocked: false as const };
}

function objectValue(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Render Worker 在调用外部平台删除前必须执行的最后一道 fence。
 * job lease 阻止旧 Worker，legal_hold_epoch 阻止 hold 建立前领取的旧执行继续。
 */
export async function authorizeSourceLegalWithdrawal(
  db: SqlDatabase,
  input: { jobId: string; workerId: string; leaseEpoch: number },
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const job = await tx.prepare(`
      SELECT status, lease_owner, lease_epoch, lease_expires_at, kind, payload_json
      FROM jobs WHERE id = ? FOR UPDATE
    `).bind(input.jobId).first<{
      status: string; lease_owner: string | null; lease_epoch: number;
      lease_expires_at: string | null; kind: string; payload_json: unknown;
    }>();
    if (!job || job.kind !== 'publish') {
      return { status: 404 as const, error: '外部撤回作业不存在。', errorCode: 'NOT_FOUND' as const };
    }
    if (!activeLeaseMatches(job, { workerId: input.workerId, leaseEpoch: input.leaseEpoch }, now)) {
      return { status: 409 as const, error: '外部撤回作业租约或 leaseEpoch 已失效。', errorCode: 'LEASE_LOST' as const };
    }
    const payload = objectValue(job.payload_json);
    const deletionRequestId = typeof payload?.deletionRequestId === 'string' ? payload.deletionRequestId : '';
    const deletionItemId = typeof payload?.deletionItemId === 'string' ? payload.deletionItemId : '';
    const legalHoldEpoch = Number(payload?.legalHoldEpoch);
    if (payload?.operation !== 'withdraw' || !deletionRequestId || !deletionItemId || !Number.isInteger(legalHoldEpoch) || legalHoldEpoch < 0) {
      return { status: 409 as const, error: '作业没有绑定完整的依法删除 fence。', errorCode: 'POLICY_DRIFT' as const };
    }
    const deletion = await tx.prepare(`
      SELECT request.source_config_id, request.status AS request_status,
        item.status AS item_status, source.legal_hold_epoch,
        EXISTS (
          SELECT 1 FROM source_legal_holds hold
          WHERE hold.source_config_id = request.source_config_id AND hold.status = 'active'
        ) AS active_hold
      FROM source_deletion_requests request
      JOIN source_deletion_items item ON item.request_id = request.id
      JOIN source_configs source ON source.id = request.source_config_id
      WHERE request.id = ? AND item.id = ? AND item.kind = 'external_publish'
      FOR UPDATE
    `).bind(deletionRequestId, deletionItemId).first<{
      source_config_id: string; request_status: string; item_status: string;
      legal_hold_epoch: number; active_hold: boolean | number;
    }>();
    if (!deletion) {
      return { status: 409 as const, error: '依法删除请求或外部撤回项不匹配。', errorCode: 'POLICY_DRIFT' as const };
    }
    if (Boolean(deletion.active_hold) || deletion.request_status === 'blocked') {
      return { status: 409 as const, error: '存在 active legal hold，外部撤回已阻断。', errorCode: 'LEGAL_HOLD_ACTIVE' as const };
    }
    if (Number(deletion.legal_hold_epoch) !== legalHoldEpoch) {
      return { status: 409 as const, error: 'Legal hold epoch 已变化，必须重新领取作业。', errorCode: 'POLICY_DRIFT' as const };
    }
    if (!['pending', 'deleting', 'awaiting_external'].includes(deletion.request_status) || deletion.item_status !== 'awaiting_external') {
      return { status: 409 as const, error: '依法删除请求或外部撤回项状态不允许执行。', errorCode: 'STATE_CONFLICT' as const };
    }
    return {
      status: 200 as const,
      authorized: true as const,
      sourceId: deletion.source_config_id,
      legalHoldEpoch,
    };
  });
}

export async function requestSourceLegalDeletion(
  db: SqlDatabase,
  input: { sourceId: string; expectedVersion: number; reason: string; idempotencyKey: string; actor: Actor },
  now = new Date(),
) {
  if (!sourceActionAllowed(input.actor, 'source.legal-delete')) {
    return { status: 403 as const, error: '需要有效的来源法律操作权限才能发起依法删除。' };
  }
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const replay = await tx.prepare('SELECT id, status FROM source_deletion_requests WHERE idempotency_key = ? LIMIT 1')
      .bind(input.idempotencyKey).first<{ id: string; status: string }>();
    if (replay) return { status: 200 as const, deletionRequestId: replay.id, deletionStatus: replay.status, replayed: true };
    const source = await tx.prepare('SELECT id, version FROM source_configs WHERE id = ? FOR UPDATE')
      .bind(input.sourceId).first<{ id: string; version: number }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.version !== input.expectedVersion) return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    const hold = await tx.prepare("SELECT id FROM source_legal_holds WHERE source_config_id = ? AND status = 'active' LIMIT 1 FOR UPDATE")
      .bind(source.id).first<{ id: string }>();
    const requestId = `source_delete_${crypto.randomUUID()}`;
    await tx.prepare(`
      INSERT INTO source_deletion_requests
        (id, source_config_id, source_version, idempotency_key, status, reason,
         requested_by, legal_hold_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(requestId, source.id, source.version, input.idempotencyKey, hold ? 'blocked' : 'pending',
      input.reason.slice(0, 2000), input.actor.id, hold?.id ?? null, timestamp, timestamp).run();
    if (!hold) await initializeSourceDeletion(tx, {
      id: requestId,
      reason: input.reason.trim(),
      requestedBy: input.actor.id,
    }, source, timestamp);
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.legal_deletion_requested', 'source_deletion_request', ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, requestId,
      JSON.stringify({ sourceConfigId: source.id, blockedByLegalHold: Boolean(hold) }), crypto.randomUUID(), timestamp).run();
    return {
      status: 202 as const,
      deletionRequestId: requestId,
      deletionStatus: hold ? 'blocked' as const : 'pending' as const,
      ...(hold ? { legalHoldId: hold.id } : {}),
      replayed: false,
    };
  });
}

export async function retrySourceLegalDeletion(
  db: SqlDatabase,
  input: { sourceId: string; deletionRequestId: string; reason: string; actor: Actor },
  now = new Date(),
) {
  if (!sourceActionAllowed(input.actor, 'source.legal-delete')) {
    return { status: 403 as const, error: '需要有效的来源法律操作权限才能重试依法删除。' };
  }
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const request = await tx.prepare(`
      SELECT id, status FROM source_deletion_requests WHERE id = ? AND source_config_id = ? FOR UPDATE
    `).bind(input.deletionRequestId, input.sourceId).first<{ id: string; status: string }>();
    if (!request) return { status: 404 as const, error: '依法删除请求不存在。' };
    if (request.status === 'completed') return { status: 409 as const, error: '依法删除已完成，不能重试。' };
    if (await hasActiveHold(tx, input.sourceId)) return { status: 409 as const, error: '存在 active legal hold，不能重试删除。' };
    const retried = await tx.prepare(`
      UPDATE jobs SET status = 'queued', attempt = 0, lease_owner = NULL, lease_expires_at = NULL,
        available_at = ?, last_error = NULL, updated_at = ?
      WHERE kind = 'publish' AND payload_json ->> 'deletionRequestId' = ? AND status = 'dead_letter'
    `).bind(timestamp, timestamp, request.id).run();
    const resetItems = await tx.prepare(`
      UPDATE source_deletion_items SET status = 'awaiting_external', last_error_redacted = NULL, updated_at = ?
      WHERE request_id = ? AND kind = 'external_publish' AND status = 'failed'
        AND EXISTS (
          SELECT 1 FROM jobs
          WHERE kind = 'publish' AND payload_json ->> 'deletionItemId' = source_deletion_items.id
            AND status IN ('queued','retrying','leased')
        )
    `).bind(timestamp, request.id).run();
    if (!retried.meta.changes && !resetItems.meta.changes) return { status: 409 as const, error: '没有可重试的外部删除作业；请先修复缺失的发布记录或 external ID。' };
    await tx.prepare(`
      UPDATE source_deletion_requests SET status = 'pending', last_error_redacted = NULL,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
    `).bind(timestamp, request.id).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.legal_deletion_retried', 'source_deletion_request', ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, request.id,
      JSON.stringify({ sourceConfigId: input.sourceId, reason: input.reason.slice(0, 500), retriedJobs: retried.meta.changes }), crypto.randomUUID(), timestamp).run();
    return { status: 200 as const, deletionRequestId: request.id, deletionStatus: 'pending' as const, retriedJobs: retried.meta.changes };
  });
}

async function completeDatabaseDeletion(db: SqlDatabase, request: DeletionRequestRow, now: Date) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    if (await hasActiveHold(tx, request.source_config_id)) {
      await tx.prepare("UPDATE source_deletion_requests SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
        .bind(timestamp, request.id).run();
      return { completed: false, blocked: true };
    }
    const articleRows = await tx.prepare("SELECT target_ref FROM source_deletion_items WHERE request_id = ? AND kind = 'normalized_article'")
      .bind(request.id).all<{ target_ref: string }>();
    const projectRows = await tx.prepare("SELECT target_ref FROM source_deletion_items WHERE request_id = ? AND kind = 'derived_project'")
      .bind(request.id).all<{ target_ref: string }>();
    const articleIds = articleRows.results.map((row) => row.target_ref);
    const projectIds = projectRows.results.map((row) => row.target_ref);
    for (const projectId of projectIds) {
      await tx.prepare('DELETE FROM metric_snapshots WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM content_incidents WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM approvals WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM qc_reports WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM render_snapshots WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM caption_tracks WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM voice_tracks WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM assets WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM publish_jobs WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM script_versions WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM storyboard_versions WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM research_snapshots WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM evidence_links WHERE claim_id IN (SELECT id FROM claims WHERE project_id = ?)').bind(projectId).run();
      await tx.prepare('DELETE FROM claims WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM project_experiment_assignments WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM jobs WHERE project_id = ?').bind(projectId).run();
      await tx.prepare('DELETE FROM content_projects WHERE id = ?').bind(projectId).run();
    }
    for (const articleId of articleIds) {
      const shared = await tx.prepare(`
        SELECT id FROM source_item_origins WHERE article_id = ? AND source_config_id <> ? AND deleted_at IS NULL LIMIT 1
      `).bind(articleId, request.source_config_id).first();
      if (!shared) {
        const topicRows = await tx.prepare('SELECT topic_id FROM topic_articles WHERE article_id = ?')
          .bind(articleId).all<{ topic_id: string }>();
        await tx.prepare('DELETE FROM topic_articles WHERE article_id = ?').bind(articleId).run();
        await tx.prepare('DELETE FROM evidence_links WHERE article_id = ?').bind(articleId).run();
        await tx.prepare('DELETE FROM article_revisions WHERE article_id = ?').bind(articleId).run();
        await tx.prepare('DELETE FROM articles WHERE id = ?').bind(articleId).run();
        for (const topic of topicRows.results) await tx.prepare(`
          DELETE FROM topics WHERE id = ? AND NOT EXISTS (SELECT 1 FROM topic_articles WHERE topic_id = ?)
        `).bind(topic.topic_id, topic.topic_id).run();
      }
    }
    await tx.prepare(`
      DELETE FROM source_origin_corrections
      WHERE origin_id IN (SELECT id FROM source_item_origins WHERE source_config_id = ?)
    `).bind(request.source_config_id).run();
    await tx.prepare('DELETE FROM source_item_origins WHERE source_config_id = ?').bind(request.source_config_id).run();
    await tx.prepare('DELETE FROM source_item_event_states WHERE source_config_id = ?').bind(request.source_config_id).run();
    await tx.prepare('DELETE FROM source_item_rejections WHERE ingestion_run_id IN (SELECT id FROM ingestion_runs WHERE source_config_id = ?)').bind(request.source_config_id).run();
    await tx.prepare('DELETE FROM ingestion_pages WHERE ingestion_run_id IN (SELECT id FROM ingestion_runs WHERE source_config_id = ?)').bind(request.source_config_id).run();
    await tx.prepare("UPDATE ingestion_runs SET checkpoint_before = NULL, checkpoint_after = NULL, checkpoint_before_json = '{}', checkpoint_after_json = '{}', result_json = '{}', error_json = NULL WHERE source_config_id = ?")
      .bind(request.source_config_id).run();
    await tx.prepare('DELETE FROM raw_payload_uploads WHERE source_config_id = ?').bind(request.source_config_id).run();
    await tx.prepare('DELETE FROM source_connection_tests WHERE source_config_id = ?').bind(request.source_config_id).run();
    await tx.prepare('DELETE FROM source_checkpoint_cutovers WHERE source_config_id = ?').bind(request.source_config_id).run();
    await tx.prepare(`
      UPDATE source_configs SET name = '[deleted]', config_json = '{}', locator_json = '{}', locator_hash = '',
        collection_policy_json = '{}', capabilities_json = '{}',
        checkpoint = NULL, checkpoint_json = '{}', backfill_checkpoint_json = '{}', active_run_id = NULL,
        enabled = 0, lifecycle_status = 'archived', health_status = 'paused', archived_at = ?,
        last_error = NULL, last_error_detail_redacted = NULL, updated_at = ? WHERE id = ?
    `).bind(timestamp, timestamp, request.source_config_id).run();
    await tx.prepare("UPDATE source_deletion_items SET status = 'deleted', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE request_id = ? AND kind IN ('normalized_article','derived_project')")
      .bind(timestamp, timestamp, request.id).run();
    await tx.prepare("UPDATE source_deletion_items SET object_key = NULL WHERE request_id = ? AND kind IN ('raw_object','project_object')")
      .bind(request.id).run();
    const counts = await tx.prepare('SELECT kind, status, COUNT(*) AS total FROM source_deletion_items WHERE request_id = ? GROUP BY kind, status')
      .bind(request.id).all<{ kind: string; status: string; total: number }>();
    const summary = { sourceConfigId: request.source_config_id, items: counts.results };
    const receiptHash = stableHash({ requestId: request.id, summary, completedAt: timestamp });
    await tx.prepare(`
      UPDATE source_deletion_requests SET status = 'completed', summary_json = ?, receipt_hash = ?,
        lease_owner = NULL, lease_expires_at = NULL, last_error_redacted = NULL,
        completed_at = ?, updated_at = ? WHERE id = ?
    `).bind(JSON.stringify(summary), receiptHash, timestamp, timestamp, request.id).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
      VALUES (?, 'source-deletion', 'admin', 'source.legal_deletion_completed',
        'source_deletion_request', ?, ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, request.id, receiptHash,
      JSON.stringify({ sourceConfigId: request.source_config_id, receiptHash }), crypto.randomUUID(), timestamp).run();
    return { completed: true, blocked: false, receiptHash };
  });
}

export async function processSourceLegalDeletions(
  db: SqlDatabase,
  storage: ObjectStorage,
  now = new Date(),
  options: { workerId?: string; maxObjects?: number } = {},
) {
  const timestamp = now.toISOString();
  const leaseExpiresAt = new Date(now.valueOf() + 5 * 60_000).toISOString();
  const workerId = options.workerId ?? 'source-deletion';
  const request = await db.transaction(async (tx) => {
    const row = await tx.prepare(`
      SELECT r.id, r.source_config_id, r.status, r.reason, r.requested_by, r.initialized_at
      FROM source_deletion_requests r
      WHERE (r.status IN ('pending','deleting','awaiting_external')
          OR (r.status = 'failed' AND COALESCE(r.last_error_redacted, '') <> 'EXTERNAL_DELETE_FAILED'))
        AND (r.lease_expires_at IS NULL OR r.lease_expires_at <= ?)
        AND NOT EXISTS (SELECT 1 FROM source_legal_holds h WHERE h.source_config_id = r.source_config_id AND h.status = 'active')
      ORDER BY r.created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    `).bind(timestamp).first<DeletionRequestRow>();
    if (!row) return null;
    await tx.prepare("UPDATE source_deletion_requests SET status = 'deleting', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .bind(workerId, leaseExpiresAt, timestamp, row.id).run();
    return row;
  });
  if (!request) return { processed: false };
  if (!request.initialized_at) {
    const initialized = await db.transaction(async (tx) => {
      const current = await tx.prepare(`
        SELECT id, source_config_id, status, reason, requested_by, initialized_at
        FROM source_deletion_requests WHERE id = ? FOR UPDATE
      `).bind(request.id).first<DeletionRequestRow>();
      if (!current || current.initialized_at) return { initialized: Boolean(current?.initialized_at), blocked: false };
      if (await hasActiveHold(tx, current.source_config_id)) {
        await tx.prepare("UPDATE source_deletion_requests SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
          .bind(timestamp, current.id).run();
        return { initialized: false, blocked: true };
      }
      const source = await tx.prepare('SELECT id, version FROM source_configs WHERE id = ? FOR UPDATE')
        .bind(current.source_config_id).first<SourceVersionRow>();
      if (!source) throw new Error('SOURCE_NOT_FOUND');
      await initializeSourceDeletion(tx, {
        id: current.id,
        reason: current.reason,
        requestedBy: current.requested_by,
      }, source, timestamp);
      return { initialized: true, blocked: false };
    });
    if (initialized.blocked) return { processed: true, blocked: true, deletedObjects: 0, failedObjects: 0, apiCalls: 0 };
  }
  const objects = await db.prepare(`
    SELECT id, object_key FROM source_deletion_items
    WHERE request_id = ? AND kind IN ('raw_object','project_object')
      AND (status IN ('pending','failed') OR (status = 'deleting' AND lease_expires_at <= ?))
    ORDER BY created_at LIMIT ?
  `).bind(request.id, timestamp, Math.min(100, options.maxObjects ?? 100)).all<{ id: string; object_key: string }>();
  let deletedObjects = 0;
  let failedObjects = 0;
  for (const item of objects.results) {
    // source row lock 是 legal hold 的线性化边界：创建 hold 使用同一把锁，
    // 因而不能在“检查通过”与真正的对象删除之间插入一个已生效 hold。
    const outcome = await db.transaction(async (tx) => {
      const source = await tx.prepare('SELECT id FROM source_configs WHERE id = ? FOR UPDATE')
        .bind(request.source_config_id).first<{ id: string }>();
      if (!source || await hasActiveHold(tx, request.source_config_id)) {
        await tx.prepare("UPDATE source_deletion_requests SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
          .bind(timestamp, request.id).run();
        return 'blocked' as const;
      }
      const current = await tx.prepare(`
        SELECT status, lease_expires_at FROM source_deletion_items
        WHERE id = ? AND request_id = ? FOR UPDATE
      `).bind(item.id, request.id).first<{ status: string; lease_expires_at: string | null }>();
      if (!current || !(
        ['pending', 'failed'].includes(current.status) ||
        (current.status === 'deleting' && Boolean(current.lease_expires_at) && current.lease_expires_at! <= timestamp)
      )) return 'skipped' as const;
      await tx.prepare("UPDATE source_deletion_items SET status = 'deleting', attempts = attempts + 1, lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .bind(leaseExpiresAt, timestamp, item.id).run();
      try {
        await storage.delete(item.object_key);
        const receiptHash = stableHash({ itemId: item.id, objectKeyHash: stableHash(item.object_key), deletedAt: timestamp });
        await tx.prepare(`
          UPDATE source_deletion_items SET status = 'deleted', receipt_hash = ?, receipt_json = ?,
            last_error_redacted = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?
        `).bind(receiptHash, JSON.stringify({ provider: 'object-storage', outcome: 'deleted', objectKeyHash: stableHash(item.object_key) }), timestamp, timestamp, item.id).run();
        return 'deleted' as const;
      } catch {
        await tx.prepare("UPDATE source_deletion_items SET status = 'failed', last_error_redacted = 'OBJECT_DELETE_FAILED', lease_expires_at = NULL, updated_at = ? WHERE id = ?")
          .bind(timestamp, item.id).run();
        return 'failed' as const;
      }
    });
    if (outcome === 'blocked') {
      return { processed: true, blocked: true, deletedObjects, failedObjects, apiCalls: deletedObjects + failedObjects };
    }
    if (outcome === 'deleted') deletedObjects += 1;
    if (outcome === 'failed') failedObjects += 1;
  }
  if (await hasActiveHold(db, request.source_config_id)) {
    await db.prepare("UPDATE source_deletion_requests SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, request.id).run();
    return { processed: true, blocked: true, deletedObjects, failedObjects, apiCalls: deletedObjects + failedObjects };
  }
  const remainingObjects = await db.prepare("SELECT id FROM source_deletion_items WHERE request_id = ? AND kind IN ('raw_object','project_object') AND status NOT IN ('deleted','skipped') LIMIT 1")
    .bind(request.id).first();
  if (remainingObjects) {
    await db.prepare("UPDATE source_deletion_requests SET status = ?, lease_owner = NULL, lease_expires_at = NULL, last_error_redacted = ?, updated_at = ? WHERE id = ?")
      .bind(failedObjects ? 'failed' : 'pending', failedObjects ? 'OBJECT_DELETE_FAILED' : null, timestamp, request.id).run();
    return { processed: true, completed: false, deletedObjects, failedObjects, apiCalls: deletedObjects + failedObjects };
  }
  const externalJobs = await ensureExternalWithdrawalJobs(db, request, timestamp);
  if (externalJobs.blocked) {
    await db.prepare("UPDATE source_deletion_requests SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, request.id).run();
    return { processed: true, blocked: true, deletedObjects, failedObjects, apiCalls: deletedObjects + failedObjects };
  }
  if (externalJobs.failed) {
    await db.prepare("UPDATE source_deletion_requests SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, last_error_redacted = 'EXTERNAL_DELETE_FAILED', updated_at = ? WHERE id = ?")
      .bind(timestamp, request.id).run();
    return { processed: true, completed: false, deletedObjects, failedObjects, failedExternal: externalJobs.failed, apiCalls: deletedObjects + failedObjects };
  }
  const external = await db.prepare("SELECT id, status FROM source_deletion_items WHERE request_id = ? AND kind = 'external_publish' AND status NOT IN ('confirmed','skipped') LIMIT 1")
    .bind(request.id).first<{ id: string; status: string }>();
  if (external) {
    await db.prepare("UPDATE source_deletion_requests SET status = 'awaiting_external', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, request.id).run();
    return { processed: true, completed: false, awaitingExternal: true, queuedExternal: externalJobs.queued, deletedObjects, failedObjects, apiCalls: deletedObjects + failedObjects };
  }
  const completed = await completeDatabaseDeletion(db, request, now);
  return { processed: true, deletedObjects, failedObjects, apiCalls: deletedObjects + failedObjects, ...completed };
}
