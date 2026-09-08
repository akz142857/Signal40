import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const pipelineRuns = sqliteTable(
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

export const articles = sqliteTable(
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

export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    keywordsJson: text('keywords_json').notNull().default('[]'),
    runId: text('run_id').references(() => pipelineRuns.id, {
      onDelete: 'set null',
    }),
    score: integer('score').notNull(),
    heatChange: integer('heat_change').notNull().default(0),
    scoreBreakdownJson: text('score_breakdown_json').notNull(),
    sourceCount: integer('source_count').notNull(),
    status: text('status', {
      enum: ['ready', 'needs_primary_source', 'needs_corroboration'],
    }).notNull(),
    gateJson: text('gate_json').notNull(),
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

export const topicArticles = sqliteTable(
  'topic_articles',
  {
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
  },
  (table) => [
    uniqueIndex('idx_topic_articles_pair').on(table.topicId, table.articleId),
    index('idx_topic_articles_article').on(table.articleId),
  ],
);

export const verificationEvents = sqliteTable(
  'verification_events',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    status: text('status', {
      enum: ['unreviewed', 'verified', 'rejected'],
    }).notNull(),
    note: text('note').notNull().default(''),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_verification_topic_created').on(table.topicId, table.createdAt),
  ],
);

export const sourceConfigs = sqliteTable(
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
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
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

export const teamMembers = sqliteTable(
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

export const ingestionRuns = sqliteTable(
  'ingestion_runs',
  {
    id: text('id').primaryKey(),
    sourceConfigId: text('source_config_id').notNull().references(() => sourceConfigs.id, { onDelete: 'cascade' }),
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

export const articleRevisions = sqliteTable(
  'article_revisions',
  {
    id: text('id').primaryKey(),
    articleId: text('article_id').notNull().references(() => articles.id, { onDelete: 'cascade' }),
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

export const contentProjects = sqliteTable(
  'content_projects',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id').notNull().references(() => topics.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    state: text('state').notNull().default('DRAFT'),
    version: integer('version').notNull().default(1),
    ownerId: text('owner_id').notNull(),
    brand: text('brand').notNull().default('Signal 40'),
    locale: text('locale').notNull().default('zh-CN'),
    projectJson: text('project_json').notNull(),
    immutableHash: text('immutable_hash').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_content_projects_topic').on(table.topicId),
    index('idx_content_projects_state_updated').on(table.state, table.updatedAt),
  ],
);

export const claims = sqliteTable(
  'claims',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
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

export const evidenceLinks = sqliteTable(
  'evidence_links',
  {
    id: text('id').primaryKey(),
    claimId: text('claim_id').notNull().references(() => claims.id, { onDelete: 'cascade' }),
    articleId: text('article_id').references(() => articles.id, { onDelete: 'set null' }),
    articleRevisionId: text('article_revision_id').references(() => articleRevisions.id, { onDelete: 'set null' }),
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

export const researchSnapshots = sqliteTable(
  'research_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
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

export const scriptVersions = sqliteTable(
  'script_versions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    scriptJson: text('script_json').notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('idx_script_versions_project_version').on(table.projectId, table.version)],
);

export const storyboardVersions = sqliteTable(
  'storyboard_versions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    storyboardJson: text('storyboard_json').notNull(),
    contentHash: text('content_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('idx_storyboard_versions_project_version').on(table.projectId, table.version)],
);

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
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

export const assetUploadSessions = sqliteTable(
  'asset_upload_sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
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

export const voiceTracks = sqliteTable(
  'voice_tracks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
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

export const captionTracks = sqliteTable(
  'caption_tracks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    voiceTrackId: text('voice_track_id').references(() => voiceTracks.id, { onDelete: 'set null' }),
    format: text('format', { enum: ['json', 'srt', 'vtt'] }).notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_caption_tracks_project_created').on(table.projectId, table.createdAt)],
);

export const renderSnapshots = sqliteTable(
  'render_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    snapshotJson: text('snapshot_json').notNull(),
    snapshotHash: text('snapshot_hash').notNull(),
    templateVersion: text('template_version').notNull(),
    templateId: text('template_id').notNull().default('signal40-editorial'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('idx_render_snapshots_hash').on(table.projectId, table.snapshotHash)],
);

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['ingestion', 'voice', 'preview', 'render', 'qc', 'publish', 'metrics'] }).notNull(),
    projectId: text('project_id').references(() => contentProjects.id, { onDelete: 'cascade' }),
    payloadJson: text('payload_json').notNull(),
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
    index('idx_jobs_project_kind').on(table.projectId, table.kind, table.createdAt),
  ],
);

export const qcReports = sqliteTable(
  'qc_reports',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    renderJobId: text('render_job_id').references(() => jobs.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['pending', 'passed', 'failed'] }).notNull(),
    checksJson: text('checks_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_qc_reports_project_created').on(table.projectId, table.createdAt)],
);

export const approvals = sqliteTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['research', 'script', 'qc', 'publish'] }).notNull(),
    decision: text('decision', { enum: ['approved', 'changes_requested', 'rejected'] }).notNull(),
    subjectHash: text('subject_hash').notNull(),
    actorId: text('actor_id').notNull(),
    actorRole: text('actor_role').notNull(),
    note: text('note').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_approvals_project_kind_created').on(table.projectId, table.kind, table.createdAt)],
);

export const publishJobs = sqliteTable(
  'publish_jobs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
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

export const metricSnapshots = sqliteTable(
  'metric_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    publishJobId: text('publish_job_id').references(() => publishJobs.id, { onDelete: 'set null' }),
    idempotencyKey: text('idempotency_key').notNull(),
    capturedAt: text('captured_at').notNull(),
    metricsJson: text('metrics_json').notNull(),
    attributionJson: text('attribution_json').notNull(),
  },
  (table) => [index('idx_metric_snapshots_project_captured').on(table.projectId, table.capturedAt), uniqueIndex('idx_metric_snapshots_idempotency').on(table.projectId, table.idempotencyKey)],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').references(() => contentProjects.id, { onDelete: 'set null' }),
    actorId: text('actor_id').notNull(),
    actorRole: text('actor_role').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    requestId: text('request_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('idx_audit_events_project_created').on(table.projectId, table.createdAt),
    index('idx_audit_events_entity').on(table.entityType, table.entityId, table.createdAt),
  ],
);

export const idempotencyRecords = sqliteTable(
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

export const webhookEvents = sqliteTable(
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

export const contentIncidents = sqliteTable(
  'content_incidents',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    publishJobId: text('publish_job_id').references(() => publishJobs.id, { onDelete: 'set null' }),
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

export const experiments = sqliteTable(
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

export const projectExperimentAssignments = sqliteTable(
  'project_experiment_assignments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull().references(() => contentProjects.id, { onDelete: 'cascade' }),
    experimentId: text('experiment_id').notNull().references(() => experiments.id, { onDelete: 'cascade' }),
    variant: text('variant').notNull(),
    assignmentHash: text('assignment_hash').notNull(),
    assignedAt: text('assigned_at').notNull(),
  },
  (table) => [uniqueIndex('idx_project_experiment_unique').on(table.projectId, table.experimentId)],
);

export const calibrationRuns = sqliteTable(
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
