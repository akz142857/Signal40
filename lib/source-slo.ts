import type { SqlDatabase } from './sql.ts';
import { raiseAttentionItem } from './attention.ts';
import { cronMatches, isValidCron } from './schedule.ts';
import { sourceConnectorByPlatform } from './source-connectors/registry.ts';
import { utcMonthStart } from './source-budget.ts';
import {
  sourceSloExcludesInstant,
  type SourceSloExclusion,
} from './source-slo-exclusions.ts';
import {
  SOURCE_SCHEDULE_THROTTLE_POLICY_VERSION,
  type SourceScheduleThrottle,
} from './source-schedule-throttle.ts';

export const SOURCE_SUCCESS_TARGET = 0.99;
export const SOURCE_SLO_MIN_SAMPLES = { 7: 10, 28: 30 } as const;
export const SOURCE_SLO_POLICY = {
  version: '2026-09-09.v2',
  timezone: 'UTC',
  windowsDays: [7, 28],
  successTarget: SOURCE_SUCCESS_TARGET,
  freshnessGraceMs: 5 * 60_000,
  eligibleTrigger: 'schedule',
  eligibleSuccessStatuses: ['succeeded'],
  eligibleFailureStatuses: ['partial', 'failed'],
  separatelyReportedStatuses: ['rights_blocked', 'cancelled', 'queued', 'running'],
  fetchOutcomes: ['modified', 'not_modified', 'unknown'],
  minimumEligibleTerminals: SOURCE_SLO_MIN_SAMPLES,
  lowFrequency: {
    expectedTriggers28dBelow: SOURCE_SLO_MIN_SAMPLES[28],
    statusUntilStandardSample: 'insufficient_data',
    acceptanceMinimumExpectedCycles: 2,
  },
  burnAlert: {
    shortWindowDays: 7,
    shortThreshold: 2,
    longWindowDays: 28,
    longThreshold: 1,
  },
  dataLimits: {
    sources: 500,
    runs: 100_000,
    exclusions: 10_000,
    throttles: 10_000,
  },
  alertDestinations: ['attention_inbox', 'configured_signed_webhook'],
  exclusionKinds: ['manual_pause', 'planned_maintenance'],
  budgetThrottle: {
    policyVersion: SOURCE_SCHEDULE_THROTTLE_POLICY_VERSION,
    priorityBands: [
      { minimumPriority: 80, cadenceMultiplier: 1 },
      { minimumPriority: 50, cadenceMultiplier: 2 },
      { minimumPriority: 0, cadenceMultiplier: 4 },
    ],
    denominatorRule:
      'only_persisted_budget_throttle_occurrences_are_removed',
  },
} as const;

type SourceRow = {
  id: string;
  name: string;
  platform: string;
  enabled: number;
  health_status: string;
  rate_limit_per_minute: number;
  schedule_cron: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  created_at?: string;
  monitoring_started_at?: string | null;
  cost_micros_per_request: number;
  monthly_budget_micros: number | string;
  budget_soft_limit_percent: number;
  schedule_priority: number;
  auto_throttle_enabled: number;
  effective_schedule_multiplier: number;
  schedule_throttle_reason: string | null;
  schedule_throttle_recovery_at: string | null;
  affected_article_count: number | string;
  affected_topic_count: number | string;
};

export type SourceSloRun = {
  source_config_id: string;
  status: string;
  trigger: string;
  request_count: number;
  byte_count: number;
  accepted_count: number;
  rejected_count: number;
  duplicate_count: number;
  scheduled_for: string | null;
  finished_at: string | null;
  created_at: string;
  cost_micros: number | string;
  fetch_outcome: 'unknown' | 'modified' | 'not_modified';
};

type WindowMetrics = {
  days: 7 | 28;
  total: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  burnRate: number | null;
  errorBudgetRemaining: number | null;
  sampleSufficient: boolean;
  requests: number;
  bytes: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  p95FreshnessMs: number | null;
  estimatedCostMicros: number;
  expectedTriggers: number | null;
  observedTriggers: number | null;
  triggerRate: number | null;
  triggerBurnRate: number | null;
  triggerSampleSufficient: boolean | null;
  outcomes: {
    succeeded: number;
    partial: number;
    failed: number;
    rightsBlocked: number;
    cancelled: number;
    inProgress: number;
    manual: number;
    backfill: number;
    modified: number;
    notModified: number;
    unknownFetchOutcome: number;
    excluded: number;
    budgetThrottled: number;
  };
};

export type SourceSloSnapshot = {
  sourceId: string;
  name: string;
  platform: string;
  connectorId: string;
  connectorVersion: string;
  requiredCapability: string;
  enabled: boolean;
  healthStatus: string;
  status: 'healthy' | 'warning' | 'breaching' | 'insufficient_data';
  dataComplete: boolean;
  target: number;
  windows: { days7: WindowMetrics; days28: WindowMetrics };
  freshness: {
    lastSuccessAt: string | null;
    nextRunAt: string | null;
    ageMs: number | null;
    expectedCadenceMs: number | null;
    targetMs: number | null;
    p95Ms: number | null;
    withinTarget: boolean | null;
  };
  quota: {
    triggerLimitPerMinute: number;
    triggersLastMinute: number;
    remainingTriggers: number;
  };
  budget: {
    mode: 'unpriced' | 'unlimited' | 'tracking' | 'soft_limit' | 'exhausted';
    costMicrosPerRequest: number;
    monthSpentMicros: number;
    monthlyBudgetMicros: number;
    softLimitPercent: number;
    usedPercent: number | null;
    remainingMicros: number | null;
    projectedMonthEndMicros: number | null;
    estimatedExhaustionAt: string | null;
    affectedArticleCount: number;
    affectedTopicCount: number;
    schedulePriority: number;
    autoThrottleEnabled: boolean;
    effectiveScheduleMultiplier: number;
    throttleReason: string | null;
    throttleRecoveryAt: string | null;
  };
  exclusions: Array<{
    kind: SourceSloExclusion['kind'];
    startsAt: string;
    endsAt: string | null;
    reason: string;
  }>;
};

type DimensionWindow = {
  days: 7 | 28;
  total: number;
  succeeded: number;
  successRate: number | null;
  burnRate: number | null;
  sampleSufficient: boolean;
  expectedTriggers: number | null;
  observedTriggers: number | null;
  triggerRate: number | null;
  triggerBurnRate: number | null;
  triggerSampleSufficient: boolean | null;
  requests: number;
  bytes: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  worstSourceP95FreshnessMs: number | null;
  estimatedCostMicros: number;
  outcomes: WindowMetrics['outcomes'];
};

export type SourceSloDimension = {
  kind: 'connector' | 'connector_version' | 'platform' | 'capability';
  key: string;
  label: string;
  sourceCount: number;
  status: SourceSloSnapshot['status'];
  target: number;
  windows: { days7: DimensionWindow; days28: DimensionWindow };
};

const ELIGIBLE_TERMINAL: ReadonlySet<string> = new Set([
  ...SOURCE_SLO_POLICY.eligibleSuccessStatuses,
  ...SOURCE_SLO_POLICY.eligibleFailureStatuses,
]);

function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
    ] ?? null
  );
}

type TriggerMetrics = Pick<
  WindowMetrics,
  | 'expectedTriggers'
  | 'observedTriggers'
  | 'triggerRate'
  | 'triggerBurnRate'
  | 'triggerSampleSufficient'
>;

function emptyTriggerMetrics(applicable: boolean): TriggerMetrics {
  return applicable
    ? {
        expectedTriggers: 0,
        observedTriggers: 0,
        triggerRate: null,
        triggerBurnRate: null,
        triggerSampleSufficient: false,
      }
    : {
        expectedTriggers: null,
        observedTriggers: null,
        triggerRate: null,
        triggerBurnRate: null,
        triggerSampleSufficient: null,
      };
}

function triggerMetricsByWindow(
  source: SourceRow,
  runs: SourceSloRun[],
  now: Date,
  exclusions: SourceSloExclusion[],
  throttles: SourceScheduleThrottle[],
): Record<7 | 28, TriggerMetrics> {
  if (!source.schedule_cron || !isValidCron(source.schedule_cron)) {
    return { 7: emptyTriggerMetrics(false), 28: emptyTriggerMetrics(false) };
  }
  const monitoring = source.monitoring_started_at
    ? new Date(source.monitoring_started_at).valueOf()
    : Number.NaN;
  if (!Number.isFinite(monitoring)) {
    return { 7: emptyTriggerMetrics(true), 28: emptyTriggerMetrics(true) };
  }
  const minute = 60_000;
  const starts = {
    7:
      Math.ceil(
        Math.max(now.valueOf() - 7 * 24 * 60 * minute, monitoring) / minute,
      ) * minute,
    28:
      Math.ceil(
        Math.max(now.valueOf() - 28 * 24 * 60 * minute, monitoring) / minute,
      ) * minute,
  } as const;
  const end = Math.floor((now.valueOf() - 5 * minute) / minute) * minute;
  const expected = { 7: 0, 28: 0 };
  const throttledInstants = new Set(
    throttles
      .map((throttle) => new Date(throttle.scheduled_for).valueOf())
      .filter(Number.isFinite),
  );
  for (let value = starts[28]; value <= end; value += minute) {
    if (sourceSloExcludesInstant(exclusions, value)) continue;
    if (!cronMatches(source.schedule_cron, new Date(value))) continue;
    if (throttledInstants.has(value)) continue;
    expected[28] += 1;
    if (value >= starts[7]) expected[7] += 1;
  }
  const observed = { 7: new Set<number>(), 28: new Set<number>() };
  for (const run of runs) {
    if (run.trigger !== 'schedule' || !run.scheduled_for) continue;
    const scheduled = new Date(run.scheduled_for).valueOf();
    if (!Number.isFinite(scheduled) || scheduled > end) continue;
    if (sourceSloExcludesInstant(exclusions, scheduled)) continue;
    if (scheduled >= starts[28]) observed[28].add(scheduled);
    if (scheduled >= starts[7]) observed[7].add(scheduled);
  }
  return Object.fromEntries(
    ([7, 28] as const).map((days) => {
      const expectedTriggers = expected[days];
      const observedTriggers = observed[days].size;
      const triggerRate = expectedTriggers
        ? Math.min(1, observedTriggers / expectedTriggers)
        : null;
      return [
        days,
        {
          expectedTriggers,
          observedTriggers,
          triggerRate,
          triggerBurnRate:
            triggerRate === null
              ? null
              : (1 - triggerRate) / (1 - SOURCE_SUCCESS_TARGET),
          triggerSampleSufficient:
            expectedTriggers >= SOURCE_SLO_MIN_SAMPLES[days],
        },
      ];
    }),
  ) as Record<7 | 28, TriggerMetrics>;
}

function windowMetrics(
  runs: SourceSloRun[],
  days: 7 | 28,
  now: Date,
  triggerMetrics: TriggerMetrics,
  exclusions: SourceSloExclusion[],
  throttles: SourceScheduleThrottle[],
): WindowMetrics {
  const since = now.valueOf() - days * 24 * 60 * 60_000;
  const windowRuns = runs.filter(
    (run) => new Date(run.created_at).valueOf() >= since,
  );
  const allScheduled = windowRuns.filter((run) => run.trigger === 'schedule');
  const scheduled = allScheduled.filter((run) => {
    const instant = new Date(run.scheduled_for ?? run.created_at).valueOf();
    return !Number.isFinite(instant) ||
      !sourceSloExcludesInstant(exclusions, instant);
  });
  const selected = scheduled.filter((run) => ELIGIBLE_TERMINAL.has(run.status));
  const succeeded = selected.filter((run) => run.status === 'succeeded').length;
  const total = selected.length;
  const successRate = total ? succeeded / total : null;
  const errorRate = successRate === null ? null : 1 - successRate;
  const burnRate =
    errorRate === null ? null : errorRate / (1 - SOURCE_SUCCESS_TARGET);
  const freshness = selected.flatMap((run) => {
    if (run.status !== 'succeeded' || !run.scheduled_for || !run.finished_at)
      return [];
    const value =
      new Date(run.finished_at).valueOf() -
      new Date(run.scheduled_for).valueOf();
    return Number.isFinite(value) && value >= 0 ? [value] : [];
  });
  return {
    days,
    total,
    succeeded,
    failed: total - succeeded,
    successRate,
    burnRate,
    errorBudgetRemaining: burnRate === null ? null : Math.max(0, 1 - burnRate),
    sampleSufficient: total >= SOURCE_SLO_MIN_SAMPLES[days],
    requests: selected.reduce(
      (sum, run) => sum + Number(run.request_count || 0),
      0,
    ),
    bytes: selected.reduce((sum, run) => sum + Number(run.byte_count || 0), 0),
    accepted: selected.reduce(
      (sum, run) => sum + Number(run.accepted_count || 0),
      0,
    ),
    rejected: selected.reduce(
      (sum, run) => sum + Number(run.rejected_count || 0),
      0,
    ),
    duplicates: selected.reduce(
      (sum, run) => sum + Number(run.duplicate_count || 0),
      0,
    ),
    p95FreshnessMs: percentile(freshness, 0.95),
    estimatedCostMicros: selected.reduce(
      (sum, run) => sum + Number(run.cost_micros || 0),
      0,
    ),
    outcomes: {
      succeeded: scheduled.filter((run) => run.status === 'succeeded').length,
      partial: scheduled.filter((run) => run.status === 'partial').length,
      failed: scheduled.filter((run) => run.status === 'failed').length,
      rightsBlocked: scheduled.filter((run) => run.status === 'rights_blocked')
        .length,
      cancelled: scheduled.filter((run) => run.status === 'cancelled').length,
      inProgress: scheduled.filter((run) =>
        ['queued', 'running'].includes(run.status),
      ).length,
      manual: windowRuns.filter((run) => run.trigger === 'manual').length,
      backfill: windowRuns.filter((run) => run.trigger === 'backfill').length,
      modified: scheduled.filter((run) => run.fetch_outcome === 'modified')
        .length,
      notModified: scheduled.filter(
        (run) => run.fetch_outcome === 'not_modified',
      ).length,
      unknownFetchOutcome: scheduled.filter(
        (run) => run.fetch_outcome === 'unknown',
      ).length,
      excluded: allScheduled.length - scheduled.length,
      budgetThrottled: throttles.filter((throttle) => {
        const instant = new Date(throttle.scheduled_for).valueOf();
        return Number.isFinite(instant) && instant >= since && instant <= now.valueOf();
      }).length,
    },
    ...triggerMetrics,
  };
}

function expectedCadenceMs(runs: SourceSloRun[]) {
  const occurrences = [
    ...new Set(
      runs
        .filter((run) => run.trigger === 'schedule' && run.scheduled_for)
        .map((run) => String(run.scheduled_for)),
    ),
  ]
    .map((value) => new Date(value).valueOf())
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const gaps = occurrences
    .slice(1)
    .map((value, index) => value - occurrences[index])
    .filter((value) => value > 0);
  return percentile(gaps, 0.5);
}

export function buildSourceSloSnapshot(
  source: SourceRow,
  runs: SourceSloRun[],
  now = new Date(),
  dataComplete = true,
  exclusions: SourceSloExclusion[] = [],
  throttles: SourceScheduleThrottle[] = [],
): SourceSloSnapshot {
  const connector = sourceConnectorByPlatform(source.platform);
  const triggerMetrics = triggerMetricsByWindow(
    source,
    runs,
    now,
    exclusions,
    throttles,
  );
  const days7 = windowMetrics(
    runs,
    7,
    now,
    triggerMetrics[7],
    exclusions,
    throttles,
  );
  const days28 = windowMetrics(
    runs,
    28,
    now,
    triggerMetrics[28],
    exclusions,
    throttles,
  );
  const cadenceMs = expectedCadenceMs(runs);
  const freshnessTargetMs = cadenceMs === null
    ? null
    : cadenceMs + SOURCE_SLO_POLICY.freshnessGraceMs;
  const p95Ms = days28.p95FreshnessMs;
  const withinTarget =
    freshnessTargetMs === null || p95Ms === null
      ? null
      : p95Ms <= freshnessTargetMs;
  const lastSuccessValue = source.last_success_at
    ? new Date(source.last_success_at).valueOf()
    : Number.NaN;
  const ageMs = Number.isFinite(lastSuccessValue)
    ? Math.max(0, now.valueOf() - lastSuccessValue)
    : null;
  const triggerEnough =
    !source.schedule_cron ||
    (days7.triggerSampleSufficient && days28.triggerSampleSufficient);
  const enough =
    dataComplete &&
    days7.sampleSufficient &&
    days28.sampleSufficient &&
    Boolean(triggerEnough);
  const successBurning =
    Number(days7.burnRate) >= 2 && Number(days28.burnRate) >= 1;
  const triggerBurning =
    Number(days7.triggerBurnRate) >= 2 && Number(days28.triggerBurnRate) >= 1;
  const breaching = enough && (successBurning || triggerBurning);
  const warning =
    enough &&
    (Number(days7.successRate) < SOURCE_SUCCESS_TARGET ||
      Number(days28.successRate) < SOURCE_SUCCESS_TARGET ||
      (days7.triggerRate !== null &&
        days7.triggerRate < SOURCE_SUCCESS_TARGET) ||
      (days28.triggerRate !== null &&
        days28.triggerRate < SOURCE_SUCCESS_TARGET) ||
      withinTarget === false);
  const minuteStart = now.valueOf() - 60_000;
  const triggersLastMinute = runs.filter((run) => {
    const created = new Date(run.created_at).valueOf();
    return created > minuteStart && created <= now.valueOf();
  }).length;
  const limit = Math.max(
    1,
    Math.min(600, Math.trunc(source.rate_limit_per_minute)),
  );
  const monthStart = new Date(utcMonthStart(now)).valueOf();
  const monthSpentMicros = runs
    .filter(
      (run) =>
        run.status !== 'cancelled' &&
        new Date(run.created_at).valueOf() >= monthStart,
    )
    .reduce((sum, run) => sum + Number(run.cost_micros || 0), 0);
  const monthlyBudgetMicros = Number(source.monthly_budget_micros || 0);
  const usedPercent =
    monthlyBudgetMicros > 0
      ? (monthSpentMicros / monthlyBudgetMicros) * 100
      : null;
  const budgetMode =
    source.cost_micros_per_request <= 0
      ? 'unpriced'
      : monthlyBudgetMicros <= 0
        ? 'unlimited'
        : monthSpentMicros >= monthlyBudgetMicros
          ? 'exhausted'
          : Number(usedPercent) >= source.budget_soft_limit_percent
            ? 'soft_limit'
            : 'tracking';
  const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsedMonthMs = Math.max(1, now.valueOf() - monthStart);
  const spendPerMs =
    monthSpentMicros > 0 ? monthSpentMicros / elapsedMonthMs : 0;
  const projectedMonthEndMicros =
    source.cost_micros_per_request > 0
      ? Math.round(spendPerMs * (nextMonth - monthStart))
      : null;
  const exhaustionAt =
    monthlyBudgetMicros > 0 && spendPerMs > 0
      ? monthStart + monthlyBudgetMicros / spendPerMs
      : Number.NaN;
  const estimatedExhaustionAt =
    Number.isFinite(exhaustionAt) && exhaustionAt < nextMonth
      ? new Date(Math.max(now.valueOf(), exhaustionAt)).toISOString()
      : null;
  return {
    sourceId: source.id,
    name: source.name,
    platform: source.platform,
    connectorId: connector?.id ?? 'unknown',
    connectorVersion: connector?.version ?? 'unknown',
    requiredCapability: connector?.requiredCapability ?? 'unknown',
    enabled: Boolean(source.enabled),
    healthStatus: source.health_status,
    status: !enough
      ? 'insufficient_data'
      : breaching
        ? 'breaching'
        : warning
          ? 'warning'
          : 'healthy',
    dataComplete,
    target: SOURCE_SUCCESS_TARGET,
    windows: { days7, days28 },
    freshness: {
      lastSuccessAt: source.last_success_at,
      nextRunAt: source.next_run_at,
      ageMs,
      expectedCadenceMs: cadenceMs,
      targetMs: freshnessTargetMs,
      p95Ms,
      withinTarget,
    },
    quota: {
      triggerLimitPerMinute: limit,
      triggersLastMinute,
      remainingTriggers: Math.max(0, limit - triggersLastMinute),
    },
    budget: {
      mode: budgetMode,
      costMicrosPerRequest: source.cost_micros_per_request,
      monthSpentMicros,
      monthlyBudgetMicros,
      softLimitPercent: source.budget_soft_limit_percent,
      usedPercent,
      remainingMicros:
        monthlyBudgetMicros > 0
          ? Math.max(0, monthlyBudgetMicros - monthSpentMicros)
          : null,
      projectedMonthEndMicros,
      estimatedExhaustionAt,
      affectedArticleCount: Number(source.affected_article_count || 0),
      affectedTopicCount: Number(source.affected_topic_count || 0),
      schedulePriority: source.schedule_priority,
      autoThrottleEnabled: Boolean(source.auto_throttle_enabled),
      effectiveScheduleMultiplier: source.effective_schedule_multiplier,
      throttleReason: source.schedule_throttle_reason,
      throttleRecoveryAt: source.schedule_throttle_recovery_at,
    },
    exclusions: exclusions.map((exclusion) => ({
      kind: exclusion.kind,
      startsAt: exclusion.starts_at,
      endsAt: exclusion.ends_at,
      reason: exclusion.reason,
    })),
  };
}

function dimensionWindow(
  sources: SourceSloSnapshot[],
  days: 7 | 28,
): DimensionWindow {
  const key = days === 7 ? 'days7' : 'days28';
  const windows = sources.map((source) => source.windows[key]);
  const total = windows.reduce((sum, window) => sum + window.total, 0);
  const succeeded = windows.reduce((sum, window) => sum + window.succeeded, 0);
  const successRate = total ? succeeded / total : null;
  const applicableTriggers = windows.filter(
    (window) => window.expectedTriggers !== null,
  );
  const expectedTriggers = applicableTriggers.length
    ? applicableTriggers.reduce(
        (sum, window) => sum + Number(window.expectedTriggers),
        0,
      )
    : null;
  const observedTriggers = applicableTriggers.length
    ? applicableTriggers.reduce(
        (sum, window) => sum + Number(window.observedTriggers),
        0,
      )
    : null;
  const triggerRate = expectedTriggers
    ? Math.min(1, Number(observedTriggers) / expectedTriggers)
    : null;
  const freshnessValues = windows
    .map((window) => window.p95FreshnessMs)
    .filter((value): value is number => value !== null);
  return {
    days,
    total,
    succeeded,
    successRate,
    burnRate:
      successRate === null
        ? null
        : (1 - successRate) / (1 - SOURCE_SUCCESS_TARGET),
    sampleSufficient: total >= SOURCE_SLO_MIN_SAMPLES[days],
    expectedTriggers,
    observedTriggers,
    triggerRate,
    triggerBurnRate:
      triggerRate === null
        ? null
        : (1 - triggerRate) / (1 - SOURCE_SUCCESS_TARGET),
    triggerSampleSufficient:
      expectedTriggers === null
        ? null
        : expectedTriggers >= SOURCE_SLO_MIN_SAMPLES[days],
    requests: windows.reduce((sum, window) => sum + window.requests, 0),
    bytes: windows.reduce((sum, window) => sum + window.bytes, 0),
    accepted: windows.reduce((sum, window) => sum + window.accepted, 0),
    rejected: windows.reduce((sum, window) => sum + window.rejected, 0),
    duplicates: windows.reduce((sum, window) => sum + window.duplicates, 0),
    worstSourceP95FreshnessMs: freshnessValues.length
      ? Math.max(...freshnessValues)
      : null,
    estimatedCostMicros: windows.reduce(
      (sum, window) => sum + window.estimatedCostMicros,
      0,
    ),
    outcomes: {
      succeeded: windows.reduce(
        (sum, window) => sum + window.outcomes.succeeded,
        0,
      ),
      partial: windows.reduce((sum, window) => sum + window.outcomes.partial, 0),
      failed: windows.reduce((sum, window) => sum + window.outcomes.failed, 0),
      rightsBlocked: windows.reduce(
        (sum, window) => sum + window.outcomes.rightsBlocked,
        0,
      ),
      cancelled: windows.reduce(
        (sum, window) => sum + window.outcomes.cancelled,
        0,
      ),
      inProgress: windows.reduce(
        (sum, window) => sum + window.outcomes.inProgress,
        0,
      ),
      manual: windows.reduce((sum, window) => sum + window.outcomes.manual, 0),
      backfill: windows.reduce((sum, window) => sum + window.outcomes.backfill, 0),
      modified: windows.reduce(
        (sum, window) => sum + window.outcomes.modified,
        0,
      ),
      notModified: windows.reduce(
        (sum, window) => sum + window.outcomes.notModified,
        0,
      ),
      unknownFetchOutcome: windows.reduce(
        (sum, window) => sum + window.outcomes.unknownFetchOutcome,
        0,
      ),
      excluded: windows.reduce(
        (sum, window) => sum + window.outcomes.excluded,
        0,
      ),
      budgetThrottled: windows.reduce(
        (sum, window) => sum + window.outcomes.budgetThrottled,
        0,
      ),
    },
  };
}

export function buildSourceSloDimensions(
  snapshots: SourceSloSnapshot[],
  dataComplete = true,
): SourceSloDimension[] {
  const groups = new Map<
    string,
    {
      kind: SourceSloDimension['kind'];
      key: string;
      label: string;
      sources: SourceSloSnapshot[];
    }
  >();
  for (const source of snapshots) {
    const entries: Array<[SourceSloDimension['kind'], string, string]> = [
      ['connector', source.connectorId, source.connectorId],
      [
        'connector_version',
        `${source.connectorId}@${source.connectorVersion}`,
        `${source.connectorId}@${source.connectorVersion}`,
      ],
      ['platform', source.platform, source.platform],
      ['capability', source.requiredCapability, source.requiredCapability],
    ];
    for (const [kind, key, label] of entries) {
      const groupKey = `${kind}:${key}`;
      const group = groups.get(groupKey) ?? {
        kind,
        key,
        label,
        sources: [],
      };
      group.sources.push(source);
      groups.set(groupKey, group);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const days7 = dimensionWindow(group.sources, 7);
      const days28 = dimensionWindow(group.sources, 28);
      const triggerRequired =
        days7.expectedTriggers !== null || days28.expectedTriggers !== null;
      const enough =
        dataComplete &&
        days7.sampleSufficient &&
        days28.sampleSufficient &&
        (!triggerRequired ||
          Boolean(
            days7.triggerSampleSufficient && days28.triggerSampleSufficient,
          ));
      const breaching =
        enough &&
        ((Number(days7.burnRate) >= 2 && Number(days28.burnRate) >= 1) ||
          (Number(days7.triggerBurnRate) >= 2 &&
            Number(days28.triggerBurnRate) >= 1));
      const warning =
        enough &&
        (Number(days7.successRate) < SOURCE_SUCCESS_TARGET ||
          Number(days28.successRate) < SOURCE_SUCCESS_TARGET ||
          (days7.triggerRate !== null &&
            days7.triggerRate < SOURCE_SUCCESS_TARGET) ||
          (days28.triggerRate !== null &&
            days28.triggerRate < SOURCE_SUCCESS_TARGET));
      return {
        kind: group.kind,
        key: group.key,
        label: group.label,
        sourceCount: group.sources.length,
        status: !enough
          ? 'insufficient_data'
          : breaching
            ? 'breaching'
            : warning
              ? 'warning'
              : 'healthy',
        target: SOURCE_SUCCESS_TARGET,
        windows: { days7, days28 },
      } satisfies SourceSloDimension;
    })
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.key.localeCompare(right.key),
    );
}

export async function loadSourceSloSnapshots(
  db: SqlDatabase,
  now = new Date(),
) {
  const since = new Date(
    Math.min(
      now.valueOf() - 28 * 24 * 60 * 60_000,
      new Date(utcMonthStart(now)).valueOf(),
    ),
  ).toISOString();
  const [sources, runRows, exclusionRows, throttleRows] = await Promise.all([
    db
      .prepare(`
      SELECT id, name, platform, enabled, health_status, rate_limit_per_minute,
        schedule_cron, last_success_at, next_run_at, created_at,
        cost_micros_per_request, monthly_budget_micros, budget_soft_limit_percent,
        schedule_priority, auto_throttle_enabled, effective_schedule_multiplier,
        schedule_throttle_reason, schedule_throttle_recovery_at,
        (SELECT COUNT(DISTINCT origin.article_id) FROM source_item_origins origin
          WHERE origin.source_config_id = source_configs.id AND origin.deleted_at IS NULL) AS affected_article_count,
        (SELECT COUNT(DISTINCT topic_article.topic_id)
          FROM source_item_origins origin
          JOIN topic_articles topic_article ON topic_article.article_id = origin.article_id
          WHERE origin.source_config_id = source_configs.id AND origin.deleted_at IS NULL) AS affected_topic_count,
        COALESCE(
          (SELECT MIN(a.created_at) FROM audit_events a
            WHERE a.entity_type = 'source_config' AND a.entity_id = source_configs.id AND a.action = 'source.enabled'),
          CASE WHEN enabled = 1 THEN created_at ELSE NULL END
        ) AS monitoring_started_at
      FROM source_configs WHERE lifecycle_status <> 'archived' ORDER BY name LIMIT 501
    `)
      .all<SourceRow>(),
    db
      .prepare(`
      SELECT source_config_id, status, trigger, request_count, byte_count, accepted_count,
        rejected_count, duplicate_count, scheduled_for, finished_at, created_at, cost_micros,
        fetch_outcome
      FROM ingestion_runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT 100001
    `)
      .bind(since)
      .all<SourceSloRun>(),
    db
      .prepare(`
      SELECT id, source_config_id, kind, starts_at, ends_at, reason
      FROM source_slo_exclusions
      WHERE cancelled_at IS NULL AND starts_at <= ?
        AND (ends_at IS NULL OR ends_at >= ?)
      ORDER BY starts_at ASC LIMIT 10001
    `)
      .bind(now.toISOString(), since)
      .all<SourceSloExclusion>(),
    db
      .prepare(`
      SELECT source_config_id, scheduled_for, cadence_multiplier,
        schedule_priority, reason_code, recovery_at
      FROM source_schedule_throttles
      WHERE scheduled_for >= ? AND scheduled_for <= ?
      ORDER BY scheduled_for ASC LIMIT 10001
    `)
      .bind(since, now.toISOString())
      .all<SourceScheduleThrottle>(),
  ]);
  const dataComplete =
    runRows.results.length <= 100_000 &&
    sources.results.length <= 500 &&
    exclusionRows.results.length <= 10_000 &&
    throttleRows.results.length <= 10_000;
  const boundedRuns = runRows.results.slice(0, 100_000);
  const boundedSources = sources.results.slice(0, 500);
  const boundedExclusions = exclusionRows.results.slice(0, 10_000);
  const boundedThrottles = throttleRows.results.slice(0, 10_000);
  const bySource = new Map<string, SourceSloRun[]>();
  for (const run of boundedRuns) {
    const rows = bySource.get(run.source_config_id) ?? [];
    rows.push(run);
    bySource.set(run.source_config_id, rows);
  }
  const snapshots = boundedSources.map((source) =>
    buildSourceSloSnapshot(
      source,
      bySource.get(source.id) ?? [],
      now,
      dataComplete,
      boundedExclusions.filter(
        (exclusion) => exclusion.source_config_id === source.id,
      ),
      boundedThrottles.filter(
        (throttle) => throttle.source_config_id === source.id,
      ),
    ),
  );
  return {
    policy: SOURCE_SLO_POLICY,
    dataComplete,
    snapshots,
    dimensions: buildSourceSloDimensions(snapshots, dataComplete),
  };
}

export async function raiseSourceSloBurnAlerts(
  db: SqlDatabase,
  now = new Date(),
) {
  const result = await loadSourceSloSnapshots(db, now);
  let raised = 0;
  for (const source of result.snapshots) {
    if (!source.enabled || source.status !== 'breaching') continue;
    const rate7 = source.windows.days7.successRate;
    const rate28 = source.windows.days28.successRate;
    await raiseAttentionItem(
      db,
      {
        kind: 'source_slo',
        severity: 'critical',
        sourceConfigId: source.sourceId,
        dedupeKey: `source_slo:${source.sourceId}`,
        reason: `来源「${source.name}」同时耗尽短/长窗口错误预算：7 天成功率 ${rate7 === null ? '无样本' : `${(rate7 * 100).toFixed(2)}%`}、触发率 ${source.windows.days7.triggerRate === null ? '不适用' : `${(source.windows.days7.triggerRate * 100).toFixed(2)}%`}；28 天成功率 ${rate28 === null ? '无样本' : `${(rate28 * 100).toFixed(2)}%`}、触发率 ${source.windows.days28.triggerRate === null ? '不适用' : `${(source.windows.days28.triggerRate * 100).toFixed(2)}%`}。`,
        detail: {
          sourceId: source.sourceId,
          policyVersion: SOURCE_SLO_POLICY.version,
          target: source.target,
          windows: source.windows,
          freshness: source.freshness,
        },
      },
      now,
    );
    raised += 1;
  }
  return { raised, dataComplete: result.dataComplete };
}
