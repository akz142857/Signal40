export function positiveInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

export function boundedTrimmedText(
  value: unknown,
  bounds: { minimum: number; maximum: number },
) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length >= bounds.minimum && normalized.length <= bounds.maximum
    ? normalized
    : null;
}
