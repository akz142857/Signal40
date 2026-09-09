import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import {
  assertPublicHttpUrl,
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

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.read'))
    return sourceApiError('用户未加入 Signal 40 团队。', 403);
  const result = await db
    .prepare(`
    SELECT id, name, adapter, platform, team_id, owner_team_id,
      business_owner_id, credential_steward_id, backup_admin_id,
      config_json, lifecycle_status, health_status, rights_status,
      rate_limit_per_minute, cost_micros_per_request, estimated_requests_per_run,
      monthly_budget_micros, budget_soft_limit_percent,
      schedule_priority, auto_throttle_enabled, effective_schedule_multiplier,
      schedule_throttle_reason, schedule_throttle_recovery_at,
      retention_mode, retention_days, enabled, version,
      credential_ref, credential_version,
      schedule_cron, checkpoint_version,
      next_run_at, retry_after, backoff_until, last_attempt_at, last_success_at,
      last_healthy_at, last_tested_at, last_error_code,
      consecutive_failures, active_run_id,
      (SELECT status FROM source_deletion_requests dr WHERE dr.source_config_id = source_configs.id AND dr.status <> 'completed' ORDER BY dr.created_at DESC LIMIT 1) AS deletion_status,
      (SELECT id FROM source_deletion_requests dr WHERE dr.source_config_id = source_configs.id AND dr.status <> 'completed' ORDER BY dr.created_at DESC LIMIT 1) AS deletion_request_id,
      (SELECT id FROM source_rights_requests rr WHERE rr.source_config_id = source_configs.id AND rr.status = 'pending' ORDER BY rr.created_at DESC LIMIT 1) AS pending_rights_request_id,
      (SELECT requested_by FROM source_rights_requests rr WHERE rr.source_config_id = source_configs.id AND rr.status = 'pending' ORDER BY rr.created_at DESC LIMIT 1) AS pending_rights_requested_by,
      created_at, updated_at
    FROM source_configs WHERE lifecycle_status != 'archived' ORDER BY name
  `)
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
    credentialStewardId?: string;
    backupAdminId?: string | null;
  };
  try {
    input = (await request.json()) as typeof input;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  const validation = validateSourceConfig(input, false);
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
    credentialStewardId: input.credentialStewardId ?? actor!.id,
    backupAdminId: input.backupAdminId,
  });
  if ('error' in ownership) {
    return sourceApiError(ownership.error ?? '来源维护责任无效。', 422);
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
  const config = {
    sourceType: input.sourceType,
    url: normalizedUrl,
    mapping: input.mapping ?? {},
    pagination:
      input.adapter === 'http'
        ? (input.pagination ?? { mode: 'none' as const })
        : undefined,
  };
  const configHash = stableHash({
    platform,
    adapter: input.adapter,
    config,
    credentialVersion: 0,
  });
  const locator = { kind: 'url', url: normalizedUrl };
  const locatorHash = stableHash({ teamId: 'default', platform, locator });
  const rateLimitPerMinute = input.rateLimitPerMinute ?? 30;
  const retention = input.retention ?? { mode: 'metadata' as const, days: 30 };
  const rightsConfigHash = stableHash({
    platform,
    adapter: input.adapter,
    config,
    retention,
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
        AND (locator_hash = ? OR locator_json ->> 'url' = ?)
      LIMIT 1
    `)
      .bind('default', platform, locatorHash, normalizedUrl)
      .first<{ id: string }>();
    if (duplicate) return { id: duplicate.id, duplicate: true };

    await tx
      .prepare(`
      INSERT INTO source_configs
        (id, team_id, owner_team_id, business_owner_id, credential_steward_id,
         backup_admin_id, name, adapter, platform, config_json, locator_json, locator_hash,
         collection_policy_json, capabilities_json, lifecycle_status, health_status,
         config_hash, rights_config_hash, source_type, rights_status, rate_limit_per_minute, retention_mode,
         retention_days, cost_micros_per_request, estimated_requests_per_run,
         monthly_budget_micros, budget_soft_limit_percent,
         schedule_priority, auto_throttle_enabled,
         enabled, version, schedule_cron, created_at, updated_at)
      VALUES (?, 'default', 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'unknown', ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
    `)
      .bind(
        id,
        ownership.assignment.businessOwnerId,
        ownership.assignment.credentialStewardId,
        ownership.assignment.backupAdminId,
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
