import type { SqlDatabase } from './sql.ts';
import type { ObjectStorage } from './storage.ts';
import type { Actor, ProjectRecord } from './control-plane.ts';
import {
  enqueueIngestionRun,
  enqueueJob,
  evaluateProjectGates,
  createContentProject,
  loadContentProject,
  pauseProjectAutomation,
  recordApproval,
  schedulePublishJob,
  transitionContentProject,
} from './control-plane.ts';
import {
  sourceMonthSpendMicros,
  SourceBudgetExceededError,
} from './source-budget.ts';
import {
  decideSourceScheduleThrottle,
  persistSourceScheduleAdvance,
} from './source-schedule-throttle.ts';
import {
  activeAutomationPolicies,
  autoApprovalDecision,
  inQuietHours,
  policyMatchesProject,
  policyMatchesTopic,
  resolveAuthorizedMember,
  stageMode,
  type ApprovalKind,
  type AutomationPolicy,
  type AutomationStage,
} from './automation.ts';
import { raiseAttentionItem, notifyPendingAttention } from './attention.ts';
import { expireDueSourceRights } from './source-rights.ts';
import { reconcileSourceOwnership } from './source-ownership.ts';
import { assessTopicQuality, type TopicQuality } from './topic-quality.ts';
import { loadTopic } from './persistence.ts';
import { createProjectV2 } from './project-v2.ts';
import { evaluateScriptDuration } from './script-duration.ts';
import { checkScriptCompliance } from './script-compliance.ts';
import { nextScheduledMinute } from './schedule.ts';
import { purgeExpiredSourcePayloads } from './source-retention.ts';
import { processSourceLegalDeletions } from './source-legal-deletion.ts';
import { raiseSourceSloBurnAlerts } from './source-slo.ts';
import { sourceConnectorByPlatform } from './source-connectors/registry.ts';
import { evaluateConnectorCanaries } from './source-release-control.ts';
import { listWorkers, orphanedJobs, pruneStaleWorkers } from './workers.ts';
import {
  stableHash,
  WorkflowError,
  type ContentState,
  type GateResult,
  type Role,
} from './workflow.ts';

/**
 * 编排引擎：替人按按钮，不替人做判断。
 *
 * 三条不可让步的约束：
 *
 * 1. **只走状态机**——推进一律调用 `transitionContentProject`，门禁照常重算，
 *    引擎不直接写 `state`，也不放宽任何阈值；
 * 2. **身份是真的**——机械步骤用注册在 `team_members` 里的服务账号，
 *    自动审批写入策略里那个真人的 `actor_id`，问责链因此指向具体的人；
 * 3. **有界**——每轮 tick 的项目数、入队作业数、发布数都有上限，
 *    超出的留到下一轮；确定性失败不重试到死，连续失败会熔断整个阶段。
 *
 * 引擎接受注入的 `now`，和 `lib/` 其余部分一致，便于测试。
 */

/** 一轮 tick 的工作量上限。超出部分留到下一轮，避免 tick 相互重叠。 */
export type TickLimits = {
  sources: number;
  topics: number;
  projectCreations: number;
  projects: number;
  jobs: number;
  publishes: number;
  notifications: number;
  /** 外部 HTTP / 对象存储调用总上限。数据库调用不计入。 */
  apiCalls: number;
  /** 单个项目一轮最多推进几步，避免一个项目吃掉整轮预算。 */
  stepsPerProject: number;
};

export const DEFAULT_TICK_LIMITS: TickLimits = {
  sources: 50,
  topics: 100,
  projectCreations: 3,
  projects: 20,
  jobs: 20,
  publishes: 3,
  notifications: 20,
  apiCalls: 50,
  stepsPerProject: 3,
};

/** 同一阶段连续失败这么多次就熔断，暂停该阶段并进待办箱。 */
export const BREAKER_FAILURE_THRESHOLD = 3;
/** 熔断冷却时长；冷却结束后放行一次，成功即复位。 */
export const BREAKER_COOLDOWN_MS = 15 * 60_000;
/** 选取本轮项目集合用的短锁；多个调度器实例并发时只有一个能选到同一批项目。 */
export const AUTOMATION_ADVISORY_LOCK_KEY = 519_400_001;

export type BreakerState = Record<
  string,
  { failures: number; openedAt: string | null; lastError: string }
>;

export type TickAction = {
  stage: AutomationStage | 'cleanup' | 'notify';
  action: string;
  projectId?: string | null;
  topicId?: string | null;
  policyId?: string | null;
  detail?: unknown;
};

export type AutomationTickResult = {
  runId: string;
  trigger: 'scheduler' | 'manual';
  status: 'succeeded' | 'partial' | 'failed' | 'skipped';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  projectCount: number;
  actions: TickAction[];
  errors: Array<{ stage: string; message: string }>;
  breakers: BreakerState;
  skippedReason?: string;
};

export type OrchestratorContext = {
  db: SqlDatabase;
  storage?: ObjectStorage;
  now?: Date;
  trigger?: 'scheduler' | 'manual';
  limits?: Partial<TickLimits>;
  /** `team_members` 里的服务账号 user_id；缺失时引擎不做任何写入。 */
  automationActorId?: string;
  monthlyRenderBudgetMicros?: number;
  notify?: { url?: string; secret?: string };
  fetchImpl?: typeof fetch;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

/** 服务账号：机械步骤以它的身份写入，必须真实存在且是 admin（要覆盖所有状态转换）。 */
/**
 * 编排引擎以哪个身份写入。解析不出来 tick 就整轮不做任何写入，
 * 所以自动化控制台也用这一个函数判断「引擎到底能不能干活」——
 * 界面重新实现一遍判据，就会出现界面说正常而引擎空转的情况。
 */
export async function resolveAutomationActor(
  db: SqlDatabase,
  userId: string | undefined,
): Promise<Actor | null> {
  if (!userId) return null;
  const member = await db
    .prepare(
      "SELECT user_id, email, role FROM team_members WHERE user_id = ? AND status = 'active' LIMIT 1",
    )
    .bind(userId)
    .first<{ user_id: string; email: string; role: Role }>();
  if (!member || member.role !== 'admin') return null;
  return { id: member.user_id, email: member.email, role: member.role };
}

async function previousBreakers(db: SqlDatabase): Promise<BreakerState> {
  const row = await db
    .prepare(
      'SELECT breakers_json FROM automation_runs ORDER BY started_at DESC LIMIT 1',
    )
    .first<{ breakers_json: string }>();
  return parseJson<BreakerState>(row?.breakers_json, {});
}

function breakerOpen(breakers: BreakerState, stage: string, now: Date) {
  const state = breakers[stage];
  if (!state || state.failures < BREAKER_FAILURE_THRESHOLD || !state.openedAt)
    return false;
  return (
    now.valueOf() - new Date(state.openedAt).valueOf() < BREAKER_COOLDOWN_MS
  );
}

function recordFailure(
  breakers: BreakerState,
  stage: string,
  message: string,
  now: Date,
) {
  const state = breakers[stage] ?? {
    failures: 0,
    openedAt: null,
    lastError: '',
  };
  const failures = state.failures + 1;
  breakers[stage] = {
    failures,
    openedAt:
      failures >= BREAKER_FAILURE_THRESHOLD
        ? now.toISOString()
        : state.openedAt,
    lastError: message.slice(0, 500),
  };
}

function recordSuccess(breakers: BreakerState, stage: string) {
  if (breakers[stage])
    breakers[stage] = { failures: 0, openedAt: null, lastError: '' };
}

/** 项目当前状态下的下一步机械动作；返回 null 表示这一步需要人。 */
const NEXT_STATE: Partial<Record<ContentState, ContentState>> = {
  DRAFT: 'RESEARCHING',
  RESEARCHING: 'EVIDENCE_READY',
  EVIDENCE_READY: 'EDITOR_APPROVED',
  EDITOR_APPROVED: 'SCRIPT_DRAFT',
  SCRIPT_DRAFT: 'SCRIPT_APPROVED',
  SCRIPT_APPROVED: 'ASSETS_READY',
  ASSETS_READY: 'RENDER_QUEUED',
  QC_PENDING: 'QC_APPROVED',
  QC_APPROVED: 'PUBLISH_SCHEDULED',
  PUBLISHED: 'MEASURED',
};

/** 目标状态对应的问责审批；没有对应项说明这一步是纯机械的。 */
const APPROVAL_FOR_STATE: Partial<Record<ContentState, ApprovalKind>> = {
  EDITOR_APPROVED: 'research',
  SCRIPT_APPROVED: 'script',
  QC_APPROVED: 'qc',
  PUBLISH_SCHEDULED: 'publish',
};

function gate(gates: readonly GateResult[], code: string) {
  return gates.find((item) => item.code === code);
}

function subjectHashFor(kind: ApprovalKind, project: ProjectRecord) {
  if (kind === 'research') return project.project.research.approvedHash;
  if (kind === 'script') return stableHash(project.project.script);
  return project.immutableHash;
}

async function projectHasOpenIncident(db: SqlDatabase, projectId: string) {
  const row = await db
    .prepare(
      "SELECT id FROM content_incidents WHERE project_id = ? AND status = 'open' LIMIT 1",
    )
    .bind(projectId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function latestQcPassed(db: SqlDatabase, projectId: string) {
  const row = await db
    .prepare(
      'SELECT status FROM qc_reports WHERE project_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1',
    )
    .bind(projectId)
    .first<{ status: string }>();
  return row?.status === 'passed';
}

async function dailyAutoPublishCount(
  db: SqlDatabase,
  policyId: string,
  now: Date,
) {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const row = await db
    .prepare(`
      SELECT COUNT(*) AS total FROM audit_events
      WHERE action = 'publish.scheduled' AND created_at >= ?
        AND metadata_json ->> 'trigger' = 'automation' AND metadata_json ->> 'policyId' = ?
    `)
    .bind(dayStart, policyId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function dailyAutoProjectCount(
  db: SqlDatabase,
  policyId: string,
  now: Date,
) {
  const dayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS total FROM content_projects WHERE automation_policy_id = ? AND created_at >= ?',
    )
    .bind(policyId, dayStart)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function projectCostMicros(db: SqlDatabase, projectId: string) {
  const row = await db
    .prepare(
      'SELECT COALESCE(SUM(CASE WHEN cost_micros > 0 THEN cost_micros ELSE estimated_cost_micros END), 0) AS total FROM jobs WHERE project_id = ?',
    )
    .bind(projectId)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function monthlyRenderCostMicros(db: SqlDatabase, now: Date) {
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(CASE WHEN cost_micros > 0 THEN cost_micros ELSE estimated_cost_micros END), 0) AS total FROM jobs WHERE kind IN ('preview', 'render') AND created_at >= ? AND status != 'cancelled'",
    )
    .bind(monthStart)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

type StageRunner = {
  db: SqlDatabase;
  now: Date;
  actor: Actor;
  limits: TickLimits;
  actions: TickAction[];
  errors: Array<{ stage: string; message: string }>;
  breakers: BreakerState;
  context: OrchestratorContext;
  jobsEnqueued: number;
  publishesScheduled: number;
  apiCalls: number;
};

async function jobBudgetState(
  runner: StageRunner,
  kind: string,
  idempotencyKey: string,
) {
  if (runner.jobsEnqueued < runner.limits.jobs) return 'available' as const;
  const existing = await runner.db
    .prepare(
      'SELECT id FROM jobs WHERE kind = ? AND idempotency_key = ? LIMIT 1',
    )
    .bind(kind, idempotencyKey)
    .first();
  return existing ? ('exists' as const) : ('blocked' as const);
}

async function fail(
  runner: StageRunner,
  stage: AutomationStage | 'cleanup' | 'notify',
  error: unknown,
  detail: { projectId?: string; topicId?: string; policyId?: string } = {},
) {
  const message = error instanceof Error ? error.message : String(error);
  runner.errors.push({ stage, message });
  recordFailure(runner.breakers, stage, message, runner.now);
  if ((runner.breakers[stage]?.failures ?? 0) >= BREAKER_FAILURE_THRESHOLD) {
    await raiseAttentionItem(
      runner.db,
      {
        kind: 'breaker_open',
        severity: 'critical',
        projectId: detail.projectId ?? null,
        policyId: detail.policyId ?? null,
        dedupeKey: `breaker:${stage}`,
        reason: `阶段 ${stage} 连续失败 ${runner.breakers[stage]?.failures ?? BREAKER_FAILURE_THRESHOLD} 次已熔断：${message}`,
        detail: { stage, message },
      },
      runner.now,
    );
  }
}

/** 1. 采集：按持久化 next_run_at 公平领取到期且已获授权的来源。 */
async function runIngestion(runner: StageRunner, allowed: boolean) {
  if (!allowed) return;
  const { db, now, actor, limits } = runner;
  const errorsBefore = runner.errors.length;
  const workers = await listWorkers(db, now);
  const online = workers.filter(
    (worker) => worker.online && worker.kinds.includes('ingestion'),
  );
  const rows = await db
    .prepare(`
      SELECT sc.id, sc.adapter, sc.platform, sc.checkpoint, sc.checkpoint_json, sc.version,
        sc.schedule_cron, sc.next_run_at, sc.schedule_priority,
        sc.auto_throttle_enabled, sc.monthly_budget_micros,
        sc.budget_soft_limit_percent
      FROM source_configs sc
      WHERE sc.enabled = 1 AND sc.lifecycle_status IN ('enabled', 'degraded')
        AND sc.rights_status = 'approved' AND sc.schedule_cron IS NOT NULL
        AND sc.next_run_at IS NOT NULL AND sc.next_run_at <= ?
        AND (sc.backoff_until IS NULL OR sc.backoff_until <= ?)
        AND sc.active_run_id IS NULL
        AND EXISTS (
          SELECT 1 FROM source_rights_grants grant_row
          WHERE grant_row.source_config_id = sc.id
            AND grant_row.config_hash = COALESCE(NULLIF(sc.rights_config_hash, ''), sc.config_hash)
            AND grant_row.source_version <= sc.version
            AND grant_row.purpose = 'finance-editorial-ingestion'
            AND grant_row.usage_scope IN ('normalized-metadata', 'normalized-and-authorized-raw')
            AND grant_row.revoked_at IS NULL
            AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
        )
      ORDER BY sc.next_run_at ASC, sc.id ASC
      LIMIT ?
    `)
    .bind(
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      limits.sources,
    )
    .all<{
      id: string;
      adapter: string;
      platform: string;
      checkpoint: string | null;
      checkpoint_json: unknown;
      version: number;
      schedule_cron: string;
      next_run_at: string;
      schedule_priority: number;
      auto_throttle_enabled: number;
      monthly_budget_micros: number | string;
      budget_soft_limit_percent: number;
    }>();
  for (const source of rows.results) {
    const scheduledMinute = source.next_run_at;
    const connector = sourceConnectorByPlatform(source.platform);
    const requiredCapability =
      connector?.requiredCapability ?? `source:${source.adapter}`;
    const requiredCapabilityProtocolVersion =
      connector?.capabilityProtocolVersion ?? 1;
    if (
      !online.some(
        (worker) =>
          worker.capabilities.includes(requiredCapability) &&
          (worker.capabilityProtocolVersions[requiredCapability] ?? 0) >=
            requiredCapabilityProtocolVersion,
      )
    ) {
      await raiseAttentionItem(
        db,
        {
          kind: 'no_worker',
          severity: 'critical',
          dedupeKey: `source_capability:${source.id}:${requiredCapability}`,
          reason: `来源缺少在线 Worker 能力 ${requiredCapability} 协议 v${requiredCapabilityProtocolVersion}，调度未创建无法执行的作业。`,
          detail: {
            sourceConfigId: source.id,
            requiredCapability,
            requiredCapabilityProtocolVersion,
          },
        },
        now,
      );
      continue;
    }
    const idempotencyKey = `schedule:${source.id}:${scheduledMinute}`;
    const budget = await jobBudgetState(runner, 'ingestion', idempotencyKey);
    if (budget === 'blocked') break;
    try {
      const job = await enqueueIngestionRun(
        db,
        {
          sourceConfigId: source.id,
          checkpoint: source.checkpoint,
          checkpointJson: parseJson(source.checkpoint_json, {}),
          sourceVersion: source.version,
          runTrigger: 'schedule',
          scheduledFor: scheduledMinute,
          // 幂等键绑定「哪个来源的哪一分钟」：tick 重入不会重复入队。
          idempotencyKey,
          actor,
          trigger: 'automation',
        },
        now,
      );
      if (job.created) {
        runner.jobsEnqueued += 1;
        runner.actions.push({
          stage: 'ingestion',
          action: 'ingestion.enqueued',
          detail: { sourceConfigId: source.id, scheduledMinute, jobId: job.id },
        });
      }
      const monthSpentMicros = await sourceMonthSpendMicros(
        db,
        source.id,
        now,
      );
      const throttleDecision = decideSourceScheduleThrottle({
        schedulePriority: source.schedule_priority,
        autoThrottleEnabled: Boolean(source.auto_throttle_enabled),
        monthSpentMicros,
        monthlyBudgetMicros: Number(source.monthly_budget_micros),
        softLimitPercent: source.budget_soft_limit_percent,
        now,
      });
      const scheduleAdvance = await persistSourceScheduleAdvance(
        db,
        {
          sourceId: source.id,
          scheduleCron: source.schedule_cron,
          scheduledFor: scheduledMinute,
          decision: throttleDecision,
          actor,
        },
        now,
      );
      if (
        scheduleAdvance.advanced &&
        throttleDecision.cadenceMultiplier > 1
      ) {
        runner.actions.push({
          stage: 'ingestion',
          action: 'ingestion.schedule_throttled',
          detail: {
            sourceConfigId: source.id,
            scheduledMinute,
            schedulePriority: throttleDecision.schedulePriority,
            cadenceMultiplier: throttleDecision.cadenceMultiplier,
            skippedOccurrences: scheduleAdvance.skipped,
            recoveryAt: throttleDecision.recoveryAt,
          },
        });
      }
    } catch (error) {
      if (error instanceof SourceBudgetExceededError) {
        const nextRunAt = nextScheduledMinute(
          source.schedule_cron,
          scheduledMinute,
        );
        if (nextRunAt) {
          await db
            .prepare(
              `UPDATE source_configs SET next_run_at = ?,
                effective_schedule_multiplier = 1,
                schedule_throttle_reason = NULL,
                schedule_throttle_recovery_at = NULL,
                updated_at = ? WHERE id = ? AND next_run_at = ?`,
            )
            .bind(nextRunAt, now.toISOString(), source.id, scheduledMinute)
            .run();
        }
        runner.actions.push({
          stage: 'ingestion',
          action: 'ingestion.budget_blocked',
          detail: { sourceConfigId: source.id, scheduledMinute },
        });
        continue;
      }
      await fail(runner, 'ingestion', error);
    }
  }
  // 只有整轮没出错才复位：出过错还复位，等于永远攒不够连续失败次数，熔断形同虚设。
  if (runner.errors.length === errorsBefore)
    recordSuccess(runner.breakers, 'ingestion');
}

/** 2. 选题质量评估：写入 `topics.quality_json`，不达标的进待办箱。 */
async function runTopicQuality(
  runner: StageRunner,
  allowed: boolean,
  policies: AutomationPolicy[],
) {
  if (!allowed) return;
  const { db, now, limits } = runner;
  const errorsBefore = runner.errors.length;
  const rows = await db
    .prepare(`
      SELECT t.id, t.score, t.updated_at, t.quality_json
      FROM topics t
      WHERE t.quality_json = '{}' OR t.quality_json IS NULL
      ORDER BY t.score DESC LIMIT ?
    `)
    .bind(limits.topics)
    .all<{
      id: string;
      score: number;
      updated_at: string;
      quality_json: string;
    }>();
  const minScore = policies.length
    ? Math.min(...policies.map((policy) => policy.scope.minTopicScore))
    : 60;
  for (const row of rows.results) {
    try {
      const topic = await loadTopic(db, row.id);
      if (!topic) continue;
      const quality = assessTopicQuality(topic, now);
      await db.batch([
        db
          .prepare('UPDATE topics SET quality_json = ? WHERE id = ?')
          .bind(JSON.stringify(quality), row.id),
        db
          .prepare(`
          INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
          VALUES (?, ?, ?, 'topic.quality_assessed', 'topic', ?, ?, ?, ?, ?)
        `)
          .bind(
            `audit_${crypto.randomUUID()}`,
            runner.actor.id,
            runner.actor.role,
            row.id,
            stableHash(quality),
            JSON.stringify({
              trigger: 'automation',
              score: quality.score,
              automatable: quality.automatable,
            }),
            crypto.randomUUID(),
            now.toISOString(),
          ),
      ]);
      runner.actions.push({
        stage: 'topic_quality',
        action: 'topic.quality_assessed',
        topicId: row.id,
        detail: {
          automatable: quality.automatable,
          score: quality.score,
          coherence: quality.coherence,
        },
      });
      // 只有「本来够格进自动化」的选题才值得打扰人：门禁已过、分数达标，却因为质量指标被挡下。
      if (
        !quality.automatable &&
        topic.gate.passed &&
        topic.score >= minScore
      ) {
        await raiseAttentionItem(
          db,
          {
            kind: 'topic_quality',
            severity: 'info',
            topicId: row.id,
            dedupeKey: `topic_quality:${row.id}`,
            reason: `选题质量不达标，未自动建项目：${quality.reasons.join('；')}`,
            detail: quality,
          },
          now,
        );
      }
    } catch (error) {
      await fail(runner, 'topic_quality', error, { topicId: row.id });
    }
  }
  if (runner.errors.length === errorsBefore)
    recordSuccess(runner.breakers, 'topic_quality');
}

/** 3. 建项目：达标选题 + 策略允许 + 未超日限额。 */
async function runProjectCreation(
  runner: StageRunner,
  policies: AutomationPolicy[],
) {
  const { db, now, actor, limits } = runner;
  let created = 0;
  for (const policy of policies) {
    if (stageMode(policy, 'project_creation') !== 'auto') continue;
    const dailyCount = await dailyAutoProjectCount(db, policy.id, now);
    const rows = await db
      .prepare(`
        SELECT t.id, t.score, t.quality_json FROM topics t
        WHERE t.id NOT IN (SELECT topic_id FROM content_projects)
          AND t.status = 'ready'
        ORDER BY t.score DESC LIMIT ?
      `)
      .bind(limits.topics)
      .all<{ id: string; score: number; quality_json: string }>();
    for (const row of rows.results) {
      if (created >= limits.projectCreations) return;
      if (dailyCount + created >= policy.guardrails.dailyProjectLimit) {
        await raiseAttentionItem(
          db,
          {
            kind: 'budget_exceeded',
            severity: 'info',
            policyId: policy.id,
            dedupeKey: `daily_project_limit:${policy.id}:${now.toISOString().slice(0, 10)}`,
            reopenResolved: false,
            reason: `策略「${policy.name}」当日自动建项目已达上限 ${policy.guardrails.dailyProjectLimit}。`,
            detail: { policyId: policy.id },
          },
          now,
        );
        break;
      }
      const quality = parseJson<TopicQuality | Record<string, never>>(
        row.quality_json,
        {},
      );
      try {
        const topic = await loadTopic(db, row.id);
        if (
          !topic ||
          topic.verificationStatus !== 'verified' ||
          !topic.gate.passed
        )
          continue;
        const sourceTypes = [
          ...new Set(topic.articles.map((article) => article.sourceType)),
        ];
        if (
          !policyMatchesTopic(policy, {
            score: row.score,
            sourceTypes,
            quality: quality as TopicQuality,
          })
        )
          continue;
        const project = createProjectV2(topic, now);
        if (
          !policyMatchesProject(policy, {
            brand: project.identity.brand,
            locale: project.identity.locale,
          })
        )
          continue;
        const result = await createContentProject(db, project, actor, now, {
          trigger: 'automation',
          policyId: policy.id,
        });
        if (!result.created) continue;
        created += 1;
        runner.actions.push({
          stage: 'project_creation',
          action: 'project.created',
          projectId: result.project.id,
          topicId: row.id,
          policyId: policy.id,
        });
      } catch (error) {
        // 建项目失败通常是选题本身不够格（没有可冻结的原始声明），
        // 属于确定性失败：记一条待办，不重试。
        await raiseAttentionItem(
          db,
          {
            kind: 'topic_quality',
            severity: 'info',
            topicId: row.id,
            policyId: policy.id,
            dedupeKey: `project_creation:${row.id}`,
            reason: `自动建项目失败：${error instanceof Error ? error.message : String(error)}`,
          },
          now,
        ).catch(() => undefined);
      }
    }
  }
  recordSuccess(runner.breakers, 'project_creation');
}

async function tryAutoApproval(
  runner: StageRunner,
  policy: AutomationPolicy,
  project: ProjectRecord,
  gates: readonly GateResult[],
  kind: ApprovalKind,
) {
  const { db, now } = runner;
  const independentSourceCount = new Set(
    project.project.research.claims.flatMap((claim) =>
      claim.evidence.map((evidence) => evidence.sourceId),
    ),
  ).size;
  const unresolvedConflicts = project.project.research.conflicts.filter(
    (conflict) => !conflict.resolution?.trim(),
  ).length;
  const duration = evaluateScriptDuration({
    lines: project.project.script.lines,
    targetDurationSeconds: project.project.render.durationSeconds,
    speed: project.project.audio.speed,
  });
  const quality = await db
    .prepare('SELECT quality_json FROM topics WHERE id = ? LIMIT 1')
    .bind(project.topicId)
    .first<{ quality_json: string }>();
  const decision = autoApprovalDecision(policy, kind, {
    gates,
    independentSourceCount,
    unresolvedConflicts,
    scriptDurationOk: duration.status === 'ok',
    scriptCompliance: checkScriptCompliance(project.project.script),
    topicQualityOk: Boolean(
      parseJson<{ automatable?: boolean }>(quality?.quality_json, {})
        .automatable,
    ),
    qcPassed: await latestQcPassed(db, project.id),
    dailyPublishCount: await dailyAutoPublishCount(db, policy.id, now),
    now,
  });
  if (!decision.allowed) {
    await raiseAttentionItem(
      db,
      {
        kind: 'auto_approval_rejected',
        severity: 'warning',
        projectId: project.id,
        policyId: policy.id,
        dedupeKey: `auto_approval:${project.id}:${kind}:${subjectHashFor(kind, project)}`,
        reason: `${kind} 自动放行被拒，转人工：${decision.reasons.join('；')}`,
        detail: { kind, reasons: decision.reasons },
      },
      now,
    );
    return { approved: false, reasons: decision.reasons };
  }
  // 授权人在保存策略时校验过一次，这里再校验一次：成员可能已经离职或被降权。
  const authorizedId =
    kind === 'publish'
      ? policy.publishAuthorizedBy
      : policy.researchAuthorizedBy;
  const member = await resolveAuthorizedMember(db, authorizedId, kind);
  if (!member) {
    await raiseAttentionItem(
      db,
      {
        kind: 'auto_approval_rejected',
        severity: 'critical',
        projectId: project.id,
        policyId: policy.id,
        dedupeKey: `auto_approval_actor:${policy.id}:${kind}`,
        reason: `策略「${policy.name}」的 ${kind} 授权人不存在、已停用或角色不足，自动放行已停止。`,
        detail: { kind, authorizedId },
      },
      now,
    );
    return { approved: false, reasons: ['授权人无效'] };
  }
  const result = await recordApproval(
    db,
    {
      projectId: project.id,
      kind,
      decision: 'approved',
      subjectHash: subjectHashFor(kind, project),
      note: `依据策略「${policy.name}」自动放行。`,
      actor: member,
      trigger: 'automation',
      policyId: policy.id,
    },
    now,
  );
  if ('error' in result) return { approved: false, reasons: [result.error] };
  runner.actions.push({
    stage: 'advance',
    action: `approval.auto_${kind}`,
    projectId: project.id,
    policyId: policy.id,
    detail: { actorId: member.id },
  });
  return { approved: true, reasons: [] };
}

/**
 * 5. 作业编排：在正确状态下入队配音与渲染，顺序约束由引擎消化。
 *
 * 返回值区分「作业已就位」和「被挡下」：ASSETS_READY 只有在渲染作业确实存在时
 * 才允许推进到 RENDER_QUEUED，否则项目会停在一个没有作业的等待状态上，谁也捞不动它。
 */
type JobStageOutcome = 'enqueued' | 'exists' | 'blocked' | 'skipped';

async function enqueueStageJobs(
  runner: StageRunner,
  policy: AutomationPolicy,
  project: ProjectRecord,
): Promise<JobStageOutcome> {
  const { db, now, actor } = runner;
  if (stageMode(policy, 'jobs') !== 'auto') return 'skipped';
  if (project.state === 'SCRIPT_APPROVED' && !project.project.audio.objectKey) {
    const scriptHash = stableHash(project.project.script);
    const idempotencyKey = `voice:${project.id}:${scriptHash}`;
    const budget = await jobBudgetState(runner, 'voice', idempotencyKey);
    if (budget === 'blocked') return 'blocked';
    const job = await enqueueJob(
      db,
      {
        kind: 'voice',
        projectId: project.id,
        payload: {
          projectId: project.id,
          scriptVersion: project.project.script.version,
          scriptHash,
        },
        idempotencyKey,
        actor,
        trigger: 'automation',
        policyId: policy.id,
      },
      now,
    );
    if (job.created) {
      runner.jobsEnqueued += 1;
      runner.actions.push({
        stage: 'jobs',
        action: 'voice.enqueued',
        projectId: project.id,
        policyId: policy.id,
        detail: { jobId: job.id },
      });
    }
    return job.created ? 'enqueued' : 'exists';
  }
  if (project.state === 'ASSETS_READY') {
    const budget = runner.context.monthlyRenderBudgetMicros ?? 0;
    if (budget > 0 && (await monthlyRenderCostMicros(db, now)) >= budget) {
      await raiseAttentionItem(
        db,
        {
          kind: 'budget_exceeded',
          severity: 'warning',
          projectId: project.id,
          policyId: policy.id,
          dedupeKey: `render_budget:${now.toISOString().slice(0, 7)}`,
          reopenResolved: false,
          reason: '本月渲染成本预算已耗尽，渲染阶段已暂停。',
        },
        now,
      );
      return 'blocked';
    }
    const perProjectLimit = policy.guardrails.maxCostMicrosPerProject;
    if (
      perProjectLimit > 0 &&
      (await projectCostMicros(db, project.id)) >= perProjectLimit
    ) {
      await raiseAttentionItem(
        db,
        {
          kind: 'budget_exceeded',
          severity: 'warning',
          projectId: project.id,
          policyId: policy.id,
          dedupeKey: `project_cost:${project.id}`,
          reopenResolved: false,
          reason: `项目累计成本已达策略上限 ${perProjectLimit} micros，自动化已停在渲染前。`,
        },
        now,
      );
      return 'blocked';
    }
    const idempotencyKey = `render:${project.id}:${project.project.render.snapshotHash}`;
    const jobBudget = await jobBudgetState(runner, 'render', idempotencyKey);
    if (jobBudget === 'blocked') return 'blocked';
    const job = await enqueueJob(
      db,
      {
        kind: 'render',
        projectId: project.id,
        payload: {
          projectId: project.id,
          snapshotHash: project.project.render.snapshotHash,
          compositionId: project.project.render.compositionId,
        },
        idempotencyKey,
        actor,
        trigger: 'automation',
        policyId: policy.id,
      },
      now,
    );
    if (job.created) {
      runner.jobsEnqueued += 1;
      await db
        .prepare(
          'INSERT INTO render_snapshots (id, project_id, snapshot_json, snapshot_hash, template_id, template_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        )
        .bind(
          `render_${crypto.randomUUID()}`,
          project.id,
          JSON.stringify(project.project),
          project.project.render.snapshotHash,
          project.project.render.templateId,
          project.project.render.templateVersion,
          actor.id,
          now.toISOString(),
        )
        .run();
      runner.actions.push({
        stage: 'jobs',
        action: 'render.enqueued',
        projectId: project.id,
        policyId: policy.id,
        detail: { jobId: job.id },
      });
    }
    return job.created ? 'enqueued' : 'exists';
  }
  return 'skipped';
}

/** 6. 发布：G7 已过且已进入 PUBLISH_SCHEDULED，按策略创建发布任务。 */
async function runPublish(
  runner: StageRunner,
  policy: AutomationPolicy,
  project: ProjectRecord,
) {
  const { db, now, actor } = runner;
  if (stageMode(policy, 'publish') !== 'auto') return false;
  if (breakerOpen(runner.breakers, 'publish', now)) return false;
  if (
    runner.publishesScheduled >= runner.limits.publishes ||
    runner.jobsEnqueued >= runner.limits.jobs
  )
    return false;
  if (inQuietHours(policy, now)) return false;
  const dailyCount = await dailyAutoPublishCount(db, policy.id, now);
  if (dailyCount >= policy.guardrails.dailyPublishLimit) return false;
  const channel =
    project.project.distribution.channelPreset === 'youtube'
      ? 'youtube'
      : 'package';
  const result = await schedulePublishJob(
    db,
    {
      projectId: project.id,
      channel,
      title: project.project.distribution.title || project.title,
      description: project.project.distribution.description,
      tags: project.project.distribution.tags,
      coverAssetId: project.project.distribution.coverAssetId,
      accountId: project.project.distribution.accountId,
      scheduledAt: project.project.distribution.scheduledAt,
      // 公开可见性永远是人的显式决定，自动化只产出 private 上传或可下载发布包。
      privacyStatus: 'private',
      actor,
      trigger: 'automation',
      policyId: policy.id,
    },
    now,
  );
  if ('error' in result) {
    await fail(runner, 'publish', new Error(result.error), {
      projectId: project.id,
      policyId: policy.id,
    });
    await raiseAttentionItem(
      db,
      {
        kind: 'gate_blocked',
        severity: 'warning',
        projectId: project.id,
        policyId: policy.id,
        dedupeKey: `publish_blocked:${project.id}:${project.version}`,
        reason: `自动创建发布任务失败：${result.error}`,
      },
      now,
    );
    return false;
  }
  if ('replayed' in result) return false;
  runner.publishesScheduled += 1;
  runner.jobsEnqueued += 1;
  recordSuccess(runner.breakers, 'publish');
  runner.actions.push({
    stage: 'publish',
    action: 'publish.scheduled',
    projectId: project.id,
    policyId: policy.id,
    detail: { channel },
  });
  return true;
}

/** 4. 推进一个项目：门禁已过且在自动范围内的转换，一轮最多 stepsPerProject 步。 */
async function advanceProject(
  runner: StageRunner,
  policy: AutomationPolicy,
  projectId: string,
) {
  const { db, now, actor, limits } = runner;
  for (let step = 0; step < limits.stepsPerProject; step += 1) {
    const project = await loadContentProject(db, projectId);
    if (!project || project.automationMode !== 'auto') return;
    // 内容事件与自动化互斥：不能一边处理勘误或投诉，一边继续往发布推。
    if (await projectHasOpenIncident(db, projectId)) {
      await pauseProjectAutomation(
        db,
        projectId,
        '项目存在未关闭的内容事件，自动化已停止。',
      );
      await raiseAttentionItem(
        db,
        {
          kind: 'incident_open',
          severity: 'critical',
          projectId,
          policyId: policy.id,
          dedupeKey: `incident_pause:${projectId}`,
          reason: '项目开了内容事件，自动化已退出，事件关闭前不会自动推进。',
        },
        now,
      );
      runner.actions.push({
        stage: 'advance',
        action: 'automation.paused_by_incident',
        projectId,
        policyId: policy.id,
      });
      return;
    }
    if (stageMode(policy, 'advance') !== 'auto') return;

    if (project.state === 'PUBLISH_SCHEDULED') {
      await runPublish(runner, policy, project);
      return;
    }
    const jobOutcome = await enqueueStageJobs(runner, policy, project);
    // 配音入队后本轮不再推进：G5 要等 Worker 把音轨和字幕写回来。
    if (project.state === 'SCRIPT_APPROVED' && jobOutcome !== 'skipped') return;
    // 渲染没入队就绝不推进到 RENDER_QUEUED——那会留下一个没有作业的等待状态。
    if (
      project.state === 'ASSETS_READY' &&
      jobOutcome !== 'enqueued' &&
      jobOutcome !== 'exists'
    )
      return;

    const target = NEXT_STATE[project.state];
    if (!target) return;
    const gates = await evaluateProjectGates(db, projectId);
    // 未解决的反驳证据是人的活：引擎既不能替编辑判断取舍，也不该每轮空转。
    const conflicting =
      gate(gates, 'G2_AUTO_EVIDENCE')?.reasons.filter((reason) =>
        reason.includes('反驳证据'),
      ) ?? [];
    if (conflicting.length) {
      await raiseAttentionItem(
        db,
        {
          kind: 'evidence_conflict',
          severity: 'warning',
          projectId,
          policyId: policy.id,
          dedupeKey: `evidence_conflict:${projectId}:${project.project.research.approvedHash}`,
          reason: `存在未解决的反驳证据，自动化停在研究阶段：${conflicting.join('；')}`,
          detail: { conflicts: conflicting },
        },
        now,
      );
      return;
    }
    const approvalKind = APPROVAL_FOR_STATE[target];
    if (approvalKind) {
      const gateCode =
        target === 'EDITOR_APPROVED'
          ? 'G3_MANUAL_RESEARCH'
          : target === 'SCRIPT_APPROVED'
            ? 'G4_SCRIPT_COVERAGE'
            : target === 'QC_APPROVED'
              ? 'G6_CONTENT_TECH_QC'
              : 'G7_PUBLISH_APPROVAL';
      if (!gate(gates, gateCode)?.passed) {
        const approval = await tryAutoApproval(
          runner,
          policy,
          project,
          gates,
          approvalKind,
        );
        if (!approval.approved) return;
      }
    }
    const freshGates = approvalKind
      ? await evaluateProjectGates(db, projectId)
      : gates;
    const blocking = freshGates.filter((item) => !item.passed);
    try {
      const result = await transitionContentProject(
        db,
        {
          projectId,
          expectedVersion: project.version,
          to: target,
          gates: freshGates,
          note: `策略「${policy.name}」自动推进。`,
          actor,
          trigger: 'automation',
          policyId: policy.id,
        },
        now,
      );
      if ('error' in result) return;
      runner.actions.push({
        stage: 'advance',
        action: 'project.transitioned',
        projectId,
        policyId: policy.id,
        detail: { from: project.state, to: target },
      });
    } catch (error) {
      if (error instanceof WorkflowError && error.code === 'GATE_FAILED') {
        // 门禁未过就是「等人补齐」，不是故障：进待办箱，不计入熔断。
        await raiseAttentionItem(
          db,
          {
            kind: 'gate_blocked',
            severity: 'info',
            projectId,
            policyId: policy.id,
            dedupeKey: `gate_blocked:${projectId}:${target}:${project.version}`,
            reason: `自动推进到 ${target} 被门禁挡下：${error.message}`,
            detail: {
              blocking: blocking.map((item) => ({
                code: item.code,
                reasons: item.reasons,
              })),
            },
          },
          now,
        );
        return;
      }
      throw error;
    }
  }
}

/** 7. 指标回流：到达采集窗口仍没有快照时提醒录入。 */
async function runMetrics(runner: StageRunner, allowed: boolean) {
  if (!allowed) return;
  const { db, now } = runner;
  const rows = await db
    .prepare(`
      SELECT pj.id, pj.project_id, pj.updated_at FROM publish_jobs pj
      WHERE pj.status = 'published'
      ORDER BY pj.updated_at DESC LIMIT 50
    `)
    .all<{ id: string; project_id: string; updated_at: string }>();
  for (const row of rows.results) {
    const ageHours =
      (now.valueOf() - new Date(row.updated_at).valueOf()) / 3_600_000;
    const due = (
      [
        ['2h', 2],
        ['24h', 24],
        ['7d', 168],
      ] as const
    ).filter(([, threshold]) => ageHours >= threshold);
    if (!due.length) continue;
    const snapshots = await db
      .prepare(
        'SELECT attribution_json FROM metric_snapshots WHERE publish_job_id = ?',
      )
      .bind(row.id)
      .all<{ attribution_json: string }>();
    const present = new Set(
      snapshots.results
        .map(
          (snapshot) =>
            parseJson<{ window?: string }>(snapshot.attribution_json, {})
              .window,
        )
        .filter(Boolean),
    );
    for (const [window] of due) {
      if (present.has(window)) continue;
      await raiseAttentionItem(
        db,
        {
          kind: 'metrics_due',
          severity: 'info',
          projectId: row.project_id,
          dedupeKey: `metrics_due:${row.id}:${window}`,
          reason: `发布已满 ${window}，仍没有该窗口的指标快照，需要拉取或人工录入。`,
          detail: { publishJobId: row.id, window },
        },
        now,
      );
      runner.actions.push({
        stage: 'metrics',
        action: 'metrics.reminder',
        projectId: row.project_id,
        detail: { publishJobId: row.id, window },
      });
    }
  }
  const sourceSlo = await raiseSourceSloBurnAlerts(db, now);
  if (sourceSlo.raised)
    runner.actions.push({
      stage: 'metrics',
      action: 'source_slo.alerted',
      detail: sourceSlo,
    });
  recordSuccess(runner.breakers, 'metrics');
}

/** 8. 清理：过期原文与过期 Worker 心跳。 */
async function runCleanup(runner: StageRunner) {
  const { db, now, context } = runner;
  try {
    const workers = await pruneStaleWorkers(db, now);
    if (workers.deleted)
      runner.actions.push({
        stage: 'cleanup',
        action: 'workers.pruned',
        detail: workers,
      });
    if (context.storage) {
      const legalDeletion = await processSourceLegalDeletions(
        db,
        context.storage,
        now,
        {
          workerId: 'orchestrator:source-deletion',
          maxObjects: Math.max(0, runner.limits.apiCalls - runner.apiCalls),
        },
      );
      runner.apiCalls += legalDeletion.apiCalls ?? 0;
      if (legalDeletion.processed)
        runner.actions.push({
          stage: 'cleanup',
          action: 'source.legal_deletion_processed',
          detail: legalDeletion,
        });
      const retention = await purgeExpiredSourcePayloads(
        db,
        context.storage,
        now,
        { maxApiCalls: Math.max(0, runner.limits.apiCalls - runner.apiCalls) },
      );
      runner.apiCalls += retention.apiCalls;
      if (retention.deletedObjects)
        runner.actions.push({
          stage: 'cleanup',
          action: 'source_payloads.purged',
          detail: retention,
        });
    }
  } catch (error) {
    await fail(runner, 'cleanup', error);
  }
}

/** DLQ 作业也要有人看见：每轮把新的死信作业放进待办箱。 */
async function raiseDeadLetterItems(runner: StageRunner) {
  const { db, now } = runner;
  const rows = await db
    .prepare(
      "SELECT id, kind, project_id, last_error, updated_at FROM jobs WHERE status = 'dead_letter' ORDER BY updated_at DESC LIMIT 50",
    )
    .all<{
      id: string;
      kind: string;
      project_id: string | null;
      last_error: string | null;
      updated_at: string;
    }>();
  for (const row of rows.results) {
    // 不重开已处理的条目：作业行会一直停在 dead_letter，重开等于每轮 tick 都把处理过的事再翻出来。
    await raiseAttentionItem(
      db,
      {
        reopenResolved: false,
        kind: row.kind === 'qc' ? 'qc_failed' : 'dead_letter',
        severity: 'warning',
        projectId: row.project_id,
        dedupeKey: `dead_letter:${row.id}`,
        reason: `${row.kind} 作业已进入死信队列：${row.last_error ?? '未记录原因'}`,
        detail: { jobId: row.id, kind: row.kind },
      },
      now,
    );
  }
}

async function raiseOrphanedJobItems(runner: StageRunner) {
  const rows = await orphanedJobs(runner.db, {}, runner.now);
  for (const job of rows.slice(0, 50)) {
    await raiseAttentionItem(
      runner.db,
      {
        kind: 'no_worker',
        severity: 'critical',
        projectId: job.projectId,
        dedupeKey: `no_worker:${job.id}`,
        reason: `${job.kind} 作业已等待超过 60 秒，但没有在线 Worker 声明可处理该类型。`,
        detail: { jobId: job.id, kind: job.kind, createdAt: job.createdAt },
      },
      runner.now,
    );
  }
}

/** 授权到期不是“过滤掉就算了”：关联项目必须显式转人工并留下审计。 */
async function expireAutomationPolicies(runner: StageRunner) {
  const rows = await runner.db
    .prepare(`
    SELECT id, name FROM automation_policies
    WHERE enabled = 1 AND expires_at IS NOT NULL AND expires_at <= ?
  `)
    .bind(runner.now.toISOString())
    .all<{ id: string; name: string }>();
  for (const policy of rows.results) {
    const reason = `自动化策略「${policy.name}」授权已过期，项目已转人工。`;
    await runner.db.batch([
      runner.db
        .prepare(
          'UPDATE automation_policies SET enabled = 0, version = version + 1, updated_at = ? WHERE id = ? AND enabled = 1',
        )
        .bind(runner.now.toISOString(), policy.id),
      runner.db
        .prepare(
          "UPDATE content_projects SET automation_mode = 'manual', automation_paused_reason = ? WHERE automation_policy_id = ? AND automation_mode = 'auto'",
        )
        .bind(reason, policy.id),
      runner.db
        .prepare(`
        INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
        VALUES (?, ?, ?, 'automation_policy.expired', 'automation_policy', ?, ?, ?, ?, ?)
      `)
        .bind(
          `audit_${crypto.randomUUID()}`,
          runner.actor.id,
          runner.actor.role,
          policy.id,
          stableHash({ enabled: false, reason }),
          JSON.stringify({
            trigger: 'automation',
            policyId: policy.id,
            reason,
          }),
          crypto.randomUUID(),
          runner.now.toISOString(),
        ),
    ]);
    runner.actions.push({
      stage: 'advance',
      action: 'automation_policy.expired',
      policyId: policy.id,
      detail: { reason },
    });
  }
}

/**
 * 跑一轮编排。返回结果同时写入 `automation_runs`，供控制台展示与下一轮读取熔断状态。
 */
export async function runAutomationTick(
  context: OrchestratorContext,
): Promise<AutomationTickResult> {
  const db = context.db;
  const now = context.now ?? new Date();
  const trigger = context.trigger ?? 'scheduler';
  const limits = { ...DEFAULT_TICK_LIMITS, ...context.limits };
  const runId = `automation_${crypto.randomUUID()}`;
  const startedAt = now.toISOString();
  const actions: TickAction[] = [];
  const errors: Array<{ stage: string; message: string }> = [];
  const breakers = await previousBreakers(db);

  const finish = async (
    status: AutomationTickResult['status'],
    projectCount: number,
    skippedReason?: string,
  ) => {
    const finishedAt = new Date();
    const result: AutomationTickResult = {
      runId,
      trigger,
      status,
      startedAt,
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.valueOf() - now.valueOf()),
      projectCount,
      actions,
      errors,
      breakers,
      skippedReason,
    };
    await db
      .prepare(`
        INSERT INTO automation_runs (id, trigger, status, started_at, finished_at, duration_ms, project_count, actions_json, breakers_json, errors_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        runId,
        trigger,
        status,
        startedAt,
        result.finishedAt,
        result.durationMs,
        projectCount,
        JSON.stringify(actions),
        JSON.stringify(breakers),
        JSON.stringify(
          skippedReason
            ? [...errors, { stage: 'tick', message: skippedReason }]
            : errors,
        ),
      )
      .run();
    return result;
  };

  const control = await db
    .prepare(
      "SELECT paused, reason FROM automation_control WHERE id = 'global'",
    )
    .first<{ paused: number; reason: string }>();
  if (Number(control?.paused ?? 0) === 1)
    return finish(
      'skipped',
      0,
      `global_pause:${control?.reason || '未填写原因'}`,
    );

  const actor = await resolveAutomationActor(db, context.automationActorId);
  if (!actor) {
    await raiseAttentionItem(
      db,
      {
        kind: 'automation_actor_missing',
        severity: 'critical',
        dedupeKey: 'automation_actor_missing',
        reason:
          '未配置有效的自动化服务账号（SIGNAL40_AUTOMATION_ACTOR_ID 指向的成员必须存在、active 且角色为 admin），编排引擎不做任何写入。',
      },
      now,
    ).catch(() => undefined);
    if (context.notify?.url && context.notify?.secret) {
      await notifyPendingAttention(
        db,
        {
          url: context.notify.url,
          secret: context.notify.secret,
          limit: 1,
          fetchImpl: context.fetchImpl,
        },
        now,
      ).catch(() => undefined);
    }
    return finish('skipped', 0, 'automation_actor_missing');
  }

  const runner: StageRunner = {
    db,
    now,
    actor,
    limits,
    actions,
    errors,
    breakers,
    context,
    jobsEnqueued: 0,
    publishesScheduled: 0,
    apiCalls: 0,
  };
  try {
    const canaries = await evaluateConnectorCanaries(db, actor, now);
    if (canaries.evaluated.length) {
      actions.push({
        stage: 'cleanup',
        action: canaries.stopped ? 'source_connector.canary_stopped' : 'source_connector.canary_evaluated',
        detail: canaries,
      });
    }
  } catch (error) {
    await fail(runner, 'cleanup', error);
  }
  const expiredSourceRights = await expireDueSourceRights(db, actor, now);
  for (const expired of expiredSourceRights) {
    actions.push({
      stage: 'ingestion',
      action: 'source.rights_expired',
      detail: expired,
    });
  }
  const ownership = await reconcileSourceOwnership(db, actor, now);
  if (ownership.issueCount || ownership.resolvedCount || ownership.truncated) {
    actions.push({
      stage: 'ingestion',
      action: 'source.ownership_reconciled',
      detail: ownership,
    });
  }
  await expireAutomationPolicies(runner);
  const policies = await activeAutomationPolicies(db, now);

  // 选本轮要处理的项目集合时抢一个短锁：多实例并发时不会同时选到同一批项目。
  // 选完立刻释放（事务提交即释放），不整轮持锁占用连接。
  let candidateIds: string[] | null = [];
  try {
    candidateIds = await db.transaction(async (tx) => {
      const lock = await tx
        .prepare('SELECT pg_try_advisory_xact_lock(?) AS locked')
        .bind(AUTOMATION_ADVISORY_LOCK_KEY)
        .first<{ locked: boolean }>();
      if (!lock?.locked) return null;
      const rows = await tx
        .prepare(`
          SELECT id FROM content_projects
          WHERE automation_mode = 'auto'
            AND state NOT IN ('MEASURED', 'CANCELLED', 'REJECTED', 'FAILED', 'RENDERING', 'RENDER_QUEUED', 'CHANGES_REQUESTED')
          ORDER BY updated_at ASC
          LIMIT ?
        `)
        .bind(limits.projects)
        .all<{ id: string }>();
      return rows.results.map((row) => row.id);
    });
  } catch (error) {
    await fail(runner, 'advance', error);
    candidateIds = [];
  }
  if (candidateIds === null)
    return finish('skipped', 0, 'another_tick_running');

  const stageAllowed = (stage: AutomationStage) =>
    policies.length
      ? policies.some((policy) => stageMode(policy, stage) === 'auto')
      : stage === 'ingestion' ||
        stage === 'topic_quality' ||
        stage === 'metrics';

  if (!breakerOpen(breakers, 'ingestion', now))
    await runIngestion(runner, stageAllowed('ingestion'));
  if (!breakerOpen(breakers, 'topic_quality', now))
    await runTopicQuality(runner, stageAllowed('topic_quality'), policies);
  if (!breakerOpen(breakers, 'project_creation', now))
    await runProjectCreation(runner, policies);

  let handledProjects = 0;
  if (!breakerOpen(breakers, 'advance', now)) {
    for (const projectId of candidateIds) {
      try {
        const handled = await db.transaction(async (tx) => {
          // 行锁覆盖完整的实际推进过程，而不是只覆盖候选查询。
          const locked = await tx
            .prepare(
              "SELECT id FROM content_projects WHERE id = ? AND automation_mode = 'auto' FOR UPDATE SKIP LOCKED",
            )
            .bind(projectId)
            .first();
          if (!locked) return false;
          const project = await loadContentProject(tx, projectId);
          if (!project) return false;
          const policy = policies.find((candidate) =>
            project.automationPolicyId
              ? candidate.id === project.automationPolicyId
              : policyMatchesProject(candidate, project),
          );
          if (!policy) return false;
          const txRunner: StageRunner = { ...runner, db: tx };
          await advanceProject(txRunner, policy, projectId);
          runner.jobsEnqueued = txRunner.jobsEnqueued;
          runner.publishesScheduled = txRunner.publishesScheduled;
          runner.apiCalls = txRunner.apiCalls;
          return true;
        });
        if (handled) {
          handledProjects += 1;
          recordSuccess(breakers, 'advance');
        }
      } catch (error) {
        await fail(runner, 'advance', error, { projectId });
      }
    }
  }

  if (!breakerOpen(breakers, 'metrics', now))
    await runMetrics(runner, stageAllowed('metrics'));
  await raiseDeadLetterItems(runner);
  await raiseOrphanedJobItems(runner);
  await runCleanup(runner);

  const notifyLimit = Math.min(
    limits.notifications,
    Math.max(0, limits.apiCalls - runner.apiCalls),
  );
  const notified =
    notifyLimit > 0
      ? await notifyPendingAttention(
          db,
          {
            url: context.notify?.url,
            secret: context.notify?.secret,
            limit: notifyLimit,
            fetchImpl: context.fetchImpl,
          },
          now,
        )
      : { sent: 0, failed: 0, skipped: 'api_call_limit' as const };
  runner.apiCalls += notified.sent + notified.failed;
  if ('sent' in notified && notified.sent)
    actions.push({
      stage: 'notify',
      action: 'attention.notified',
      detail: notified,
    });

  return finish(errors.length ? 'partial' : 'succeeded', handledProjects);
}
