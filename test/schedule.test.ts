import assert from 'node:assert/strict';
import test from 'node:test';
import { cronMatches, isValidCron, nextScheduledMinute, scheduledMinuteSince, sourceRunRateLimit } from '../lib/schedule.ts';

void test('cron validation rejects out-of-range values', () => {
  assert.equal(isValidCron('0 */2 * * *'), true);
  assert.equal(isValidCron('61 * * * *'), false);
  assert.equal(isValidCron('* 25 * * *'), false);
});

void test('scheduler catches a missed UTC cron minute without duplicating it', () => {
  assert.equal(cronMatches('0 */2 * * *', new Date('2026-09-08T04:00:00Z')), true);
  assert.equal(
    scheduledMinuteSince('0 */2 * * *', '2026-09-08T02:05:00Z', new Date('2026-09-08T04:01:00Z')),
    '2026-09-08T04:00:00.000Z',
  );
  assert.equal(scheduledMinuteSince('0 */2 * * *', '2026-09-08T04:00:00Z', new Date('2026-09-08T04:01:00Z')), null);
});

void test('next scheduled minute is strictly after the supplied UTC minute', () => {
  assert.equal(
    nextScheduledMinute('0 */2 * * *', '2026-09-08T04:00:00Z'),
    '2026-09-08T06:00:00.000Z',
  );
  assert.equal(nextScheduledMinute('invalid', '2026-09-08T04:00:00Z'), null);
});

void test('source run limiter enforces a rolling one-minute quota', () => {
  const now = new Date('2026-09-08T04:01:00Z');
  assert.deepEqual(sourceRunRateLimit(['2026-09-08T04:00:20Z'], 2, now), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(
    sourceRunRateLimit(['2026-09-08T04:00:20Z', '2026-09-08T04:00:40Z'], 2, now),
    { allowed: false, retryAfterSeconds: 20 },
  );
  assert.deepEqual(sourceRunRateLimit(['2026-09-08T03:59:59Z'], 1, now), { allowed: true, retryAfterSeconds: 0 });
});
