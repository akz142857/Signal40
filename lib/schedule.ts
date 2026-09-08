function matchesField(value: number, expression: string, minimum: number, maximum: number) {
  return expression.split(',').some((part) => {
    const [rangeExpression, stepExpression] = part.split('/');
    const step = stepExpression === undefined ? 1 : Number(stepExpression);
    if (!Number.isInteger(step) || step < 1) return false;
    let start = minimum;
    let end = maximum;
    if (rangeExpression !== '*') {
      const bounds = rangeExpression.split('-').map(Number);
      start = bounds[0];
      end = bounds.length === 1 ? bounds[0] : bounds[1];
    }
    return Number.isInteger(start) && Number.isInteger(end) && start >= minimum && end <= maximum && start <= end && value >= start && value <= end && (value - start) % step === 0;
  });
}

function validField(expression: string, minimum: number, maximum: number) {
  return expression.split(',').every((part) => {
    const [rangeExpression, stepExpression] = part.split('/');
    if (!rangeExpression || (stepExpression !== undefined && (!/^\d+$/.test(stepExpression) || Number(stepExpression) < 1))) return false;
    if (rangeExpression === '*') return true;
    if (!/^\d+(?:-\d+)?$/.test(rangeExpression)) return false;
    const [start, end = start] = rangeExpression.split('-').map(Number);
    return start >= minimum && end <= maximum && start <= end;
  });
}

export function isValidCron(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return validField(fields[0], 0, 59)
    && validField(fields[1], 0, 23)
    && validField(fields[2], 1, 31)
    && validField(fields[3], 1, 12)
    && validField(fields[4], 0, 7);
}

export function cronMatches(expression: string, date: Date) {
  const [minute, hour, day, month, weekday] = expression.trim().split(/\s+/);
  if (!minute || !isValidCron(expression)) return false;
  const dayOfMonthMatches = matchesField(date.getUTCDate(), day, 1, 31);
  const dayOfWeekMatches = matchesField(date.getUTCDay(), weekday === '7' ? '0' : weekday, 0, 7)
    || (date.getUTCDay() === 0 && matchesField(7, weekday, 0, 7));
  const dayMatches = day === '*' || weekday === '*' ? dayOfMonthMatches && dayOfWeekMatches : dayOfMonthMatches || dayOfWeekMatches;
  return matchesField(date.getUTCMinutes(), minute, 0, 59)
    && matchesField(date.getUTCHours(), hour, 0, 23)
    && dayMatches
    && matchesField(date.getUTCMonth() + 1, month, 1, 12);
}

export function scheduledMinuteSince(expression: string, lastRunAt: string, now = new Date()) {
  const last = new Date(lastRunAt);
  if (Number.isNaN(last.valueOf()) || !isValidCron(expression)) return null;
  const end = new Date(Math.floor(now.valueOf() / 60_000) * 60_000);
  const earliest = Math.max(Math.floor(last.valueOf() / 60_000) * 60_000 + 60_000, end.valueOf() - 7 * 24 * 60 * 60_000);
  for (let value = earliest; value <= end.valueOf(); value += 60_000) {
    const candidate = new Date(value);
    if (cronMatches(expression, candidate)) return candidate.toISOString();
  }
  return null;
}

export function sourceRunRateLimit(
  recentRunTimes: string[],
  rateLimitPerMinute: number,
  now = new Date(),
) {
  const safeLimit = Math.max(1, Math.min(600, Math.trunc(rateLimitPerMinute)));
  const windowStart = now.valueOf() - 60_000;
  const timestamps = recentRunTimes
    .map((value) => new Date(value).valueOf())
    .filter((value) => Number.isFinite(value) && value > windowStart && value <= now.valueOf())
    .sort((left, right) => left - right);
  if (timestamps.length < safeLimit) return { allowed: true as const, retryAfterSeconds: 0 };
  return {
    allowed: false as const,
    retryAfterSeconds: Math.max(1, Math.ceil((timestamps[timestamps.length - safeLimit] + 60_000 - now.valueOf()) / 1_000)),
  };
}
