import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginIdempotentRequest,
  completeIdempotencyStatement,
  validIdempotencyKey,
} from '../lib/idempotency.ts';
import { createMemoryPg } from './pg-memory.ts';

void test('idempotency reservations replay exact responses and reject key reuse', async () => {
  const db = await createMemoryPg();
  const now = new Date('2026-09-08T02:00:00.000Z');
  const first = await beginIdempotentRequest(db, {
    scope: 'pipeline:user-1',
    key: 'request-1',
    request: { mode: 'sample' },
    now,
  });
  assert.equal(first.kind, 'owner');
  if (first.kind !== 'owner') return;

  const pending = await beginIdempotentRequest(db, {
    scope: 'pipeline:user-1',
    key: 'request-1',
    request: { mode: 'sample' },
    now,
  });
  assert.equal(pending.kind, 'pending');

  await completeIdempotencyStatement(
    db,
    first.reservation,
    201,
    { runId: 'run-1' },
  ).run();
  const replay = await beginIdempotentRequest(db, {
    scope: 'pipeline:user-1',
    key: 'request-1',
    request: { mode: 'sample' },
    now,
  });
  assert.deepEqual(replay, {
    kind: 'replay',
    status: 201,
    body: { runId: 'run-1' },
  });

  const conflict = await beginIdempotentRequest(db, {
    scope: 'pipeline:user-1',
    key: 'request-1',
    request: { mode: 'import' },
    now,
  });
  assert.equal(conflict.kind, 'conflict');
});

void test('过期的幂等记录被清理后同一个键可以重新预定', async () => {
  const db = await createMemoryPg();
  const created = new Date('2026-09-08T02:00:00.000Z');
  const first = await beginIdempotentRequest(db, {
    scope: 'pipeline:user-1',
    key: 'request-ttl',
    request: { mode: 'sample' },
    now: created,
    ttlMs: 1_000,
  });
  assert.equal(first.kind, 'owner');

  const afterExpiry = new Date(created.valueOf() + 5_000);
  const reclaimed = await beginIdempotentRequest(db, {
    scope: 'pipeline:user-1',
    key: 'request-ttl',
    request: { mode: 'import' },
    now: afterExpiry,
  });
  assert.equal(reclaimed.kind, 'owner', '过期记录应被删除，新的请求体不该判成冲突');
});

void test('idempotency keys are bounded printable ASCII', () => {
  assert.equal(validIdempotencyKey('pipeline:abc-123'), true);
  assert.equal(validIdempotencyKey(''), false);
  assert.equal(validIdempotencyKey('含中文'), false);
  assert.equal(validIdempotencyKey('x'.repeat(161)), false);
});
