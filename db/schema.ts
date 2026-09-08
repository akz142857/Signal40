/**
 * 表结构不使用数据库外键约束。
 *
 * 参照完整性由应用层保证：所有删除路径都显式删掉子行
 * （例如 saveResearchSnapshot 先删 evidence_links 再删 claims），
 * 没有任何逻辑依赖数据库级联。
 */

import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

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
    adapter: text('adapter', { enum: ['rss', 'http', 'opencli', 'csv'] }).notNull(),
    configJson: text('config_json').notNull().default('{}'),
    rightsStatus: text('rights_status', { enum: ['approved', 'restricted', 'blocked'] }).notNull(),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(30),
    retentionMode: text('retention_mode', { enum: ['metadata', 'raw'] }).notNull().default('metadata'),
    retentionDays: integer('retention_days').notNull().default(30),
    // 保持 0/1 整数而不是 PG boolean：SQL 是 `enabled = 1`、写入绑 `? 1 : 0`、
    // API 返回值也是数字，改成 boolean 会连带改对外契约。
    enabled: integer('enabled').notNull().default(1),
    version: integer('version').notNull().default(1),
    scheduleCron: text('schedule_cron'),
    checkpoint: text('checkpoint'),
    lastSuccessAt: text('last_success_at'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_source_configs_enabled').on(table.enabled, table.updatedAt)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    userId: text('user_id').primaryKey(),
    email: text('email').notNull(),
    role: text('role', { enum: ['researcher', 'editor', 'producer', 'publisher', 'admin', 'auditor'] }).notNull(),
    status: text('status', { enum: ['active', 'suspended'] }).notNull().default('active'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('idx_team_members_email').on(table.email), index('idx_team_members_status_role').on(table.status, table.role)],
);

export const ingestionRuns = pgTable(
  'ingestion_runs',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull(),
    jobId: text('job_id'),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'] }).notNull(),
    checkpointBefore: text('checkpoint_before'),
    checkpointAfter: text('checkpoint_after'),
    fetchedCount: integer('fetched_count').notNull().default(0),
    acceptedCount: integer('accepted_count').notNull().default(0),
    rejectedCount: integer('rejected_count').notNull().default(0),
    errorJson: text('error_json'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_ingestion_runs_source_created').on(table.sourceConfigId, table.createdAt)],
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
    uniqueIndex('idx_article_revisions_article_revision').on(table.articleId, table.revision),
    uniqueIndex('idx_article_revisions_hash').on(table.articleId, table.contentHash),
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
    automationMode: text('automation_mode', { enum: ['auto', 'manual'] }).notNull().default('auto'),
    automationPausedReason: text('automation_paused_reason'),
    automationPolicyId: text('automation_policy_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_content_projects_topic').on(table.topicId),
    index('idx_content_projects_automation').on(table.automationMode, table.state),
    index('idx_content_projects_state_updated').on(table.state, table.updatedAt),
  ],
);

export const claims = pgTable(
  'claims',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    logicalId: text('logical_id').notNull(),
    text: text('text').notNull(),
    kind: text('kind', { enum: ['fact', 'numeric', 'comparison', 'causal', 'prediction', 'analysis', 'opinion', 'disclaimer'] }).notNull(),
    quantityJson: text('quantity_json'),
    status: text('status', { enum: ['draft', 'supported', 'conflicted', 'rejected'] }).notNull().default('draft'),
    version: integer('version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_claims_project_logical_id').on(table.projectId, table.logicalId),
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
    stance: text('stance', { enum: ['supports', 'refutes', 'context'] }).notNull(),
    excerpt: text('excerpt').notNull(),
    locatorJson: text('locator_json').notNull().default('{"type":"url","value":""}'),
    sourceHash: text('source_hash').notNull(),
    observedAt: text('observed_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_evidence_claim_stance').on(table.claimId, table.stance)],
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
    uniqueIndex('idx_research_snapshots_project_version').on(table.projectId, table.version),
    uniqueIndex('idx_research_snapshots_project_hash').on(table.projectId, table.snapshotHash),
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
  (table) => [uniqueIndex('idx_script_versions_project_version').on(table.projectId, table.version)],
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
  (table) => [uniqueIndex('idx_storyboard_versions_project_version').on(table.projectId, table.version)],
);

export const assets = pgTable(
  'assets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    objectKey: text('object_key').notNull(),
    mediaType: text('media_type').notNull(),
    assetRole: text('asset_role', { enum: ['input', 'voice-output', 'preview-output', 'render-output'] }).notNull().default('input'),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    rightsStatus: text('rights_status', { enum: ['cleared', 'restricted', 'unknown'] }).notNull(),
    rightsNote: text('rights_note').notNull().default(''),
    usageScope: text('usage_scope').notNull().default('current-project-and-configured-channels'),
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
    rightsStatus: text('rights_status', { enum: ['cleared', 'restricted', 'unknown'] }).notNull(),
    rightsNote: text('rights_note').notNull().default(''),
    status: text('status', { enum: ['open', 'completed', 'aborted', 'expired'] }).notNull().default('open'),
    expiresAt: text('expires_at').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [uniqueIndex('idx_asset_upload_sessions_upload').on(table.uploadId), index('idx_asset_upload_sessions_project_status').on(table.projectId, table.status, table.createdAt)],
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
  (table) => [index('idx_voice_tracks_project_created').on(table.projectId, table.createdAt)],
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
  (table) => [index('idx_caption_tracks_project_created').on(table.projectId, table.createdAt)],
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
  (table) => [uniqueIndex('idx_render_snapshots_hash').on(table.projectId, table.snapshotHash)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['ingestion', 'voice', 'preview', 'render', 'qc', 'publish', 'metrics'] }).notNull(),
    projectId: text('project_id'),
    // jsonb 而不是 text：租约查询要按 payload 里的字段过滤，
    // 用 text 就得在 SQL 里 ::jsonb 强转，一条非法 JSON 会让整个租约查询报错、队列卡死。
    payloadJson: jsonb('payload_json').notNull(),
    status: text('status', { enum: ['queued', 'leased', 'retrying', 'succeeded', 'failed', 'dead_letter', 'cancelled'] }).notNull().default('queued'),
    idempotencyKey: text('idempotency_key').notNull(),
    attempt: integer('attempt').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    priority: integer('priority').notNull().default(50),
    timeoutSeconds: integer('timeout_seconds').notNull().default(900),
    estimatedCostMicros: integer('estimated_cost_micros').notNull().default(0),
    availableAt: text('available_at').notNull(),
    leaseOwner: text('lease_owner'),
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
    index('idx_jobs_kind_status_available').on(table.kind, table.status, table.availableAt),
    index('idx_jobs_project_kind').on(table.projectId, table.kind, table.createdAt),
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
  (table) => [index('idx_qc_reports_project_created').on(table.projectId, table.createdAt)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    kind: text('kind', { enum: ['research', 'script', 'qc', 'publish'] }).notNull(),
    decision: text('decision', { enum: ['approved', 'changes_requested', 'rejected'] }).notNull(),
    subjectHash: text('subject_hash').notNull(),
    actorId: text('actor_id').notNull(),
    actorRole: text('actor_role').notNull(),
    note: text('note').notNull(),
    createdAt: text('created_at').notNull(),
    /** 插入顺序；PG 无隐式 rowid，用它做 created_at 同值时的确定性 tiebreak。 */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (table) => [index('idx_approvals_project_kind_created').on(table.projectId, table.kind, table.createdAt)],
);

export const publishJobs = pgTable(
  'publish_jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    channel: text('channel').notNull(),
    logicalKey: text('logical_key').notNull(),
    status: text('status', { enum: ['draft', 'scheduled', 'publishing', 'published', 'failed', 'withdrawn'] }).notNull(),
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
    uniqueIndex('idx_publish_jobs_logical_key').on(table.channel, table.logicalKey),
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
  (table) => [index('idx_metric_snapshots_project_captured').on(table.projectId, table.capturedAt), uniqueIndex('idx_metric_snapshots_idempotency').on(table.projectId, table.idempotencyKey)],
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
    index('idx_audit_events_project_created').on(table.projectId, table.createdAt),
    index('idx_audit_events_entity').on(table.entityType, table.entityId, table.createdAt),
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
    status: text('status', { enum: ['accepted', 'processed', 'rejected'] }).notNull(),
    occurredAt: text('occurred_at'),
    payloadJson: text('payload_json').notNull(),
    receivedAt: text('received_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_webhook_events_provider_external').on(table.provider, table.externalEventId),
    index('idx_webhook_events_received').on(table.receivedAt),
  ],
);

export const contentIncidents = pgTable(
  'content_incidents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    publishJobId: text('publish_job_id'),
    kind: text('kind', { enum: ['correction', 'withdrawal', 'fact_update', 'complaint'] }).notNull(),
    severity: text('severity', { enum: ['low', 'medium', 'high', 'critical'] }).notNull(),
    status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
    reason: text('reason').notNull(),
    resolution: text('resolution'),
    actorId: text('actor_id').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_content_incidents_status_created').on(table.status, table.createdAt)],
);

export const experiments = pgTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    hypothesis: text('hypothesis').notNull(),
    status: text('status', { enum: ['draft', 'running', 'completed', 'cancelled'] }).notNull().default('draft'),
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
  (table) => [index('idx_experiments_status_created').on(table.status, table.createdAt)],
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
  (table) => [uniqueIndex('idx_project_experiment_unique').on(table.projectId, table.experimentId)],
);

export const calibrationRuns = pgTable(
  'calibration_runs',
  {
    id: text('id').primaryKey(),
    algorithmVersion: text('algorithm_version').notNull(),
    datasetLabel: text('dataset_label').notNull(),
    caseCount: integer('case_count').notNull(),
    metricsJson: text('metrics_json').notNull(),
    status: text('status', { enum: ['candidate', 'approved', 'rejected'] }).notNull().default('candidate'),
    createdBy: text('created_by').notNull(),
    approvedBy: text('approved_by'),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('idx_calibration_runs_status_created').on(table.status, table.createdAt)],
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
    status: text('status', { enum: ['succeeded', 'partial', 'failed', 'skipped'] }).notNull(),
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

/** 待办箱：需要人处理的每一件事，去重键保证同一件事不会每轮 tick 重复产生。 */
export const attentionItems = pgTable(
  'attention_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind', {
      enum: ['gate_blocked', 'qc_failed', 'dead_letter', 'evidence_conflict', 'budget_exceeded', 'breaker_open', 'auto_approval_rejected', 'topic_quality', 'no_worker', 'incident_open', 'metrics_due', 'automation_actor_missing'],
    }).notNull(),
    severity: text('severity', { enum: ['info', 'warning', 'critical'] }).notNull().default('warning'),
    projectId: text('project_id'),
    topicId: text('topic_id'),
    policyId: text('policy_id'),
    dedupeKey: text('dedupe_key').notNull(),
    reason: text('reason').notNull(),
    detailJson: text('detail_json').notNull().default('{}'),
    status: text('status', { enum: ['open', 'resolved'] }).notNull().default('open'),
    notifiedAt: text('notified_at'),
    notifyError: text('notify_error'),
    resolvedBy: text('resolved_by'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_attention_items_dedupe').on(table.dedupeKey),
    index('idx_attention_items_status_created').on(table.status, table.createdAt),
    index('idx_attention_items_project').on(table.projectId, table.status),
  ],
);
