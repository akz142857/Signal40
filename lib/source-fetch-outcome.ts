export const SOURCE_FETCH_OUTCOMES = [
  'unknown',
  'modified',
  'not_modified',
] as const;

export type SourceFetchOutcome = (typeof SOURCE_FETCH_OUTCOMES)[number];

export function fetchOutcomeFromNotModified(
  notModified: boolean | undefined,
): SourceFetchOutcome {
  return notModified === true
    ? 'not_modified'
    : notModified === false
      ? 'modified'
      : 'unknown';
}

export function fetchOutcomeFromCheckpoint(
  value: unknown,
): SourceFetchOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'unknown';
  }
  const outcome = (value as Record<string, unknown>).lastFetchOutcome;
  return outcome === 'modified' || outcome === 'not_modified'
    ? outcome
    : 'unknown';
}

export function hasNotModifiedPayloadConflict(
  outcome: SourceFetchOutcome,
  input: {
    fetchedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    byteCount: number;
    contentCount?: number;
  },
) {
  return (
    outcome === 'not_modified' &&
    (input.fetchedCount > 0 ||
      input.acceptedCount > 0 ||
      input.rejectedCount > 0 ||
      input.byteCount > 0 ||
      Number(input.contentCount ?? 0) > 0)
  );
}
