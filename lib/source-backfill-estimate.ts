import { stableHash } from './hash.ts';

export const SOURCE_BACKFILL_ESTIMATE_VERSION = '2026-09-09.v1';
export const DEFAULT_BACKFILL_MAX_ITEMS = 20;
export const DEFAULT_BACKFILL_WINDOW_DAYS = 7;

export type SourceBackfillWindow = {
  from: string;
  to: string;
  maxItems: number;
};

export function parseSourceBackfillWindow(input: {
  from?: unknown;
  to?: unknown;
  maxItems?: unknown;
}): { window: SourceBackfillWindow } | { error: string } {
  if (typeof input.from !== 'string' || typeof input.to !== 'string') {
    return { error: 'from 和 to 必须是有效时间，且 from 早于 to。' };
  }
  const from = new Date(input.from);
  const to = new Date(input.to);
  const maxItems = input.maxItems ?? 100;
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from >= to) {
    return { error: 'from 和 to 必须是有效时间，且 from 早于 to。' };
  }
  if (!Number.isInteger(maxItems) || Number(maxItems) < 1 || Number(maxItems) > 100) {
    return { error: 'maxItems 必须是 1–100 的整数。' };
  }
  return {
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
      maxItems: Number(maxItems),
    },
  };
}

export function estimateSourceBackfill(input: {
  sourceId: string;
  sourceVersion: number;
  window: SourceBackfillWindow;
  configuredRequestsPerRun: number;
  costMicrosPerRequest: number;
  rateLimitPerMinute: number;
}) {
  const lookbackSeconds = Math.ceil(
    (new Date(input.window.to).valueOf() - new Date(input.window.from).valueOf()) /
      1000,
  );
  const lookbackDays = Math.round((lookbackSeconds / 86_400) * 100) / 100;
  // The connector-specific configured estimate is the floor. A large item cap
  // adds conservative 20-item request units so confirmation never understates cost.
  const estimatedRequests = Math.max(
    1,
    Math.ceil(input.configuredRequestsPerRun),
    Math.ceil(input.window.maxItems / DEFAULT_BACKFILL_MAX_ITEMS),
  );
  const estimatedCostMicros = Math.max(0, input.costMicrosPerRequest) * estimatedRequests;
  const estimatedDurationSeconds = Math.max(
    5,
    Math.ceil((estimatedRequests / Math.max(1, input.rateLimitPerMinute)) * 60),
  );
  const requiresConfirmation =
    input.window.maxItems > DEFAULT_BACKFILL_MAX_ITEMS ||
    lookbackSeconds > DEFAULT_BACKFILL_WINDOW_DAYS * 86_400;
  const frozen = {
    basisVersion: SOURCE_BACKFILL_ESTIMATE_VERSION,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    from: input.window.from,
    to: input.window.to,
    maxItems: input.window.maxItems,
    itemUpperBound: input.window.maxItems,
    estimatedRequests,
    estimatedCostMicros,
    estimatedDurationSeconds,
  };
  return {
    ...frozen,
    lookbackDays,
    costMode: input.costMicrosPerRequest > 0 ? ('modeled' as const) : ('unmodeled' as const),
    requiresConfirmation,
    confirmationHash: stableHash(frozen),
  };
}

export function sourceBackfillConfirmationValid(
  estimate: Pick<
    ReturnType<typeof estimateSourceBackfill>,
    'requiresConfirmation' | 'confirmationHash'
  >,
  input: { confirmed?: unknown; confirmationHash?: unknown },
) {
  return (
    !estimate.requiresConfirmation ||
    (input.confirmed === true &&
      input.confirmationHash === estimate.confirmationHash)
  );
}
