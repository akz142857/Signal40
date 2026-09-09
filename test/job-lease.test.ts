import assert from 'node:assert/strict';
import test from 'node:test';
import { activeLeaseMatches } from '../lib/job-lease.ts';

const now = new Date('2026-09-09T04:00:00.000Z');
const lease = {
  status: 'leased',
  lease_owner: 'source-worker',
  lease_epoch: 3,
  lease_expires_at: '2026-09-09T04:05:00.000Z',
};

void test('worker writes require the current owner, epoch, state, and expiry', () => {
  assert.equal(
    activeLeaseMatches(
      lease,
      { workerId: 'source-worker', leaseEpoch: 3 },
      now,
    ),
    true,
  );
  assert.equal(
    activeLeaseMatches(
      lease,
      { workerId: 'source-worker', leaseEpoch: 2 },
      now,
    ),
    false,
  );
  assert.equal(
    activeLeaseMatches(
      lease,
      { workerId: 'other-worker', leaseEpoch: 3 },
      now,
    ),
    false,
  );
  assert.equal(
    activeLeaseMatches(
      { ...lease, status: 'succeeded' },
      { workerId: 'source-worker', leaseEpoch: 3 },
      now,
    ),
    false,
  );
  assert.equal(
    activeLeaseMatches(
      lease,
      { workerId: 'source-worker', leaseEpoch: 3 },
      new Date(lease.lease_expires_at),
    ),
    false,
  );
});
