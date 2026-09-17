import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import {
  assertPublicHttpUrl,
  normalizeSourceRuntimeConfig,
  sourceLocatorForConfig,
  validateSourceConfig,
  type SourceConfigInput,
} from '@/lib/source-adapters';
import {
  platformForAdapter,
  sourceConnectorByPlatform,
} from '@/lib/source-connectors/registry';
import { stableHash } from '@/lib/workflow';
import { parseSourceBillingPolicy } from '@/lib/source-budget';
import { parseSourceSchedulePolicy } from '@/lib/source-schedule-throttle';
import { validateSourceOwnershipMembers } from '@/lib/source-ownership';
import { projectPublicSourceRecord } from '@/lib/source-public-projection';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { createPendingSourceRightsRequest } from '@/lib/source-rights-approval';
import { STALLED_LEASE_SECONDS } from '@/lib/workers';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.read'))
    return sourceApiError('用户未加入 Signal 40 团队。', 403);
  const result = await db
    .prepare(`
    SELECT id, name, adapter, platform, team_id, owner_team_id,
      business_owner_id, publisher_entity_id,
      config_json, lifecycle_status, health_status, rights_status,
      rate_limit_per_minute, cost_micros_per_request, estimated_requests_per_run,
      monthly_budget_micros, budget_soft_limit_percent,
      schedule_priority, auto_throttle_enabled, effective_schedule_multiplier,
      schedule_throttle_reason, schedule_throttle_recovery_at,
      retention_mode, retention_days, enabled, version,
      schedule_cron, checkpoint_version,
      next_run_at, retry_after, backoff_until, last_attempt_at, last_success_at,
      last_healthy_at, last_tested_at, last_error_code,
      consecutive_failures, active_run_id,
      -- 正在跑的采集是不是已经掉线：作业还挂着租约，但执行侧很久没有续约了。
      (SELECT CASE WHEN job.updated_at <= ? THEN 1 ELSE 0 END
        FROM ingestion_runs run JOIN jobs job ON job.id = run.job_id
        WHERE run.id = source_configs.active_run_id AND job.status = 'leased' LIMIT 1
      ) AS active_run_stalled,
      -- 租约到期时间：停滞的作业到这个点会被重新领取，界面据此告诉用户什么时候自动重试。
      (SELECT job.lease_expires_at
        FROM ingestion_runs run JOIN jobs job ON job.id = run.job_id
        WHERE run.id = source_configs.active_run_id AND job.status = 'leased' LIMIT 1
      ) AS active_run_retry_at,
      -- 连接测试绑定的是当时的配置：改过配置之后，旧的测试结果对不上当前 config_hash。
      CASE WHEN last_tested_config_hash IS NOT NULL AND last_tested_config_hash = config_hash
        THEN 1 ELSE 0 END AS tested_current_config,
      (SELECT status FROM source_deletion_requests dr WHERE dr.source_config_id = source_configs.id AND dr.status <> 'completed' ORDER BY dr.created_at DESC LIMIT 1) AS deletion_status,
      (SELECT id FROM source_deletion_requests dr WHERE dr.source_config_id = source_configs.id AND dr.status <> 'completed' ORDER BY dr.created_at DESC LIMIT 1) AS deletion_request_id,
      (SELECT id FROM source_rights_requests rr WHERE rr.source_config_id = source_configs.id AND rr.status = 'pending' ORDER BY rr.created_at DESC LIMIT 1) AS pending_rights_request_id,
      (SELECT requested_by FROM source_rights_requests rr WHERE rr.source_config_id = source_configs.id AND rr.status = 'pending' ORDER BY rr.created_at DESC LIMIT 1) AS pending_rights_requested_by,
      -- 没有采集运行、内容归属、原始载荷、未解除保全和既有删除请求，才是「删掉不销毁任何证据」。
      CASE WHEN enabled = 0
        AND NOT EXISTS (SELECT 1 FROM ingestion_runs ir WHERE ir.source_config_id = source_configs.id)
        AND NOT EXISTS (SELECT 1 FROM source_item_origins so WHERE so.source_config_id = source_configs.id)
        AND NOT EXISTS (SELECT 1 FROM raw_payload_uploads rp WHERE rp.source_config_id = source_configs.id)
        AND NOT EXISTS (SELECT 1 FROM source_legal_holds lh WHERE lh.source_config_id = source_configs.id AND lh.released_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM source_deletion_requests dq WHERE dq.source_config_id = source_configs.id)
      THEN 1 ELSE 0 END AS hard_deletable,
      created_at, updated_at
    FROM source_configs WHERE lifecycle_status != 'archived' ORDER BY name
  `)
    .bind(new Date(Date.now() - STALLED_LEASE_SECONDS * 1000).toISOString())
    .all();
  return Response.json({
    sources: result.results.map((row) =>
      projectPublicSourceRecord(row as Record<string, unknown>),
    ),
  });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.create'))
    return sourceApiError('只有管理员可以登记来源授权。', 403);
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey)
    return sourceApiError('Idempotency-Key 必填。', 400);
  let input: SourceConfigInput & {
    platform?: string;
    publicUseConfirmed?: boolean;
    billingPolicy?: unknown;
    schedulePolicy?: unknown;
    businessOwnerId?: string;
    publisherEntityId?: string | null;
  };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  const validation = validateSourceConfig({ ...input, namespace: input.platform }, false);
  if (!validation.valid)
    return sourceApiError('来源配置无效。', 422, { issues: validation.errors });
  const billing = parseSourceBillingPolicy(input.billingPolicy);
  if (billing.error)
    return sourceApiError(billing.error, 422);
  const schedulePolicy = parseSourceSchedulePolicy(input.schedulePolicy);
  if (schedulePolicy.error)
    return sourceApiError(schedulePolicy.error, 422);
  if (!input.publicUseConfirmed) {
    return sourceApiError('必须提交对该公开来源的 provisional 使用权声明。', 422);
  }
  if (input.rightsStatus !== 'pending') {
    return sourceApiError('新来源只能以 rightsStatus=pending 创建；批准必须由独立权利审批者完成。', 422);
  }
  const ownership = await validateSourceOwnershipMembers(db, {
    businessOwnerId: input.businessOwnerId ?? actor!.id,
  });
  if ('error' in ownership) {
    return sourceApiError(ownership.error ?? '来源维护责任无效。', 422);
  }
  const publisherEntityId = input.publisherEntityId?.trim() || null;
  if (publisherEntityId) {
    const publisher = await db.prepare('SELECT id FROM publisher_entities WHERE id = ? LIMIT 1')
      .bind(publisherEntityId).first<{ id: string }>();
    if (!publisher) return sourceApiError('publisher entity 不存在。', 422);
  }

  if (input.adapter === 'social' && !input.platform) {
    return sourceApiError('社交来源必须明确选择微信公众号或小红书平台。', 422);
  }
  const platform = input.platform ?? platformForAdapter(input.adapter);
  const connector = sourceConnectorByPlatform(platform);
  if (!connector || connector.adapter !== input.adapter) {
    return sourceApiError('平台与适配器不匹配。', 422);
  }
  if (connector.availability !== 'available') {
    return sourceApiError(connector.unavailableReason ?? '该平台暂不可用。', 409, {
      errorCode: 'CONNECTOR_UNAVAILABLE',
    });
  }

  const id = `source_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const normalizedUrl = input.url ? assertPublicHttpUrl(input.url) : '';
  const normalizedInput = { ...input, namespace: platform };
  const config = normalizeSourceRuntimeConfig(normalizedInput);
  const configHash = stableHash({ platform, adapter: input.adapter, config });
  const locator = sourceLocatorForConfig(normalizedInput);
  const locatorHash = stableHash({ teamId: 'default', platform, locator });
  const rateLimitPerMinute = input.rateLimitPerMinute ?? 30;
  const retention = input.retention ?? { mode: 'metadata' as const, days: 30 };
  const rightsConfigHash = stableHash({
    platform,
    adapter: input.adapter,
    config,
    retention,
    publisherEntityId,
  });
  const collectionPolicy = {
    scheduleCron: input.scheduleCron ?? null,
    mode: 'standard',
    maxItems: 100,
  };

  const result = await db.transaction(async (tx) => {
    const replay = await tx
      .prepare(
        "SELECT entity_id, metadata_json ->> 'rightsRequestId' AS rights_request_id FROM audit_events WHERE action = 'source.created' AND metadata_json ->> 'idempotencyKey' = ? LIMIT 1",
      )
      .bind(idempotencyKey)
      .first<{ entity_id: string; rights_request_id: string | null }>();
    if (replay) return { id: replay.entity_id, rightsRequestId: replay.rights_request_id, replayed: true };
    const duplicate = await tx
      .prepare(`
      SELECT id FROM source_configs
      WHERE team_id = ? AND platform = ?
        AND (locator_hash = ? OR (? <> '' AND locator_json ->> 'url' = ?))
      LIMIT 1
    `)
      .bind('default', platform, locatorHash, normalizedUrl, normalizedUrl)
      .first<{ id: string }>();
    if (duplicate) return { id: duplicate.id, duplicate: true };

    await tx
      .prepare(`
      INSERT INTO source_configs
        (id, team_id, owner_team_id, business_owner_id,
         name, adapter, platform, config_json, locator_json, locator_hash,
         collection_policy_json, capabilities_json, lifecycle_status, health_status,
         config_hash, rights_config_hash, source_type, publisher_entity_id, rights_status, rate_limit_per_minute, retention_mode,
         retention_days, cost_micros_per_request, estimated_requests_per_run,
         monthly_budget_micros, budget_soft_limit_percent,
         schedule_priority, auto_throttle_enabled,
         enabled, version, schedule_cron, created_at, updated_at)
      VALUES (?, 'default', 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'unknown', ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
    `)
      .bind(
        id,
        ownership.assignment.businessOwnerId,
        input.name.trim(),
        input.adapter,
        platform,
        JSON.stringify(config),
        JSON.stringify(locator),
        locatorHash,
        JSON.stringify(collectionPolicy),
        JSON.stringify(connector.supports),
        configHash,
        rightsConfigHash,
        input.sourceType,
        publisherEntityId,
        rateLimitPerMinute,
        retention.mode,
        retention.days,
        billing.policy.costMicrosPerRequest,
        billing.policy.estimatedRequestsPerRun,
        billing.policy.monthlyBudgetMicros,
        billing.policy.softLimitPercent,
        schedulePolicy.policy.schedulePriority,
        schedulePolicy.policy.autoThrottleEnabled ? 1 : 0,
        input.scheduleCron ?? null,
        now,
        now,
      )
      .run();
    const rightsRequest = await createPendingSourceRightsRequest(tx, {
      sourceConfigId: id,
      requestedBy: actor!.id,
      assertionRef: `provisional:${stableHash({ idempotencyKey, platform, locatorHash })}`,
      sourceVersion: 1,
      rightsConfigHash,
      idempotencyKey: `source-create:${idempotencyKey}`,
    }, new Date(now));
    await tx
      .prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, after_hash,
         metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.created', 'source_config', ?, ?, ?, ?, ?)
    `)
      .bind(
        `audit_${crypto.randomUUID()}`,
        actor!.id,
        actor!.role,
        id,
        configHash,
        JSON.stringify({
          idempotencyKey,
          platform,
          lifecycleStatus: 'draft',
          publicUseConfirmed: true,
          rightsRequestId: rightsRequest.id,
          billingPolicy: billing.policy,
          schedulePolicy: schedulePolicy.policy,
          ownership: ownership.assignment,
        }),
        crypto.randomUUID(),
        now,
      )
      .run();
    return { id, rightsRequestId: rightsRequest.id, replayed: false };
  });
  if ('duplicate' in result) {
    return sourceApiError('该来源已经存在。', 409, {
      errorCode: 'STATE_CONFLICT',
      sourceId: result.id,
    });
  }
  if (result.replayed)
    return Response.json(
      { sourceId: result.id, rightsRequestId: result.rightsRequestId, replayed: true },
      { status: 200 },
    );
  return Response.json(
    {
      source: {
        id,
        lifecycleStatus: 'draft',
        enabled: false,
        version: 1,
        rightsStatus: 'pending',
        rightsRequestId: result.rightsRequestId,
      },
    },
    { status: 201 },
  );
}
