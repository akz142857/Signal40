import assert from 'node:assert/strict';
import test from 'node:test';
import {
  beginIdempotentRequest,
  completeIdempotencyStatement,
  validIdempotencyKey,
} from '../lib/idempotency.ts';

type Row = {
  scope: string;
  request_hash: string;
  response_status: number;
  response_json: string;
  expires_at: string;
  created_at: string;
};

class MemoryStatement {
  private values: unknown[] = [];
  private readonly rows: Map<string, Row>;
  private readonly sql: string;

  constructor(rows: Map<string, Row>, sql: string) {
    this.rows = rows;
    this.sql = sql;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    const [key, scope] = this.values as [string, string];
    const row = this.rows.get(key);
    return (row?.scope === scope ? row : null) as T | null;
  }

  async run() {
    if (this.sql.includes('INSERT OR IGNORE')) {
      const [key, scope, requestHash, responseJson, expiresAt, createdAt] =
        this.values as string[];
      if (!this.rows.has(key)) {
        this.rows.set(key, {
          scope,
          request_hash: requestHash,
          response_status: 425,
          response_json: responseJson,
          expires_at: expiresAt,
          created_at: createdAt,
        });
      }
    } else if (this.sql.includes('UPDATE idempotency_records')) {
      const [status, responseJson, key, scope, requestHash, reservationJson] =
        this.values as [number, string, string, string, string, string];
      const row = this.rows.get(key);
      if (
        row?.scope === scope &&
        row.request_hash === requestHash &&
        row.response_status === 425 &&
        row.response_json === reservationJson
      ) {
        row.response_status = status;
        row.response_json = responseJson;
      }
    } else if (this.sql.includes('DELETE FROM idempotency_records')) {
      this.rows.delete(this.values[0] as string);
    }
    return { success: true };
  }
}

function memoryDb() {
  const rows = new Map<string, Row>();
  return {
    prepare(sql: string) {
      return new MemoryStatement(rows, sql);
    },
  } as unknown as D1Database;
}

void test('idempotency reservations replay exact responses and reject key reuse', async () => {
  const db = memoryDb();
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

void test('idempotency keys are bounded printable ASCII', () => {
  assert.equal(validIdempotencyKey('pipeline:abc-123'), true);
  assert.equal(validIdempotencyKey(''), false);
  assert.equal(validIdempotencyKey('含中文'), false);
  assert.equal(validIdempotencyKey('x'.repeat(161)), false);
});
