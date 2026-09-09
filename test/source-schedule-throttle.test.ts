import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideSourceScheduleThrottle,
  parseSourceSchedulePolicy,
  sourceScheduleAdvancePlan,
} from '../lib/source-schedule-throttle.ts';

const now = new Date('2026-09-09T06:00:00.000Z');

void test('source schedule policy rejects ambiguous priority and switch values', () => {
  assert.match(
    parseSourceSchedulePolicy({
      schedulePriority: 101,
      autoThrottleEnabled: true,
    }).error ?? '',
    /0–100/,
  );
  assert.match(
    parseSourceSchedulePolicy({
      schedulePriority: 50,
      autoThrottleEnabled: 1,
    }).error ?? '',
    /布尔值/,
  );
});

void test('budget soft limit throttles only lower-priority opted-in sources', () => {
  const common = {
    autoThrottleEnabled: true,
    monthSpentMicros: 8_000,
    monthlyBudgetMicros: 10_000,
    softLimitPercent: 80,
    now,
  };
  assert.equal(
    decideSourceScheduleThrottle({ ...common, schedulePriority: 20 })
      .cadenceMultiplier,
    4,
  );
  assert.equal(
    decideSourceScheduleThrottle({ ...common, schedulePriority: 50 })
      .cadenceMultiplier,
    2,
  );
  assert.equal(
    decideSourceScheduleThrottle({ ...common, schedulePriority: 80 })
      .cadenceMultiplier,
    1,
  );
  assert.equal(
    decideSourceScheduleThrottle({
      ...common,
      schedulePriority: 10,
      autoThrottleEnabled: false,
    }).cadenceMultiplier,
    1,
  );
  assert.equal(
    decideSourceScheduleThrottle({
      ...common,
      schedulePriority: 10,
      monthSpentMicros: 7_999,
    }).cadenceMultiplier,
    1,
  );
});

void test('cadence plan preserves configured cron and identifies every skipped occurrence', () => {
  assert.deepEqual(
    sourceScheduleAdvancePlan(
      '* * * * *',
      '2026-09-09T06:00:00.000Z',
      4,
    ),
    {
      nextRunAt: '2026-09-09T06:04:00.000Z',
      skipped: [
        '2026-09-09T06:01:00.000Z',
        '2026-09-09T06:02:00.000Z',
        '2026-09-09T06:03:00.000Z',
      ],
    },
  );
});
