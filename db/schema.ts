/**
 * 表结构不使用数据库外键约束。
 *
 * 参照完整性由应用层保证：所有删除路径都显式删掉子行
 * （例如 saveResearchSnapshot 先删 evidence_links 再删 claims），
 * 没有任何逻辑依赖数据库级联。
 */

import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  CONNECTOR_RELEASE_MODES,
  INGESTION_QUARANTINE_STATUSES,
  INGESTION_RUN_STATUSES,
  SOURCE_HEALTH_STATUSES,
  SOURCE_LIFECYCLE_STATUSES,
  SOURCE_PROPOSAL_STATUSES,
  SOURCE_RIGHTS_STATUSES,
} from '@/lib/source-lifecycle-status';

export const pipelineRuns = pgTable(
  'pipeline_runs',
  {
    id: text('id').primaryKey(),
    mode: text('mode', { enum: ['sample', 'import'] }).notNull(),
    articleCount: integer('article_count').notNull(),
    topicCount: integer('topic_count').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_pipeline_runs_created_at').on(table.createdAt)],
);

export const articles = pgTable(
  'articles',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    sourceType: text('source_type', {
      enum: ['social', 'media', 'market', 'filing', 'company'],
    }).notNull(),
    author: text('author').notNull().default(''),
    title: text('title').notNull(),
    summary: text('summary').notNull().default(''),
    url: text('url').notNull(),
    publishedAt: text('published_at').notNull(),
    metricsJson: text('metrics_json').notNull().default('{}'),
    contentHash: text('content_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_articles_content_hash').on(table.contentHash),
    index('idx_articles_published_at').on(table.publishedAt),
    index('idx_articles_source_type_published_at').on(
      table.sourceType,
      table.publishedAt,
    ),
  ],
);

export const topics = pgTable(
  'topics',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    keywordsJson: text('keywords_json').notNull().default('[]'),
    runId: text('run_id'),
    score: integer('score').notNull(),
    heatChange: integer('heat_change').notNull().default(0),
    scoreBreakdownJson: text('score_breakdown_json').notNull(),
    sourceCount: integer('source_count').notNull(),
    status: text('status', {
      enum: ['ready', 'needs_primary_source', 'needs_corroboration'],
    }).notNull(),
    gateJson: text('gate_json').notNull(),
    /** 选题质量指标（簇内一致性、证据区分度、词表语言匹配度）；未评估时是 {}。 */
    qualityJson: text('quality_json').notNull().default('{}'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_topics_score_updated_at').on(table.score, table.updatedAt),
    index('idx_topics_status_score').on(table.status, table.score),
    index('idx_topics_run_score').on(
      table.runId,
      table.score,
      table.sourceCount,
    ),
  ],
);

export const topicArticles = pgTable(
  'topic_articles',
  {
    topicId: text('topic_id').notNull(),
    articleId: text('article_id').notNull(),
  },
  (table) => [
    uniqueIndex('idx_topic_articles_pair').on(table.topicId, table.articleId),
    index('idx_topic_articles_article').on(table.articleId),
  ],
);

export const verificationEvents = pgTable(
  'verification_events',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id').notNull(),
    status: text('status', {
      enum: ['unreviewed', 'verified', 'rejected'],
    }).notNull(),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    /** 插入顺序；PG 无隐式 rowid，用它做 created_at 同值时的确定性 tiebreak。 */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_verification_topic_created').on(table.topicId, table.createdAt),
  ],
);

export const sourceConfigs = pgTable(
  'source_configs',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    adapter: text('adapter', {
      enum: ['rss', 'http', 'web', 'csv'],
    }).notNull(),
    configJson: text('config_json').notNull().default('{}'),
    teamId: text('team_id').notNull().default('default'),
    /** 当前单租户部署仍显式保存归属团队，避免未来开放多租户时来源成为无主资产。 */
    ownerTeamId: text('owner_team_id').notNull().default('default'),
    /** 业务负责人可以是 researcher/editor/producer/publisher/admin；必须是 active 成员。 */
    businessOwnerId: text('business_owner_id'),
    locatorJson: jsonb('locator_json').notNull().default({}),
    locatorHash: text('locator_hash').notNull().default(''),
    collectionPolicyJson: jsonb('collection_policy_json').notNull().default({}),
    capabilitiesJson: jsonb('capabilities_json').notNull().default({}),
    /** 面向用户的平台与实际适配器分离；旧行由迁移按 adapter 回填。 */
    platform: text('platform').notNull().default('rss'),
    lifecycleStatus: text('lifecycle_status', {
      enum: SOURCE_LIFECYCLE_STATUSES,
    })
      .notNull()
      .default('draft'),
    configHash: text('config_hash').notNull().default(''),
    /** 只绑定会改变法律使用范围的配置；凭据轮换不得刷新法律授权。 */
    rightsConfigHash: text('rights_config_hash').notNull().default(''),
    lastTestedConfigHash: text('last_tested_config_hash'),
    sourceType: text('source_type', {
      enum: ['social', 'media', 'market', 'filing', 'company'],
    }),
    publisherEntityId: text('publisher_entity_id'),
    checkpointJson: jsonb('checkpoint_json').notNull().default({}),
    checkpointVersion: integer('checkpoint_version').notNull().default(0),
    /** 历史补采与 live 水位完全分离，避免向后翻页覆盖实时游标。 */
    backfillCheckpointJson: jsonb('backfill_checkpoint_json')
      .notNull()
      .default({}),
    backfillCheckpointVersion: integer('backfill_checkpoint_version')
      .notNull()
      .default(0),
    nextRunAt: text('next_run_at'),
    backoffUntil: text('backoff_until'),
    retryAfter: text('retry_after'),
    lastAttemptAt: text('last_attempt_at'),
    lastHealthyAt: text('last_healthy_at'),
    lastTestedAt: text('last_tested_at'),
    lastErrorCode: text('last_error_code'),
    lastErrorDetailRedacted: text('last_error_detail_redacted'),
    healthStatus: text('health_status', {
      enum: SOURCE_HEALTH_STATUSES,
    })
      .notNull()
      .default('unknown'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    activeRunId: text('active_run_id'),
    archivedAt: text('archived_at'),
    rightsStatus: text('rights_status', {
      enum: SOURCE_RIGHTS_STATUSES,
    }).notNull(),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(30),
    /** 供应商计费只能由管理员显式配置；0 表示未知/免费，UI 不得伪造货币成本。 */
    costMicrosPerRequest: integer('cost_micros_per_request')
      .notNull()
      .default(0),
    estimatedRequestsPerRun: integer('estimated_requests_per_run')
      .notNull()
      .default(1),
    monthlyBudgetMicros: bigint('monthly_budget_micros', { mode: 'number' })
      .notNull()
      .default(0),
    budgetSoftLimitPercent: integer('budget_soft_limit_percent')
      .notNull()
      .default(80),
    /** 0–100；预算软阈值后的降频只影响较低优先级来源。 */
    schedulePriority: integer('schedule_priority').notNull().default(50),
    autoThrottleEnabled: integer('auto_throttle_enabled').notNull().default(1),
    /** 系统推导态；原始 cron 始终保留，避免自动策略静默改写用户配置。 */
    effectiveScheduleMultiplier: integer('effective_schedule_multiplier')
      .notNull()
      .default(1),
    scheduleThrottleReason: text('schedule_throttle_reason'),
    scheduleThrottleRecoveryAt: text('schedule_throttle_recovery_at'),
    /** 每次建立 legal hold 都递增；不可逆删除作业必须绑定并复核该 epoch。 */
    legalHoldEpoch: integer('legal_hold_epoch').notNull().default(0),
    retentionMode: text('retention_mode', { enum: ['metadata', 'raw'] })
      .notNull()
      .default('metadata'),
    retentionDays: integer('retention_days').notNull().default(30),
    // 保持 0/1 整数而不是 PG boolean：SQL 是 `enabled = 1`、写入绑 `? 1 : 0`、
    // API 返回值也是数字，改成 boolean 会连带改对外契约。
    enabled: integer('enabled').notNull().default(0),
    version: integer('version').notNull().default(1),
    scheduleCron: text('schedule_cron'),
    checkpoint: text('checkpoint'),
    lastSuccessAt: text('last_success_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_source_configs_enabled').on(table.enabled, table.updatedAt),
    index('idx_source_configs_schedule').on(
      table.lifecycleStatus,
      table.nextRunAt,
    ),
    index('idx_source_configs_health').on(table.healthStatus, table.updatedAt),
    index('idx_source_configs_business_owner').on(table.businessOwnerId),
    uniqueIndex('idx_source_configs_locator')
      .on(table.teamId, table.platform, table.locatorHash)
      .where(sql`${table.locatorHash} <> ''`),
  ],
);

/** 普通编辑提交的来源提案；批准后才创建独立的 source_config draft。 */
export const sourceProposals = pgTable(
  'source_proposals',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().default('default'),
    name: text('name').notNull(),
    adapter: text('adapter', { enum: ['rss', 'http', 'web', 'social'] }).notNull(),
    platform: text('platform', { enum: ['rss', 'http_json', 'web_page', 'wechat', 'xiaohongshu'] }).notNull(),
    sourceType: text('source_type', {
      enum: ['social', 'media', 'market', 'filing', 'company'],
    }).notNull(),
    url: text('url').notNull(),
    discoveryMode: text('discovery_mode', { enum: ['opencli', 'rss'] }),
    accountName: text('account_name'),
    searchLimit: integer('search_limit'),
    scheduleCron: text('schedule_cron'),
    status: text('status', { enum: SOURCE_PROPOSAL_STATUSES })
      .notNull()
      .default('proposal_pending'),
    requestedBy: text('requested_by').notNull(),
    requestNote: text('request_note').notNull().default(''),
    idempotencyKey: text('idempotency_key').notNull(),
    decidedBy: text('decided_by'),
    decisionNote: text('decision_note'),
    decisionIdempotencyKey: text('decision_idempotency_key'),
    sourceConfigId: text('source_config_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    decidedAt: text('decided_at'),
  },
  (table) => [
    uniqueIndex('idx_source_proposals_idempotency').on(
      table.teamId,
      table.requestedBy,
      table.idempotencyKey,
    ),
    uniqueIndex('idx_source_proposals_decision_idempotency')
      .on(table.decisionIdempotencyKey)
      .where(sql`${table.decisionIdempotencyKey} IS NOT NULL`),
    index('idx_source_proposals_status_created').on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const publisherEntities = pgTable(
  'publisher_entities',
  {
    id: text('id').primaryKey(),
    legalName: text('legal_name').notNull(),
    ownershipGroup: text('ownership_group').notNull(),
    entityType: text('entity_type').notNull(),
    identifiersJson: jsonb('identifiers_json').notNull().default({}),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_publisher_entities_group').on(table.ownershipGroup)],
);

export const sourceRightsGrants = pgTable(
  'source_rights_grants',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    principal: text('principal').notNull(),
    provider: text('provider').notNull(),
    permittedFieldsJson: jsonb('permitted_fields_json').notNull().default([]),
    purpose: text('purpose').notNull(),
    usageScope: text('usage_scope').notNull(),
    territory: text('territory').notNull().default('global'),
    evidenceRef: text('evidence_ref').notNull(),
    evidenceSha256: text('evidence_sha256').notNull().default(''),
    termsVersion: text('terms_version').notNull(),
    termsSnapshotSha256: text('terms_snapshot_sha256').notNull().default(''),
    verifiedBy: text('verified_by').notNull(),
    grantedAt: text('granted_at').notNull(),
    verifiedAt: text('verified_at').notNull(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    version: integer('version').notNull().default(1),
    supersedesGrantId: text('supersedes_grant_id'),
    /** 授权确认时的来源行版本，仅用于审计与防止旧运行绑定未来授权。 */
    sourceVersion: integer('source_version').notNull().default(1),
    /** 授权必须与规范化后的来源配置绑定；URL/适配器变化后旧授权不得复用。 */
    configHash: text('config_hash').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_source_rights_active').on(
      table.sourceConfigId,
      table.expiresAt,
      table.revokedAt,
    ),
    uniqueIndex('idx_source_rights_current')
      .on(table.sourceConfigId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

/** 来源登记人的 provisional assertion；只有独立 rights approver 能把它转成 grant。 */
export const sourceRightsRequests = pgTable(
  'source_rights_requests',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    requestedBy: text('requested_by').notNull(),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'superseded'],
    })
      .notNull()
      .default('pending'),
    assertionRef: text('assertion_ref').notNull(),
    sourceVersion: integer('source_version').notNull(),
    rightsConfigHash: text('rights_config_hash').notNull(),
    decision: text('decision', { enum: ['approve', 'reject'] }),
    decisionNote: text('decision_note'),
    dossierJson: jsonb('dossier_json').notNull().default({}),
    dossierHash: text('dossier_hash'),
    decidedBy: text('decided_by'),
    requestIdempotencyKey: text('request_idempotency_key').notNull(),
    decisionIdempotencyKey: text('decision_idempotency_key'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    decidedAt: text('decided_at'),
  },
  (table) => [
    uniqueIndex('idx_source_rights_request_key').on(
      table.sourceConfigId,
      table.requestIdempotencyKey,
    ),
    uniqueIndex('idx_source_rights_decision_key')
      .on(table.decisionIdempotencyKey)
      .where(sql`${table.decisionIdempotencyKey} IS NOT NULL`),
    uniqueIndex('idx_source_rights_pending')
      .on(table.sourceConfigId)
      .where(sql`${table.status} = 'pending'`),
    index('idx_source_rights_requests_status').on(
      table.status,
      table.createdAt,
    ),
  ],
);

/** 连接器制品级发布控制；静态注册表声明能力，这张表决定运行时是否可领取/提交。 */
export const sourceConnectorReleases = pgTable(
  'source_connector_releases',
  {
    id: text('id').primaryKey(),
    connectorId: text('connector_id').notNull(),
    connectorVersion: text('connector_version').notNull(),
    rolloutMode: text('rollout_mode', {
      enum: CONNECTOR_RELEASE_MODES,
    })
      .notNull()
      .default('disabled'),
    /** enabled 模式下的独立 feature flag；未命中稳定桶的来源只做 shadow。 */
    canaryEnabled: integer('canary_enabled').notNull().default(0),
    canaryPercent: integer('canary_percent').notNull().default(10),
    canaryFailureRateBps: integer('canary_failure_rate_bps')
      .notNull()
      .default(2000),
    canaryMinRuns: integer('canary_min_runs').notNull().default(20),
    canaryStartedAt: text('canary_started_at'),
    canaryStoppedAt: text('canary_stopped_at'),
    reason: text('reason').notNull().default(''),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_source_connector_release').on(
      table.connectorId,
      table.connectorVersion,
    ),
    index('idx_source_connector_rollout').on(
      table.rolloutMode,
      table.updatedAt,
    ),
  ],
);

export const sourceCheckpointCutovers = pgTable(
  'source_checkpoint_cutovers',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    scope: text('scope', { enum: ['live', 'backfill'] }).notNull(),
    status: text('status', { enum: ['pending', 'applied', 'rejected'] })
      .notNull()
      .default('pending'),
    sourceVersion: integer('source_version').notNull(),
    checkpointVersionBefore: integer('checkpoint_version_before').notNull(),
    checkpointBeforeJson: jsonb('checkpoint_before_json').notNull().default({}),
    checkpointAfterJson: jsonb('checkpoint_after_json').notNull().default({}),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedBy: text('requested_by').notNull(),
    approvedBy: text('approved_by'),
    reason: text('reason').notNull(),
    decisionNote: text('decision_note'),
    createdAt: text('created_at').notNull(),
    decidedAt: text('decided_at'),
    appliedAt: text('applied_at'),
  },
  (table) => [
    uniqueIndex('idx_source_checkpoint_cutover_idempotency').on(
      table.idempotencyKey,
    ),
    index('idx_source_checkpoint_cutover_pending').on(
      table.sourceConfigId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const sourceLegalHolds = pgTable(
  'source_legal_holds',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    status: text('status', { enum: ['active', 'released'] })
      .notNull()
      .default('active'),
    reason: text('reason').notNull(),
    authorityRef: text('authority_ref').notNull(),
    /** 建立时从 source_configs.legal_hold_epoch 原子取得的 fencing token。 */
    holdEpoch: integer('hold_epoch').notNull(),
    createdBy: text('created_by').notNull(),
    releasedBy: text('released_by'),
    createdAt: text('created_at').notNull(),
    releasedAt: text('released_at'),
  },
  (table) => [
    index('idx_source_legal_holds_source').on(
      table.sourceConfigId,
      table.status,
      table.createdAt,
    ),
    uniqueIndex('idx_source_legal_hold_active')
      .on(table.sourceConfigId)
      .where(sql`${table.status} = 'active'`),
  ],
);

export const sourceDeletionRequests = pgTable(
  'source_deletion_requests',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    sourceVersion: integer('source_version').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status', {
      enum: [
        'pending',
        'blocked',
        'deleting',
        'awaiting_external',
        'completed',
        'failed',
      ],
    })
      .notNull()
      .default('pending'),
    reason: text('reason').notNull(),
    requestedBy: text('requested_by').notNull(),
    legalHoldId: text('legal_hold_id'),
    summaryJson: jsonb('summary_json').notNull().default({}),
    receiptHash: text('receipt_hash'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: text('lease_expires_at'),
    lastErrorRedacted: text('last_error_redacted'),
    initializedAt: text('initialized_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    uniqueIndex('idx_source_deletion_idempotency').on(table.idempotencyKey),
    index('idx_source_deletion_status').on(table.status, table.updatedAt),
    index('idx_source_deletion_source').on(
      table.sourceConfigId,
      table.createdAt,
    ),
  ],
);

export const sourceDeletionItems = pgTable(
  'source_deletion_items',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    kind: text('kind', {
      enum: [
        'raw_object',
        'project_object',
        'external_publish',
        'normalized_article',
        'derived_project',
      ],
    }).notNull(),
    targetRef: text('target_ref').notNull(),
    objectKey: text('object_key'),
    status: text('status', {
      enum: [
        'pending',
        'deleting',
        'awaiting_external',
        'deleted',
        'confirmed',
        'failed',
        'skipped',
        'blocked',
      ],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    receiptHash: text('receipt_hash'),
    receiptJson: jsonb('receipt_json').notNull().default({}),
    lastErrorRedacted: text('last_error_redacted'),
    leaseExpiresAt: text('lease_expires_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => [
    uniqueIndex('idx_source_deletion_item_target').on(
      table.requestId,
      table.kind,
      table.targetRef,
    ),
    index('idx_source_deletion_item_status').on(
      table.requestId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const sourceConnectionTests = pgTable(
  'source_connection_tests',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    jobId: text('job_id'),
    configHash: text('config_hash').notNull(),
    status: text('status', {
      enum: ['queued', 'running', 'succeeded', 'failed'],
    }).notNull(),
    previewJson: jsonb('preview_json').notNull().default([]),
    capabilitiesJson: jsonb('capabilities_json').notNull().default({}),
    errorCode: text('error_code'),
    errorDetailRedacted: text('error_detail_redacted'),
    expiresAt: text('expires_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (table) => [
    index('idx_source_connection_tests_source').on(
      table.sourceConfigId,
      table.createdAt,
    ),
  ],
);

export const teamMembers = pgTable(
  'team_members',
  {
    userId: text('user_id').primaryKey(),
    email: text('email').notNull(),
    role: text('role', {
      enum: [
        'researcher',
        'editor',
        'producer',
        'publisher',
        'admin',
        'auditor',
      ],
    }).notNull(),
    status: text('status', { enum: ['active', 'suspended'] })
      .notNull()
      .default('active'),
    /** 独立于 admin 角色显式授予；决定权利请求时还会强制异人。 */
    canApproveSourceRights: integer('can_approve_source_rights')
      .notNull()
      .default(0),
    /** 独立法律操作 capability；legal hold 仍要求异人创建/解除。 */
    canManageSourceLegal: integer('can_manage_source_legal')
      .notNull()
      .default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_team_members_email').on(table.email),
    index('idx_team_members_status_role').on(table.status, table.role),
  ],
);

export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    jobId: text('job_id'),
    status: text('status', {
      enum: INGESTION_RUN_STATUSES,
    }).notNull(),
    checkpointBefore: text('checkpoint_before'),
    checkpointAfter: text('checkpoint_after'),
    checkpointBeforeJson: jsonb('checkpoint_before_json').notNull().default({}),
    checkpointAfterJson: jsonb('checkpoint_after_json').notNull().default({}),
    checkpointScope: text('checkpoint_scope', { enum: ['live', 'backfill'] })
      .notNull()
      .default('live'),
    sourceVersion: integer('source_version').notNull().default(1),
    rightsGrantId: text('rights_grant_id'),
    scheduledFor: text('scheduled_for'),
    trigger: text('trigger', { enum: ['schedule', 'manual', 'backfill'] })
      .notNull()
      .default('manual'),
    requiredCapability: text('required_capability')
      .notNull()
      .default('source:rss'),
    connectorId: text('connector_id').notNull().default('rss-v1'),
    connectorVersion: text('connector_version').notNull().default('1'),
    payloadSchemaVersion: integer('payload_schema_version')
      .notNull()
      .default(1),
    fetchedCount: integer('fetched_count').notNull().default(0),
    acceptedCount: integer('accepted_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    byteCount: integer('byte_count').notNull().default(0),
    costMicrosPerRequest: integer('cost_micros_per_request')
      .notNull()
      .default(0),
    /** 入队时先预留估算，提交时按实际 request_count 重算；失败至少保留预留值。 */
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    errorCode: text('error_code'),
    retryable: integer('retryable').notNull().default(0),
    retryAfter: text('retry_after'),
    errorJson: text('error_json'),
    resultJson: jsonb('result_json').notNull().default({}),
    fetchOutcome: text('fetch_outcome', {
      enum: ['unknown', 'modified', 'not_modified'],
    })
      .notNull()
      .default('unknown'),
    fetchDurationMs: integer('fetch_duration_ms').notNull().default(0),
    queueDurationMs: integer('queue_duration_ms').notNull().default(0),
    commitDurationMs: integer('commit_duration_ms').notNull().default(0),
    shadow: integer('shadow').notNull().default(0),
    quarantineStatus: text('quarantine_status', {
      enum: INGESTION_QUARANTINE_STATUSES,
    })
      .notNull()
      .default('none'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_ingestion_runs_source_created').on(
      table.sourceConfigId,
      table.createdAt,
    ),
    index('idx_ingestion_runs_source_status').on(
      table.sourceConfigId,
      table.status,
    ),
    uniqueIndex('idx_ingestion_runs_schedule_occurrence').on(
      table.sourceConfigId,
      table.scheduledFor,
      table.trigger,
    ),
  ],
);

export const sourceSloExclusions = pgTable(
  'source_slo_exclusions',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    kind: text('kind', {
      enum: ['manual_pause', 'planned_maintenance'],
    }).notNull(),
    startsAt: text('starts_at').notNull(),
    endsAt: text('ends_at'),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    closedBy: text('closed_by'),
    cancelledBy: text('cancelled_by'),
    createdAt: text('created_at').notNull(),
    closedAt: text('closed_at'),
    cancelledAt: text('cancelled_at'),
  },
  (table) => [
    index('idx_source_slo_exclusions_source_time').on(
      table.sourceConfigId,
      table.startsAt,
      table.endsAt,
    ),
  ],
);

/**
 * 自动降频跳过的每个 cron occurrence。SLO 只能排除这里明确登记的时点；
 * Scheduler 真正漏跑且没有记录时仍然消耗错误预算。
 */
export const sourceScheduleThrottles = pgTable(
  'source_schedule_throttles',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    scheduledFor: text('scheduled_for').notNull(),
    policyVersion: text('policy_version').notNull(),
    schedulePriority: integer('schedule_priority').notNull(),
    cadenceMultiplier: integer('cadence_multiplier').notNull(),
    monthSpentMicros: bigint('month_spent_micros', { mode: 'number' })
      .notNull(),
    monthlyBudgetMicros: bigint('monthly_budget_micros', { mode: 'number' })
      .notNull(),
    softLimitPercent: integer('soft_limit_percent').notNull(),
    reasonCode: text('reason_code').notNull(),
    recoveryAt: text('recovery_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_source_schedule_throttles_occurrence').on(
      table.sourceConfigId,
      table.scheduledFor,
    ),
    index('idx_source_schedule_throttles_time').on(
      table.scheduledFor,
      table.sourceConfigId,
    ),
  ],
);

export const ingestionPages = pgTable(
  'ingestion_pages',
  {
    id: text('id').primaryKey(),
    ingestionRunId: text('ingestion_run_id').notNull(),
    pageKey: text('page_key').notNull(),
    /** 新协议页面从 0 连续递增；历史占位行允许 NULL，不能冒充已验证序列。 */
    pageOrdinal: integer('page_ordinal'),
    contentHash: text('content_hash'),
    leaseEpoch: integer('lease_epoch').notNull().default(0),
    finalPage: integer('final_page').notNull().default(0),
    checkpointBeforeJson: jsonb('checkpoint_before_json').notNull().default({}),
    checkpointAfterJson: jsonb('checkpoint_after_json').notNull().default({}),
    status: text('status', {
      enum: ['received', 'committed', 'rejected'],
    }).notNull(),
    resultJson: jsonb('result_json').notNull().default({}),
    /** 逐页协议只暂存已规范化内容；运行 complete 时才原子发布到文章/origin 表。 */
    stagedPayloadJson: jsonb('staged_payload_json').notNull().default({}),
    fetchedCount: integer('fetched_count').notNull().default(0),
    acceptedCount: integer('accepted_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    requestCount: integer('request_count').notNull().default(0),
    byteCount: integer('byte_count').notNull().default(0),
    createdAt: text('created_at').notNull(),
    committedAt: text('committed_at'),
  },
  (table) => [
    uniqueIndex('idx_ingestion_pages_run_key').on(
      table.ingestionRunId,
      table.pageKey,
    ),
    uniqueIndex('idx_ingestion_pages_run_ordinal').on(
      table.ingestionRunId,
      table.pageOrdinal,
    ),
  ],
);

export const rawPayloadUploads = pgTable(
  'raw_payload_uploads',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull().default('default'),
    sourceConfigId: text('source_config_id').notNull(),
    ingestionRunId: text('ingestion_run_id').notNull(),
    state: text('state', {
      enum: [
        'initiated',
        'uploaded',
        'committed',
        'aborted',
        'expired',
        'deleting',
        'deleted',
      ],
    })
      .notNull()
      .default('initiated'),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: integer('byte_size').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    committedAt: text('committed_at'),
    deleteAfter: text('delete_after').notNull(),
    deletedAt: text('deleted_at'),
    deleteAttempts: integer('delete_attempts').notNull().default(0),
    deleteLeaseExpiresAt: text('delete_lease_expires_at'),
    lastErrorRedacted: text('last_error_redacted'),
  },
  (table) => [
    uniqueIndex('idx_raw_payload_uploads_run').on(table.ingestionRunId),
    uniqueIndex('idx_raw_payload_uploads_object').on(table.objectKey),
    index('idx_raw_payload_uploads_expiry').on(table.state, table.expiresAt),
    index('idx_raw_payload_uploads_delete_after').on(
      table.state,
      table.deleteAfter,
    ),
    index('idx_raw_payload_uploads_source').on(
      table.sourceConfigId,
      table.createdAt,
    ),
  ],
);

export const sourceItemOrigins = pgTable(
  'source_item_origins',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    namespace: text('namespace').notNull(),
    platformItemId: text('platform_item_id').notNull(),
    articleId: text('article_id').notNull(),
    articleRevisionId: text('article_revision_id'),
    ingestionRunId: text('ingestion_run_id').notNull(),
    canonicalUrlHash: text('canonical_url_hash').notNull(),
    fingerprintVersion: text('fingerprint_version').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    relationship: text('relationship', {
      enum: ['original', 'repost', 'quote', 'syndicated', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    evidenceFamilyId: text('evidence_family_id'),
    publisherEntityId: text('publisher_entity_id'),
    confidence: integer('confidence').notNull().default(0),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (table) => [
    uniqueIndex('idx_source_item_origins_platform_item').on(
      table.sourceConfigId,
      table.namespace,
      table.platformItemId,
    ),
    index('idx_source_item_origins_article').on(table.articleId),
    index('idx_source_item_origins_family').on(
      table.evidenceFamilyId,
      table.publisherEntityId,
    ),
  ],
);

/**
 * origin 人工修正采用不可变版本。当前版本的 supersedes_correction_id 为 NULL；
 * 新修正把旧行指向自己，既能快速读取当前值，也保留完整审计历史。
 */
export const sourceOriginCorrections = pgTable(
  'source_origin_corrections',
  {
    id: text('id').primaryKey(),
    originId: text('origin_id').notNull(),
    relationship: text('relationship', {
      enum: ['original', 'repost', 'quote', 'syndicated', 'unknown'],
    }).notNull(),
    evidenceFamilyId: text('evidence_family_id').notNull(),
    publisherEntityId: text('publisher_entity_id').notNull(),
    confidence: integer('confidence').notNull(),
    reason: text('reason').notNull(),
    createdBy: text('created_by').notNull(),
    supersedesCorrectionId: text('supersedes_correction_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_source_origin_corrections_current')
      .on(table.originId)
      .where(sql`${table.supersedesCorrectionId} IS NULL`),
    index('idx_source_origin_corrections_history').on(
      table.originId,
      table.createdAt,
    ),
  ],
);

/**
 * 上游 item 的最新事件游标。unknown-ID tombstone 也落在这里，确保较旧 upsert
 * 在重放时不会复活内容；同一时间点 tombstone 具有 fail-closed 优先级。
 */
export const sourceItemEventStates = pgTable(
  'source_item_event_states',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    namespace: text('namespace').notNull(),
    platformItemId: text('platform_item_id').notNull(),
    latestKind: text('latest_kind', { enum: ['upsert', 'tombstone'] }).notNull(),
    latestEventAt: text('latest_event_at').notNull(),
    latestIngestionRunId: text('latest_ingestion_run_id').notNull(),
    identityStrategy: text('identity_strategy', {
      enum: ['platform_id', 'guid', 'canonical_url', 'content_fingerprint'],
    }).notNull(),
    identityConfidence: text('identity_confidence', {
      enum: ['high', 'medium', 'low'],
    }).notNull(),
    provenanceJson: jsonb('provenance_json').notNull().default({}),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_source_item_event_states_identity').on(
      table.sourceConfigId,
      table.namespace,
      table.platformItemId,
    ),
    index('idx_source_item_event_states_latest').on(
      table.sourceConfigId,
      table.latestKind,
      table.latestEventAt,
    ),
  ],
);

export const sourceItemRejections = pgTable(
  'source_item_rejections',
  {
    id: text('id').primaryKey(),
    ingestionRunId: text('ingestion_run_id').notNull(),
    platformItemId: text('platform_item_id'),
    itemIndex: integer('item_index').notNull(),
    errorCode: text('error_code').notNull(),
    detailRedacted: text('detail_redacted').notNull(),
    payloadHash: text('payload_hash').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_source_item_rejections_run').on(table.ingestionRunId)],
);

export const articleRevisions = pgTable(
  'article_revisions',
  {
    id: text('id').primaryKey(),
    articleId: text('article_id').notNull(),
    revision: integer('revision').notNull(),
    contentJson: text('content_json').notNull(),
    contentHash: text('content_hash').notNull(),
    rawObjectKey: text('raw_object_key'),
    observedAt: text('observed_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_article_revisions_article_revision').on(
      table.articleId,
      table.revision,
    ),
    uniqueIndex('idx_article_revisions_hash').on(
      table.articleId,
      table.contentHash,
    ),
  ],
);

export const contentProjects = pgTable(
  'content_projects',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id').notNull(),
    title: text('title').notNull(),
    state: text('state').notNull().default('DRAFT'),
    version: integer('version').notNull().default(1),
    ownerId: text('owner_id').notNull(),
    brand: text('brand').notNull().default('Signal 40'),
    locale: text('locale').notNull().default('zh-CN'),
    projectJson: text('project_json').notNull(),
    immutableHash: text('immutable_hash').notNull(),
    // 编排引擎只处理 automation_mode = 'auto' 的项目；任何人工编辑、审批或内容事件
    // 都会把它改成 'manual' 并写下 automation_paused_reason，界面据此解释「为什么停了」。
    automationMode: text('automation_mode', { enum: ['auto', 'manual'] })
      .notNull()
      .default('auto'),
    automationPausedReason: text('automation_paused_reason'),
    automationPolicyId: text('automation_policy_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_content_projects_topic').on(table.topicId),
    index('idx_content_projects_automation').on(
      table.automationMode,
      table.state,
    ),
    index('idx_content_projects_state_updated').on(
      table.state,
      table.updatedAt,
    ),
  ],
);

export const claims = pgTable(
  'claims',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    logicalId: text('logical_id').notNull(),
    text: text('text').notNull(),
    kind: text('kind', {
      enum: [
        'fact',
        'numeric',
        'comparison',
        'causal',
        'prediction',
        'analysis',
        'opinion',
        'disclaimer',
      ],
    }).notNull(),
    quantityJson: text('quantity_json'),
    status: text('status', {
      enum: ['draft', 'supported', 'conflicted', 'rejected'],
    })
      .notNull()
      .default('draft'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_claims_project_logical_id').on(
      table.projectId,
      table.logicalId,
    ),
    index('idx_claims_project_status').on(table.projectId, table.status),
  ],
);

export const evidenceLinks = pgTable(
  'evidence_links',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull(),
    articleId: text('article_id'),
    articleRevisionId: text('article_revision_id'),
    sourceUrl: text('source_url').notNull(),
    stance: text('stance', {
      enum: ['supports', 'refutes', 'context'],
    }).notNull(),
    excerpt: text('excerpt').notNull(),
    locatorJson: text('locator_json')
      .notNull()
      .default('{"type":"url","value":""}'),
    sourceHash: text('source_hash').notNull(),
    observedAt: text('observed_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_evidence_claim_stance').on(table.claimId, table.stance),
  ],
);

export const researchSnapshots = pgTable(
  'research_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    version: integer('version').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_research_snapshots_project_version').on(
      table.projectId,
      table.version,
    ),
    uniqueIndex('idx_research_snapshots_project_hash').on(
      table.projectId,
      table.snapshotHash,
    ),
  ],
);

export const scriptVersions = pgTable(
  'script_versions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    version: integer('version').notNull(),
    scriptJson: text('script_json').notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_script_versions_project_version').on(
      table.projectId,
      table.version,
    ),
  ],
);

export const storyboardVersions = pgTable(
  'storyboard_versions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    version: integer('version').notNull(),
    storyboardJson: text('storyboard_json').notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_storyboard_versions_project_version').on(
      table.projectId,
      table.version,
    ),
  ],
);

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    objectKey: text('object_key').notNull(),
    mediaType: text('media_type').notNull(),
    assetRole: text('asset_role', {
      enum: ['input', 'voice-output', 'preview-output', 'render-output'],
    })
      .notNull()
      .default('input'),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    rightsStatus: text('rights_status', {
      enum: ['cleared', 'restricted', 'unknown'],
    }).notNull(),
    rightsNote: text('rights_note').notNull().default(''),
    usageScope: text('usage_scope')
      .notNull()
      .default('current-project-and-configured-channels'),
    provenanceJson: text('provenance_json').notNull().default('{}'),
    retentionUntil: text('retention_until'),
    cropJson: text('crop_json'),
    derivedFromId: text('derived_from_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_assets_object_key').on(table.objectKey),
    index('idx_assets_project_rights').on(table.projectId, table.rightsStatus),
  ],
);

export const assetUploadSessions = pgTable(
  'asset_upload_sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    uploadId: text('upload_id').notNull(),
    objectKey: text('object_key').notNull(),
    filename: text('filename').notNull(),
    mediaType: text('media_type').notNull(),
    rightsStatus: text('rights_status', {
      enum: ['cleared', 'restricted', 'unknown'],
    }).notNull(),
    rightsNote: text('rights_note').notNull().default(''),
    status: text('status', {
      enum: ['open', 'completed', 'aborted', 'expired'],
    })
      .notNull()
      .default('open'),
    expiresAt: text('expires_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_asset_upload_sessions_upload').on(table.uploadId),
    index('idx_asset_upload_sessions_project_status').on(
      table.projectId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const voiceTracks = pgTable(
  'voice_tracks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    scriptVersion: integer('script_version').notNull(),
    provider: text('provider').notNull(),
    voice: text('voice').notNull(),
    objectKey: text('object_key').notNull(),
    durationMs: integer('duration_ms').notNull(),
    speed: integer('speed_milli').notNull().default(1000),
    pronunciationJson: text('pronunciation_json').notNull().default('{}'),
    audioSha256: text('audio_sha256'),
    fallbackProvider: text('fallback_provider'),
    costMicros: integer('cost_micros').notNull().default(0),
    alignmentJson: text('alignment_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_voice_tracks_project_created').on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const captionTracks = pgTable(
  'caption_tracks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    voiceTrackId: text('voice_track_id'),
    format: text('format', { enum: ['json', 'srt', 'vtt'] }).notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_caption_tracks_project_created').on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const renderSnapshots = pgTable(
  'render_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    templateVersion: text('template_version').notNull(),
    templateId: text('template_id').notNull().default('signal40-editorial'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_render_snapshots_hash').on(
      table.projectId,
      table.snapshotHash,
    ),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: [
        'ingestion',
        'voice',
        'preview',
        'render',
        'qc',
        'publish',
        'metrics',
      ],
    }).notNull(),
    projectId: text('project_id'),
    /** 作业创建时的策略快照归因；策略后来切换也不能篡改历史成本。 */
    automationPolicyId: text('automation_policy_id'),
    requiredCapability: text('required_capability').notNull().default(''),
    requiredCapabilityProtocolVersion: integer(
      'required_capability_protocol_version',
    )
      .notNull()
      .default(1),
    payloadSchemaVersion: integer('payload_schema_version')
      .notNull()
      .default(1),
    /**
     * 仅供旧控制面滚动升级期间继续显式写入；新代码不得读取或把它作为租约门禁。
     * 待旧控制面全部退出后由独立 contract migration 删除。
     */
    minimumWorkerVersionDeprecated: text('minimum_worker_version')
      .notNull()
      .default(''),
    // jsonb 而不是 text：租约查询要按 payload 里的字段过滤，
    // 用 text 就得在 SQL 里 ::jsonb 强转，一条非法 JSON 会让整个租约查询报错、队列卡死。
    payloadJson: jsonb('payload_json').notNull(),
    status: text('status', {
      enum: [
        'queued',
        'leased',
        'retrying',
        'succeeded',
        'failed',
        'dead_letter',
        'cancelled',
      ],
    })
      .notNull()
      .default('queued'),
    idempotencyKey: text('idempotency_key').notNull(),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    priority: integer('priority').notNull().default(50),
    timeoutSeconds: integer('timeout_seconds').notNull().default(900),
    estimatedCostMicros: integer('estimated_cost_micros').notNull().default(0),
    availableAt: text('available_at').notNull(),
    leaseOwner: text('lease_owner'),
    /** 每次成功领取递增，防止同名 Worker 的过期执行写入新租约。 */
    leaseEpoch: integer('lease_epoch').notNull().default(0),
    leaseExpiresAt: text('lease_expires_at'),
    resultJson: text('result_json'),
    outputObjectKey: text('output_object_key'),
    logObjectKey: text('log_object_key'),
    durationMs: integer('duration_ms'),
    lastError: text('last_error'),
    costMicros: integer('cost_micros').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_jobs_idempotency').on(table.kind, table.idempotencyKey),
    index('idx_jobs_poll').on(table.status, table.availableAt, table.createdAt),
    // leaseNextJob 按 kind IN (...) AND status 过滤，idx_jobs_poll 不含 kind，匹配不上。
    index('idx_jobs_kind_status_available').on(
      table.kind,
      table.status,
      table.availableAt,
    ),
    index('idx_jobs_capability_status_available').on(
      table.requiredCapability,
      table.status,
      table.availableAt,
    ),
    index('idx_jobs_project_kind').on(
      table.projectId,
      table.kind,
      table.createdAt,
    ),
    index('idx_jobs_automation_policy_created').on(
      table.automationPolicyId,
      table.createdAt,
    ),
  ],
);

export const qcReports = pgTable(
  'qc_reports',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    renderJobId: text('render_job_id'),
    status: text('status', { enum: ['pending', 'passed', 'failed'] }).notNull(),
    checksJson: text('checks_json').notNull(),
    createdAt: text('created_at').notNull(),
    /** 插入顺序；PG 无隐式 rowid，用它做 created_at 同值时的确定性 tiebreak。 */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_qc_reports_project_created').on(
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    kind: text('kind', {
      enum: ['research', 'script', 'qc', 'publish'],
    }).notNull(),
    decision: text('decision', {
      enum: ['approved', 'changes_requested', 'rejected'],
    }).notNull(),
    subjectHash: text('subject_hash').notNull(),
    actorId: text('actor_id').notNull(),
    actorRole: text('actor_role').notNull(),
    note: text('note').notNull(),
    createdAt: text('created_at').notNull(),
    /** 插入顺序；PG 无隐式 rowid，用它做 created_at 同值时的确定性 tiebreak。 */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_approvals_project_kind_created').on(
      table.projectId,
      table.kind,
      table.createdAt,
    ),
  ],
);

export const publishJobs = pgTable(
  'publish_jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    channel: text('channel').notNull(),
    logicalKey: text('logical_key').notNull(),
    status: text('status', {
      enum: [
        'draft',
        'scheduled',
        'publishing',
        'published',
        'failed',
        'withdrawn',
      ],
    }).notNull(),
    scheduledAt: text('scheduled_at'),
    accountId: text('account_id'),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    tagsJson: text('tags_json').notNull().default('[]'),
    coverAssetId: text('cover_asset_id'),
    externalId: text('external_id'),
    packageObjectKey: text('package_object_key'),
    finalUrl: text('final_url'),
    platformResponseJson: text('platform_response_json'),
    correctionOfId: text('correction_of_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_publish_jobs_logical_key').on(
      table.channel,
      table.logicalKey,
    ),
    index('idx_publish_jobs_project_status').on(table.projectId, table.status),
  ],
);

export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    publishJobId: text('publish_job_id'),
    idempotencyKey: text('idempotency_key').notNull(),
    capturedAt: text('captured_at').notNull(),
    metricsJson: text('metrics_json').notNull(),
    attributionJson: text('attribution_json').notNull(),
  },
  (table) => [
    index('idx_metric_snapshots_project_captured').on(
      table.projectId,
      table.capturedAt,
    ),
    uniqueIndex('idx_metric_snapshots_idempotency').on(
      table.projectId,
      table.idempotencyKey,
    ),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id'),
    actorId: text('actor_id').notNull(),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    // 同上：幂等键重放查询按 metadata 里的字段过滤。
    metadataJson: jsonb('metadata_json').notNull().default({}),
    requestId: text('request_id').notNull(),
    createdAt: text('created_at').notNull(),
    /** 插入顺序；PG 无隐式 rowid，用它做 created_at 同值时的确定性 tiebreak。 */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (table) => [
    index('idx_audit_events_project_created').on(
      table.projectId,
      table.createdAt,
    ),
    index('idx_audit_events_entity').on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    key: text('key').primaryKey(),
    scope: text('scope').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseJson: text('response_json').notNull(),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_idempotency_expires').on(table.expiresAt)],
);

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    externalEventId: text('external_event_id').notNull(),
    signatureHash: text('signature_hash').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status', {
      enum: ['accepted', 'processed', 'rejected'],
    }).notNull(),
    occurredAt: text('occurred_at'),
    payloadJson: text('payload_json').notNull(),
    receivedAt: text('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_webhook_events_provider_external').on(
      table.provider,
      table.externalEventId,
    ),
    index('idx_webhook_events_received').on(table.receivedAt),
  ],
);

export const contentIncidents = pgTable(
  'content_incidents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    publishJobId: text('publish_job_id'),
    kind: text('kind', {
      enum: ['correction', 'withdrawal', 'fact_update', 'complaint'],
    }).notNull(),
    severity: text('severity', {
      enum: ['low', 'medium', 'high', 'critical'],
    }).notNull(),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    reason: text('reason').notNull(),
    resolution: text('resolution'),
    actorId: text('actor_id').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_content_incidents_status_created').on(
      table.status,
      table.createdAt,
    ),
  ],
);

export const experiments = pgTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    hypothesis: text('hypothesis').notNull(),
    status: text('status', {
      enum: ['draft', 'running', 'completed', 'cancelled'],
    })
      .notNull()
      .default('draft'),
    variantsJson: text('variants_json').notNull(),
    allocationBpsJson: text('allocation_bps_json').notNull(),
    primaryMetric: text('primary_metric').notNull(),
    guardrailsJson: text('guardrails_json').notNull().default('[]'),
    createdBy: text('created_by').notNull(),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_experiments_status_created').on(table.status, table.createdAt),
  ],
);

export const projectExperimentAssignments = pgTable(
  'project_experiment_assignments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    experimentId: text('experiment_id').notNull(),
    variant: text('variant').notNull(),
    assignmentHash: text('assignment_hash').notNull(),
    assignedAt: text('assigned_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_project_experiment_unique').on(
      table.projectId,
      table.experimentId,
    ),
  ],
);

export const calibrationRuns = pgTable(
  'calibration_runs',
  {
    id: text('id').primaryKey(),
    algorithmVersion: text('algorithm_version').notNull(),
    calibrationKind: text('calibration_kind', {
      enum: ['score', 'social_evidence'],
    })
      .notNull()
      .default('score'),
    datasetLabel: text('dataset_label').notNull(),
    datasetRef: text('dataset_ref'),
    datasetSha256: text('dataset_sha256'),
    caseCount: integer('case_count').notNull(),
    metricsJson: text('metrics_json').notNull(),
    policyJson: jsonb('policy_json').notNull().default({}),
    status: text('status', { enum: ['candidate', 'approved', 'rejected'] })
      .notNull()
      .default('candidate'),
    createdBy: text('created_by').notNull(),
    approvedBy: text('approved_by'),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('idx_calibration_runs_status_created').on(
      table.status,
      table.createdAt,
    ),
    index('idx_calibration_runs_kind_status').on(
      table.calibrationKind,
      table.status,
      table.createdAt,
    ),
  ],
);

/**
 * Worker 心跳登记。空闲轮询时也上报，界面据此判断「入队的作业有没有人会执行」。
 * 超过 7 天没有心跳的行由编排引擎清理，避免历史 Worker 无限堆积。
 */
export const workers = pgTable(
  'workers',
  {
    id: text('id').primaryKey(),
    hostname: text('hostname').notNull().default(''),
    kindsJson: text('kinds_json').notNull().default('[]'),
    capabilitiesJson: text('capabilities_json').notNull().default('[]'),
    capabilityProtocolVersionsJson: text(
      'capability_protocol_versions_json',
    )
      .notNull()
      .default('{}'),
    version: text('version').notNull().default(''),
    lastHeartbeatAt: text('last_heartbeat_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_workers_heartbeat').on(table.lastHeartbeatAt)],
);

/**
 * 自动化策略：哪些阶段自动、哪几道审批可预先授权、授权人是谁、护栏是什么。
 *
 * `research_authorized_by` 与 `publish_authorized_by` 必须是不同的真实成员——
 * G7 的职责分离判定的是两次批准的 actor_id 不同，同一个人自动放行两端等于删掉这条约束。
 */
export const automationPolicies = pgTable(
  'automation_policies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    scopeJson: text('scope_json').notNull().default('{}'),
    stagesJson: text('stages_json').notNull().default('{}'),
    autoApprovalsJson: text('auto_approvals_json').notNull().default('{}'),
    researchAuthorizedBy: text('research_authorized_by'),
    publishAuthorizedBy: text('publish_authorized_by'),
    guardrailsJson: text('guardrails_json').notNull().default('{}'),
    authorizedAt: text('authorized_at'),
    expiresAt: text('expires_at'),
    enabled: integer('enabled').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_automation_policies_name').on(table.name),
    index('idx_automation_policies_enabled').on(table.enabled, table.updatedAt),
  ],
);

/** 每轮 tick 的记录：动作数、耗时、错误与熔断状态。下一轮从最近一行读回熔断计数。 */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    trigger: text('trigger', { enum: ['scheduler', 'manual'] }).notNull(),
    status: text('status', {
      enum: ['succeeded', 'partial', 'failed', 'skipped'],
    }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    durationMs: integer('duration_ms'),
    projectCount: integer('project_count').notNull().default(0),
    actionsJson: text('actions_json').notNull().default('[]'),
    breakersJson: text('breakers_json').notNull().default('{}'),
    errorsJson: text('errors_json').notNull().default('[]'),
  },
  (table) => [index('idx_automation_runs_started').on(table.startedAt)],
);

/** 全局自动化开关。单例行 `global` 可立即阻止所有调度阶段执行。 */
export const automationControl = pgTable('automation_control', {
  id: text('id').primaryKey(),
  paused: integer('paused').notNull().default(0),
  reason: text('reason').notNull().default(''),
  updatedBy: text('updated_by'),
  updatedAt: text('updated_at').notNull(),
});

/** 待办箱：需要人处理的每一件事，去重键保证同一件事不会每轮 tick 重复产生。 */
export const attentionItems = pgTable(
  'attention_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: [
        'gate_blocked',
        'qc_failed',
        'dead_letter',
        'evidence_conflict',
        'budget_exceeded',
        'breaker_open',
        'auto_approval_rejected',
        'topic_quality',
        'no_worker',
        'incident_open',
        'metrics_due',
        'automation_actor_missing',
        'source_rights',
        'source_connector',
        'source_slo',
        'source_budget',
        'source_ownership',
      ],
    }).notNull(),
    severity: text('severity', { enum: ['info', 'warning', 'critical'] })
      .notNull()
      .default('warning'),
    projectId: text('project_id'),
    topicId: text('topic_id'),
    policyId: text('policy_id'),
    sourceConfigId: text('source_config_id'),
    dedupeKey: text('dedupe_key').notNull(),
    reason: text('reason').notNull(),
    detailJson: text('detail_json').notNull().default('{}'),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    notifiedAt: text('notified_at'),
    notifyError: text('notify_error'),
    resolvedBy: text('resolved_by'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_attention_items_dedupe').on(table.dedupeKey),
    index('idx_attention_items_status_created').on(
      table.status,
      table.createdAt,
    ),
    index('idx_attention_items_project').on(table.projectId, table.status),
    index('idx_attention_items_source').on(table.sourceConfigId, table.status),
  ],
);
