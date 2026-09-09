import type { SqlDatabase } from './sql.ts';

export type SourceBillingPolicy = {
  costMicrosPerRequest: number;
  estimatedRequestsPerRun: number;
  monthlyBudgetMicros: number;
  softLimitPercent: number;
};

export const DEFAULT_SOURCE_BILLING_POLICY: SourceBillingPolicy = {
  costMicrosPerRequest: 0,
  estimatedRequestsPerRun: 1,
  monthlyBudgetMicros: 0,
  softLimitPercent: 80,
};

function boundedInteger(value: unknown, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
    ? Number(value)
    : null;
}

export function parseSourceBillingPolicy(
  value: unknown,
  fallback = DEFAULT_SOURCE_BILLING_POLICY,
): { policy: SourceBillingPolicy; error?: string } {
  if (value === undefined) return { policy: { ...fallback } };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { policy: { ...fallback }, error: 'billingPolicy 必须是对象。' };
  }
  const input = value as Record<string, unknown>;
  const costMicrosPerRequest = boundedInteger(
    input.costMicrosPerRequest,
    0,
    2_000_000_000,
  );
  const estimatedRequestsPerRun = boundedInteger(
    input.estimatedRequestsPerRun,
    1,
    100,
  );
  const monthlyBudgetMicros = boundedInteger(
    input.monthlyBudgetMicros,
    0,
    9_000_000_000_000_000,
  );
  const softLimitPercent = boundedInteger(input.softLimitPercent, 1, 99);
  if (
    costMicrosPerRequest === null ||
    estimatedRequestsPerRun === null ||
    monthlyBudgetMicros === null ||
    softLimitPercent === null
  ) {
    return {
      policy: { ...fallback },
      error:
        '成本单价、预留请求数、月预算和软阈值必须分别位于 0–2,000,000,000、1–100、0–9,000,000,000,000,000 和 1–99。',
    };
  }
  if (monthlyBudgetMicros > 0 && costMicrosPerRequest === 0) {
    return {
      policy: { ...fallback },
      error: '设置月预算前必须配置非零的每请求估算成本。',
    };
  }
  if (
    monthlyBudgetMicros > 0 &&
    costMicrosPerRequest * estimatedRequestsPerRun > monthlyBudgetMicros
  ) {
    return {
      policy: { ...fallback },
      error: '单次采集预留成本不能高于整月预算。',
    };
  }
  return {
    policy: {
      costMicrosPerRequest,
      estimatedRequestsPerRun,
      monthlyBudgetMicros,
      softLimitPercent,
    },
  };
}

export function utcMonthStart(now = new Date()) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
}

export async function sourceMonthSpendMicros(
  db: SqlDatabase,
  sourceConfigId: string,
  now = new Date(),
) {
  const row = await db
    .prepare(`
    SELECT COALESCE(SUM(cost_micros), 0) AS spent
    FROM ingestion_runs
    WHERE source_config_id = ? AND created_at >= ? AND status <> 'cancelled'
  `)
    .bind(sourceConfigId, utcMonthStart(now))
    .first<{ spent: number | string }>();
  return Number(row?.spent ?? 0);
}

export class SourceBudgetExceededError extends Error {
  readonly sourceId: string;
  readonly spentMicros: number;
  readonly reservationMicros: number;
  readonly budgetMicros: number;
  readonly affectedArticleCount: number;
  readonly affectedTopicCount: number;

  constructor(input: {
    sourceId: string;
    spentMicros: number;
    reservationMicros: number;
    budgetMicros: number;
    affectedArticleCount?: number;
    affectedTopicCount?: number;
  }) {
    super('来源月度采集预算已耗尽。');
    this.name = 'SourceBudgetExceededError';
    this.sourceId = input.sourceId;
    this.spentMicros = input.spentMicros;
    this.reservationMicros = input.reservationMicros;
    this.budgetMicros = input.budgetMicros;
    this.affectedArticleCount = input.affectedArticleCount ?? 0;
    this.affectedTopicCount = input.affectedTopicCount ?? 0;
  }
}
