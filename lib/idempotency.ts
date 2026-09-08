import { stableHash } from './hash.ts';

export const IDEMPOTENCY_KEY_MAX_LENGTH = 160;

type StoredRecord = {
  request_hash: string;
  response_status: number;
  response_json: string;
  expires_at: string;
};

export type IdempotencyReservation = {
  storageKey: string;
  scope: string;
  requestHash: string;
  token: string;
};

export type IdempotencyStart =
  | { kind: 'owner'; reservation: IdempotencyReservation }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'pending' };

export function validIdempotencyKey(value: string | null) {
  return Boolean(
    value &&
      value.length <= IDEMPOTENCY_KEY_MAX_LENGTH &&
      /^[\x21-\x7e]+$/.test(value),
  );
}

function decodeStoredBody(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { error: '已保存的幂等响应损坏，请联系管理员。' };
  }
}

export async function beginIdempotentRequest(
  db: D1Database,
  input: {
    scope: string;
    key: string;
    request: unknown;
    now?: Date;
    ttlMs?: number;
  },
): Promise<IdempotencyStart> {
  const now = input.now ?? new Date();
  const requestHash = stableHash(input.request);
  const storageKey = `${input.scope}:${input.key}`;
  const existing = await db
    .prepare(
      'SELECT request_hash, response_status, response_json, expires_at FROM idempotency_records WHERE key = ? AND scope = ?',
    )
    .bind(storageKey, input.scope)
    .first<StoredRecord>();
  if (existing && existing.expires_at > now.toISOString()) {
    if (existing.request_hash !== requestHash) return { kind: 'conflict' };
    if (existing.response_status === 425) return { kind: 'pending' };
    return {
      kind: 'replay',
      status: existing.response_status,
      body: decodeStoredBody(existing.response_json),
    };
  }
  if (existing) {
    await db.prepare('DELETE FROM idempotency_records WHERE key = ?').bind(storageKey).run();
  }

  const token = crypto.randomUUID();
  const responseJson = JSON.stringify({ reservationToken: token });
  const expiresAt = new Date(
    now.valueOf() + (input.ttlMs ?? 24 * 60 * 60 * 1_000),
  ).toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO idempotency_records
       (key, scope, request_hash, response_status, response_json, expires_at, created_at)
       VALUES (?, ?, ?, 425, ?, ?, ?)`,
    )
    .bind(
      storageKey,
      input.scope,
      requestHash,
      responseJson,
      expiresAt,
      now.toISOString(),
    )
    .run();
  const claimed = await db
    .prepare(
      'SELECT request_hash, response_status, response_json, expires_at FROM idempotency_records WHERE key = ? AND scope = ?',
    )
    .bind(storageKey, input.scope)
    .first<StoredRecord>();
  if (!claimed) throw new Error('无法建立幂等请求记录。');
  if (claimed.request_hash !== requestHash) return { kind: 'conflict' };
  if (claimed.response_status !== 425) {
    return {
      kind: 'replay',
      status: claimed.response_status,
      body: decodeStoredBody(claimed.response_json),
    };
  }
  if (claimed.response_json !== responseJson) return { kind: 'pending' };
  return {
    kind: 'owner',
    reservation: { storageKey, scope: input.scope, requestHash, token },
  };
}

export function completeIdempotencyStatement(
  db: D1Database,
  reservation: IdempotencyReservation,
  status: number,
  body: unknown,
) {
  return db
    .prepare(
      `UPDATE idempotency_records
       SET response_status = ?, response_json = ?
       WHERE key = ? AND scope = ? AND request_hash = ? AND response_status = 425
         AND response_json = ?`,
    )
    .bind(
      status,
      JSON.stringify(body),
      reservation.storageKey,
      reservation.scope,
      reservation.requestHash,
      JSON.stringify({ reservationToken: reservation.token }),
    );
}

export async function abandonIdempotentRequest(
  db: D1Database,
  reservation: IdempotencyReservation,
) {
  await db
    .prepare(
      `DELETE FROM idempotency_records
       WHERE key = ? AND scope = ? AND request_hash = ? AND response_status = 425
         AND response_json = ?`,
    )
    .bind(
      reservation.storageKey,
      reservation.scope,
      reservation.requestHash,
      JSON.stringify({ reservationToken: reservation.token }),
    )
    .run();
}
