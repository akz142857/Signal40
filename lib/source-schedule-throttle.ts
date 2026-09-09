import type { Actor } from './control-plane.ts';
import { nextScheduledMinute } from './schedule.ts';
import type { SqlDatabase } from './sql.ts';
import { stableHash } from './workflow.ts';

export const SOURCE_SCHEDULE_THROTTLE_POLICY_VERSION = '2026-09-09.v1';

export type SourceSchedulePolicy = {
  schedulePriority: number;
  autoThrottleEnabled: boolean;
};

export type SourceScheduleThrottleDecision = SourceSchedulePolicy & {
  cadenceMultiplier: 1 | 2 | 4;
  reasonCode: 'budget_soft_limit' | null;
  monthSpentMicros: number;
  monthlyBudgetMicros: number;
  softLimitPercent: number;
  recoveryAt: string | null;
};

export type SourceScheduleThrottle = {
  source_config_id: string;
  scheduled_for: string;
  cadence_multiplier: number;
  schedule_priority: number;
  reason_code: 'budget_soft_limit';
  recovery_at: string;
};

function validPriority(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100
    ? Number(value)
    : null;
}

export function parseSourceSchedulePolicy(
  value: unknown,
  fallback: SourceSchedulePolicy = {
    schedulePriority: 50,
    autoThrottleEnabled: true,
  },
): { policy: SourceSchedulePolicy; error?: string } {
  if (value === undefined) return { policy: { ...fallback } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { policy: { ...fallback }, error: 'schedulePolicy 必须是对象。' };
  }
  const input = value as Record<string, unknown>;
  const schedulePriority = validPriority(input.schedulePriority);
  if (
    schedulePriority === null ||
    typeof input.autoThrottleEnabled !== 'boolean'
  ) {
    return {
      policy: { ...fallback },
      error: '来源优先级必须是 0–100 的整数，自动降频开关必须是布尔值。',
    };
  }
  return {
    policy: {
      schedulePriority,
      autoThrottleEnabled: input.autoThrottleEnabled,
    },
  };
}

function nextUtcMonthStart(now: Date) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  ).toISOString();
}

export function decideSourceScheduleThrottle(input: {
  schedulePriority: number;
  autoThrottleEnabled: boolean;
  monthSpentMicros: number;
  monthlyBudgetMicros: number;
  softLimitPercent: number;
  now?: Date;
}): SourceScheduleThrottleDecision {
  const schedulePriority = Math.max(
    0,
    Math.min(100, Math.trunc(input.schedulePriority)),
  );
  const atSoftLimit =
    input.monthlyBudgetMicros > 0 &&
    input.monthSpentMicros * 100 >=
      input.monthlyBudgetMicros * input.softLimitPercent;
  const cadenceMultiplier: 1 | 2 | 4 =
    !input.autoThrottleEnabled || !atSoftLimit || schedulePriority >= 80
      ? 1
      : schedulePriority >= 50
        ? 2
        : 4;
  return {
    schedulePriority,
    autoThrottleEnabled: input.autoThrottleEnabled,
    cadenceMultiplier,
    reasonCode: cadenceMultiplier > 1 ? 'budget_soft_limit' : null,
    monthSpentMicros: Math.max(0, Math.trunc(input.monthSpentMicros)),
    monthlyBudgetMicros: Math.max(0, Math.trunc(input.monthlyBudgetMicros)),
    softLimitPercent: Math.max(1, Math.min(99, input.softLimitPercent)),
    recoveryAt:
      cadenceMultiplier > 1
        ? nextUtcMonthStart(input.now ?? new Date())
        : null,
  };
}

export function sourceScheduleAdvancePlan(
  scheduleCron: string,
  scheduledFor: string,
  cadenceMultiplier: 1 | 2 | 4,
) {
  const skipped: string[] = [];
  let cursor = scheduledFor;
  for (let step = 1; step <= cadenceMultiplier; step += 1) {
    const next = nextScheduledMinute(scheduleCron, cursor);
    if (!next) return { nextRunAt: null, skipped: [] };
    cursor = next;
    if (step < cadenceMultiplier) skipped.push(next);
  }
  return { nextRunAt: cursor, skipped };
}

export async function persistSourceScheduleAdvance(
  db: SqlDatabase,
  input: {
    sourceId: string;
    scheduleCron: string;
    scheduledFor: string;
    decision: SourceScheduleThrottleDecision;
    actor: Actor;
  },
  now = new Date(),
) {
  const plan = sourceScheduleAdvancePlan(
    input.scheduleCron,
    input.scheduledFor,
    input.decision.cadenceMultiplier,
  );
  if (!plan.nextRunAt) return { advanced: false, ...plan };
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const source = await tx
      .prepare(`
        SELECT next_run_at, effective_schedule_multiplier,
          schedule_throttle_reason, schedule_throttle_recovery_at
        FROM source_configs WHERE id = ? FOR UPDATE
      `)
      .bind(input.sourceId)
      .first<{
        next_run_at: string | null;
        effective_schedule_multiplier: number;
        schedule_throttle_reason: string | null;
        schedule_throttle_recovery_at: string | null;
      }>();
    if (!source || source.next_run_at !== input.scheduledFor) {
      return { advanced: false, ...plan };
    }
    for (const skippedAt of plan.skipped) {
      await tx
        .prepare(`
          INSERT INTO source_schedule_throttles
            (id, source_config_id, scheduled_for, policy_version,
             schedule_priority, cadence_multiplier, month_spent_micros,
             monthly_budget_micros, soft_limit_percent, reason_code,
             recovery_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'budget_soft_limit', ?, ?)
          ON CONFLICT (source_config_id, scheduled_for) DO NOTHING
        `)
        .bind(
          `source_throttle_${crypto.randomUUID()}`,
          input.sourceId,
          skippedAt,
          SOURCE_SCHEDULE_THROTTLE_POLICY_VERSION,
          input.decision.schedulePriority,
          input.decision.cadenceMultiplier,
          input.decision.monthSpentMicros,
          input.decision.monthlyBudgetMicros,
          input.decision.softLimitPercent,
          input.decision.recoveryAt,
          timestamp,
        )
        .run();
    }
    await tx
      .prepare(`
        UPDATE source_configs SET next_run_at = ?,
          effective_schedule_multiplier = ?, schedule_throttle_reason = ?,
          schedule_throttle_recovery_at = ?, updated_at = ?
        WHERE id = ? AND next_run_at = ?
      `)
      .bind(
        plan.nextRunAt,
        input.decision.cadenceMultiplier,
        input.decision.reasonCode,
        input.decision.recoveryAt,
        timestamp,
        input.sourceId,
        input.scheduledFor,
      )
      .run();
    const previousMultiplier = Number(
      source.effective_schedule_multiplier || 1,
    );
    if (previousMultiplier !== input.decision.cadenceMultiplier) {
      const action =
        input.decision.cadenceMultiplier > 1
          ? 'source.schedule_throttle_activated'
          : 'source.schedule_throttle_recovered';
      await tx
        .prepare(`
          INSERT INTO audit_events
            (id, actor_id, actor_role, action, entity_type, entity_id,
             before_hash, after_hash, metadata_json, request_id, created_at)
          VALUES (?, ?, ?, ?, 'source_config', ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          `audit_${crypto.randomUUID()}`,
          input.actor.id,
          input.actor.role,
          action,
          input.sourceId,
          stableHash({
            cadenceMultiplier: previousMultiplier,
            reasonCode: source.schedule_throttle_reason,
            recoveryAt: source.schedule_throttle_recovery_at,
          }),
          stableHash({
            cadenceMultiplier: input.decision.cadenceMultiplier,
            reasonCode: input.decision.reasonCode,
            recoveryAt: input.decision.recoveryAt,
          }),
          JSON.stringify({
            policyVersion: SOURCE_SCHEDULE_THROTTLE_POLICY_VERSION,
            scheduledFor: input.scheduledFor,
            skippedOccurrences: plan.skipped,
            schedulePriority: input.decision.schedulePriority,
            cadenceMultiplier: input.decision.cadenceMultiplier,
            monthSpentMicros: input.decision.monthSpentMicros,
            monthlyBudgetMicros: input.decision.monthlyBudgetMicros,
            softLimitPercent: input.decision.softLimitPercent,
            recoveryAt: input.decision.recoveryAt,
          }),
          crypto.randomUUID(),
          timestamp,
        )
        .run();
    }
    return { advanced: true, ...plan };
  });
}
