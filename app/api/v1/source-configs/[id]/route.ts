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
import { projectPublicSourceRecord } from '@/lib/source-public-projection';
import { sourceActionAllowed } from '@/lib/source-authorization';
import { createPendingSourceRightsRequest } from '@/lib/source-rights-approval';
import { openManualSourceSloExclusion } from '@/lib/source-slo-exclusions';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!sourceActionAllowed(await resolveRequestActor(request), 'source.read')) {
    return sourceApiError('无权读取来源。', 403);
  }
  const { id } = await context.params;
  const source = await db
    .prepare(`
    SELECT id, name, adapter, platform, team_id, owner_team_id,
      business_owner_id, credential_steward_id, backup_admin_id,
      config_json, lifecycle_status, health_status, rights_status,
      rate_limit_per_minute, retention_mode,
      cost_micros_per_request, estimated_requests_per_run, monthly_budget_micros,
      budget_soft_limit_percent,
      schedule_priority, auto_throttle_enabled, effective_schedule_multiplier,
      schedule_throttle_reason, schedule_throttle_recovery_at,
      retention_days, enabled, version, schedule_cron, checkpoint_version,
      credential_ref, credential_version, next_run_at, last_success_at,
      last_tested_at, last_error_code, consecutive_failures, active_run_id,
      (SELECT status FROM source_deletion_requests dr WHERE dr.source_config_id = source_configs.id AND dr.status <> 'completed' ORDER BY dr.created_at DESC LIMIT 1) AS deletion_status,
      (SELECT id FROM source_deletion_requests dr WHERE dr.source_config_id = source_configs.id AND dr.status <> 'completed' ORDER BY dr.created_at DESC LIMIT 1) AS deletion_request_id,
      (SELECT id FROM source_rights_requests rr WHERE rr.source_config_id = source_configs.id AND rr.status = 'pending' ORDER BY rr.created_at DESC LIMIT 1) AS pending_rights_request_id,
      (SELECT requested_by FROM source_rights_requests rr WHERE rr.source_config_id = source_configs.id AND rr.status = 'pending' ORDER BY rr.created_at DESC LIMIT 1) AS pending_rights_requested_by,
      created_at, updated_at
    FROM source_configs WHERE id = ? LIMIT 1
  `)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!source) return sourceApiError('来源不存在。', 404);
  return Response.json({ source: projectPublicSourceRecord(source) });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.update'))
    return sourceApiError('只有管理员可以修改来源授权与调度。', 403);
  let body: SourceConfigInput & {
    expectedVersion?: number;
    enabled?: boolean;
    platform?: string;
    publicUseConfirmed?: boolean;
    billingPolicy?: unknown;
    schedulePolicy?: unknown;
    pauseReason?: string;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (
    !Number.isInteger(body.expectedVersion) ||
    Number(body.expectedVersion) < 1 ||
    typeof body.enabled !== 'boolean'
  ) {
    return sourceApiError('expectedVersion 和 enabled 必填。', 422);
  }
  const expectedVersion = Number(body.expectedVersion);
  if (body.enabled) {
    return sourceApiError('启用来源必须使用测试门禁后的 enable 操作。', 409);
  }
  const validation = validateSourceConfig(body, false);
  if (!validation.valid)
    return sourceApiError('来源配置无效。', 422, { issues: validation.errors });
  const platform = body.platform ?? platformForAdapter(body.adapter);
  const connector = sourceConnectorByPlatform(platform);
  if (
    !connector ||
    connector.adapter !== body.adapter ||
    connector.availability !== 'available'
  ) {
    return sourceApiError(connector?.unavailableReason ?? '平台与适配器不匹配或不可用。', 409, {
      errorCode: 'CONNECTOR_UNAVAILABLE',
    });
  }
  const { id } = await context.params;
  const existing = await db
    .prepare(`
    SELECT version, adapter, platform, config_hash, rights_config_hash, last_tested_config_hash, config_json, rights_status,
      rate_limit_per_minute, retention_mode, retention_days, enabled, lifecycle_status,
      cost_micros_per_request, estimated_requests_per_run, monthly_budget_micros,
      budget_soft_limit_percent,
      schedule_priority, auto_throttle_enabled,
      credential_ref, credential_version
    FROM source_configs WHERE id = ? LIMIT 1
  `)
    .bind(id)
    .first<{
      version: number;
      adapter: string;
      platform: string;
      config_hash: string;
      rights_config_hash: string;
      last_tested_config_hash: string | null;
      config_json: unknown;
      rights_status: string;
      rate_limit_per_minute: number;
      retention_mode: string;
      retention_days: number;
      enabled: number;
      lifecycle_status: string;
      cost_micros_per_request: number;
      estimated_requests_per_run: number;
      monthly_budget_micros: number;
      budget_soft_limit_percent: number;
      schedule_priority: number;
      auto_throttle_enabled: number;
      credential_ref: string | null;
      credential_version: number;
    }>();
  if (!existing)
    return sourceApiError('来源不存在。', 404);
  if (existing.lifecycle_status === 'archived')
    return sourceApiError('已归档来源不能修改。', 409);
  if (existing.version !== expectedVersion)
    return sourceApiError(`版本冲突：当前版本为 ${existing.version}。`, 409);
  if (body.rightsStatus !== existing.rights_status) {
    return sourceApiError('rightsStatus 由独立权利决定接口管理，来源修改不能直接改变。', 422);
  }

  const normalizedUrl = body.url ? assertPublicHttpUrl(body.url) : '';
  const nextConfig = {
    sourceType: body.sourceType,
    url: normalizedUrl,
    mapping: body.mapping ?? {},
    pagination:
      body.adapter === 'http'
        ? (body.pagination ?? { mode: 'none' as const })
        : undefined,
  };
  if (existing.credential_ref) {
    if (body.adapter !== existing.adapter || platform !== existing.platform) {
      return sourceApiError('已绑定凭据的来源不能直接切换 adapter/platform；请先撤销凭据。', 409);
    }
    const previous =
      typeof existing.config_json === 'string'
        ? (JSON.parse(existing.config_json) as { url?: unknown })
        : (existing.config_json as { url?: unknown });
    const previousOrigin =
      typeof previous?.url === 'string' ? new URL(previous.url).origin : '';
    if (previousOrigin !== new URL(normalizedUrl).origin) {
      return sourceApiError('已绑定凭据的来源不能直接修改 target origin；请先撤销凭据。', 409);
    }
  }
  const nextConfigHash = stableHash({
    platform,
    adapter: body.adapter,
    config: nextConfig,
    credentialVersion: existing.credential_version,
  });
  const configChanged = nextConfigHash !== existing.config_hash;
  if (
    !configChanged &&
    Boolean(existing.enabled) &&
    (typeof body.pauseReason !== 'string' ||
      body.pauseReason.trim().length < 3 ||
      body.pauseReason.trim().length > 500)
  ) {
    return sourceApiError('主动暂停必须填写 3–500 个字符的原因。', 422);
  }
  const locator = { kind: 'url', url: normalizedUrl };
  const locatorHash = stableHash({ teamId: 'default', platform, locator });
  const rateLimitPerMinute =
    body.rateLimitPerMinute ?? existing.rate_limit_per_minute;
  const retention = body.retention ?? {
    mode: existing.retention_mode as 'metadata' | 'raw',
    days: existing.retention_days,
  };
  const nextRightsConfigHash = stableHash({
    platform,
    adapter: body.adapter,
    config: nextConfig,
    retention,
  });
  const billing = parseSourceBillingPolicy(body.billingPolicy, {
    costMicrosPerRequest: existing.cost_micros_per_request,
    estimatedRequestsPerRun: existing.estimated_requests_per_run,
    monthlyBudgetMicros: Number(existing.monthly_budget_micros),
    softLimitPercent: existing.budget_soft_limit_percent,
  });
  if (billing.error)
    return sourceApiError(billing.error, 422);
  const schedulePolicy = parseSourceSchedulePolicy(body.schedulePolicy, {
    schedulePriority: existing.schedule_priority,
    autoThrottleEnabled: Boolean(existing.auto_throttle_enabled),
  });
  if (schedulePolicy.error)
    return sourceApiError(schedulePolicy.error, 422);
  const grantMustChange = nextRightsConfigHash !== existing.rights_config_hash;
  if (
    grantMustChange &&
    !body.publicUseConfirmed
  ) {
    return sourceApiError('配置或使用范围变化后，必须提交新的 provisional 使用权声明。', 422);
  }
  const now = new Date().toISOString();
  const result = await db.transaction(async (tx) => {
    const currentGrant = await tx
      .prepare(`
      SELECT id, version FROM source_rights_grants
      WHERE source_config_id = ? AND revoked_at IS NULL
      ORDER BY verified_at DESC, id DESC LIMIT 1
      FOR UPDATE
    `)
      .bind(id)
      .first<{ id: string; version: number }>();
    const updated = await tx
      .prepare(`
      UPDATE source_configs SET name = ?, adapter = ?, platform = ?, config_json = ?,
        locator_json = ?, locator_hash = ?, config_hash = ?, rights_config_hash = ?, source_type = ?, rights_status = ?, enabled = 0,
        lifecycle_status = ?, health_status = ?, last_tested_config_hash = ?,
        rate_limit_per_minute = ?, retention_mode = ?, retention_days = ?,
        cost_micros_per_request = ?, estimated_requests_per_run = ?,
        monthly_budget_micros = ?, budget_soft_limit_percent = ?,
        schedule_priority = ?, auto_throttle_enabled = ?,
        effective_schedule_multiplier = 1, schedule_throttle_reason = NULL,
        schedule_throttle_recovery_at = NULL, next_run_at = NULL,
        schedule_cron = ?, collection_policy_json = ?, capabilities_json = ?,
        version = version + 1, last_error = NULL, last_error_code = NULL,
        last_error_detail_redacted = NULL, updated_at = ?
      WHERE id = ? AND version = ?
    `)
      .bind(
        body.name.trim(),
        body.adapter,
        platform,
        JSON.stringify(nextConfig),
        JSON.stringify(locator),
        locatorHash,
        nextConfigHash,
        nextRightsConfigHash,
        body.sourceType,
        grantMustChange ? 'pending' : existing.rights_status,
        configChanged ? 'draft' : 'paused',
        configChanged ? 'unknown' : 'paused',
        configChanged ? null : existing.last_tested_config_hash,
        rateLimitPerMinute,
        retention.mode,
        retention.days,
        billing.policy.costMicrosPerRequest,
        billing.policy.estimatedRequestsPerRun,
        billing.policy.monthlyBudgetMicros,
        billing.policy.softLimitPercent,
        schedulePolicy.policy.schedulePriority,
        schedulePolicy.policy.autoThrottleEnabled ? 1 : 0,
        body.scheduleCron ?? null,
        JSON.stringify({
          scheduleCron: body.scheduleCron ?? null,
          mode: 'standard',
          maxItems: 100,
        }),
        JSON.stringify(connector.supports),
        now,
        id,
        expectedVersion,
      )
      .run();
    if (!updated.meta.changes) return { conflict: true as const };

    if (!configChanged && Boolean(existing.enabled)) {
      await openManualSourceSloExclusion(
        tx,
        {
          sourceId: id,
          reason: body.pauseReason ?? '',
          actor: actor!,
        },
        new Date(now),
      );
    }

    let rightsGrantId = currentGrant?.id ?? null;
    let rightsRequestId: string | null = null;
    if (grantMustChange && currentGrant) {
      await tx
        .prepare(`
        UPDATE source_rights_grants SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL
      `)
        .bind(now, currentGrant.id)
        .run();
      rightsGrantId = null;
    }
    if (grantMustChange) {
      const request = await createPendingSourceRightsRequest(tx, {
        sourceConfigId: id,
        requestedBy: actor!.id,
        assertionRef: `provisional:${stableHash({ sourceConfigId: id, sourceVersion: expectedVersion + 1, rightsConfigHash: nextRightsConfigHash })}`,
        sourceVersion: expectedVersion + 1,
        rightsConfigHash: nextRightsConfigHash,
        idempotencyKey: `source-update:${expectedVersion + 1}:${nextRightsConfigHash}`,
      }, new Date(now));
      rightsRequestId = request.id;
    }
    await tx
      .prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         after_hash, metadata_json, request_id, created_at)
      SELECT ?, ?, ?, 'source.updated', 'source_config', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM source_configs WHERE id = ? AND version = ? AND updated_at = ?)
    `)
      .bind(
        `audit_${crypto.randomUUID()}`,
        actor!.id,
        actor!.role,
        id,
        existing.config_hash,
        nextConfigHash,
        JSON.stringify({
          disabled: true,
          configChanged,
          grantMustChange,
          rightsStatus: grantMustChange ? 'pending' : existing.rights_status,
          rightsGrantId,
          rightsRequestId,
          billingPolicy: billing.policy,
          schedulePolicy: schedulePolicy.policy,
          pauseReason:
            !configChanged && Boolean(existing.enabled)
              ? body.pauseReason?.trim()
              : undefined,
        }),
        crypto.randomUUID(),
        now,
        id,
        expectedVersion + 1,
        now,
      )
      .run();
    return { conflict: false as const, rightsGrantId, rightsRequestId };
  });
  if (result.conflict)
    return sourceApiError('来源已被其他管理员修改。', 409);
  return Response.json({
    source: {
      id,
      enabled: false,
      lifecycleStatus: configChanged ? 'draft' : 'paused',
      version: expectedVersion + 1,
      rightsStatus: grantMustChange ? 'pending' : existing.rights_status,
      rightsRequestId: result.rightsRequestId,
    },
  });
}
