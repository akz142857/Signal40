import type { SqlDatabase } from './sql.ts';
import { projectPublicSourceRun } from './source-public-projection.ts';

export type SourceRunCursor = {
  createdAt: string;
  id: string;
};

const MAX_CURSOR_LENGTH = 1024;

export function encodeSourceRunCursor(cursor: SourceRunCursor) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeSourceRunCursor(value: string | null) {
  if (!value) return { cursor: null as SourceRunCursor | null };
  if (value.length > MAX_CURSOR_LENGTH) return { error: '运行列表 cursor 无效。' };
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return { error: '运行列表 cursor 无效。' };
    }
    const { createdAt, id } = decoded as Record<string, unknown>;
    if (
      typeof createdAt !== 'string' ||
      Number.isNaN(new Date(createdAt).valueOf()) ||
      typeof id !== 'string' ||
      !id ||
      id.length > 200
    ) {
      return { error: '运行列表 cursor 无效。' };
    }
    return { cursor: { createdAt, id } };
  } catch {
    return { error: '运行列表 cursor 无效。' };
  }
}

export function sourceRunPageLimit(value: string | null) {
  if (value === null) return { limit: 50 };
  if (!/^\d+$/.test(value)) return { error: 'limit 必须是 1–100 的整数。' };
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return { error: 'limit 必须是 1–100 的整数。' };
  }
  return { limit };
}

export async function listSourceRunPage(
  db: SqlDatabase,
  input: { sourceConfigId: string; limit: number; cursor: SourceRunCursor | null },
) {
  const statement = input.cursor
    ? db
        .prepare(`
          SELECT id, status, quarantine_status, trigger, accepted_count,
            rejected_count, duplicate_count, created_at, finished_at, error_code
          FROM ingestion_runs
          WHERE source_config_id = ?
            AND (created_at < ? OR (created_at = ? AND id < ?))
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `)
        .bind(
          input.sourceConfigId,
          input.cursor.createdAt,
          input.cursor.createdAt,
          input.cursor.id,
          input.limit + 1,
        )
    : db
        .prepare(`
          SELECT id, status, quarantine_status, trigger, accepted_count,
            rejected_count, duplicate_count, created_at, finished_at, error_code
          FROM ingestion_runs
          WHERE source_config_id = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `)
        .bind(input.sourceConfigId, input.limit + 1);
  const result = await statement.all<
    Record<string, unknown> & { id: string; created_at: string }
  >();
  const hasMore = result.results.length > input.limit;
  const rawRuns = result.results.slice(0, input.limit);
  const last = rawRuns.at(-1);
  return {
    runs: rawRuns.map((row) => projectPublicSourceRun(row)),
    nextCursor:
      hasMore && last
        ? encodeSourceRunCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}

export async function getSourceRun(
  db: SqlDatabase,
  input: { sourceConfigId: string; runId: string },
) {
  const row = await db.prepare(`
    SELECT id, status, quarantine_status, trigger, accepted_count,
      rejected_count, duplicate_count, created_at, finished_at, error_code
    FROM ingestion_runs
    WHERE source_config_id = ? AND id = ?
    LIMIT 1
  `).bind(input.sourceConfigId, input.runId).first<Record<string, unknown>>();
  return row ? projectPublicSourceRun(row) : null;
}
