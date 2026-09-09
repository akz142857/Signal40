import type { SqlDatabase } from './sql.ts';
import type { ObjectStorage } from './storage.ts';
import { sha256Hex } from './hash.ts';

export type RawPayloadUploadState =
  | 'initiated'
  | 'uploaded'
  | 'committed'
  | 'aborted'
  | 'expired'
  | 'deleting'
  | 'deleted';

type RawPayloadUploadRow = {
  id: string;
  source_config_id: string;
  ingestion_run_id: string;
  state: RawPayloadUploadState;
  object_key: string;
  sha256: string;
  byte_size: number;
  expires_at: string;
  delete_after: string;
};

export class RawPayloadUploadError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = 'RawPayloadUploadError';
    this.status = status;
  }
}

export async function requireRawPayloadUploadForCommit(
  db: SqlDatabase,
  input: { sourceConfigId: string; ingestionRunId: string; objectKey: string },
  now = new Date(),
) {
  const upload = await db.prepare(`
    SELECT id, source_config_id, ingestion_run_id, state, object_key,
      sha256, byte_size, expires_at, delete_after
    FROM raw_payload_uploads
    WHERE ingestion_run_id = ? AND object_key = ?
    FOR UPDATE
  `).bind(input.ingestionRunId, input.objectKey).first<RawPayloadUploadRow>();
  if (
    !upload ||
    upload.source_config_id !== input.sourceConfigId ||
    upload.ingestion_run_id !== input.ingestionRunId
  ) {
    throw new RawPayloadUploadError('原始载荷没有匹配的上传会话。');
  }
  if (upload.state !== 'uploaded' || upload.expires_at <= now.toISOString()) {
    throw new RawPayloadUploadError(`原始载荷上传会话已处于 ${upload.state} 或已经过期。`);
  }
  return upload;
}

export async function commitRawPayloadUpload(
  db: SqlDatabase,
  uploadId: string,
  now = new Date(),
) {
  const timestamp = now.toISOString();
  const committed = await db.prepare(`
    UPDATE raw_payload_uploads
    SET state = 'committed', committed_at = ?, updated_at = ?, last_error_redacted = NULL
    WHERE id = ? AND state = 'uploaded' AND expires_at > ?
  `).bind(timestamp, timestamp, uploadId, timestamp).run();
  if (!committed.meta.changes) {
    throw new RawPayloadUploadError('原始载荷上传会话状态已改变，本次采集结果未提交。');
  }
}

async function sha256Bytes(data: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Upload raw source data behind a durable database session.
 *
 * The session is created before the object write. A process crash therefore leaves an
 * `initiated` row that the retention sweeper can delete after `expiresAt`; an object
 * write followed by a database failure is also recoverable through the deterministic key.
 */
export async function storeRawPayloadUpload(
  db: SqlDatabase,
  storage: ObjectStorage,
  input: {
    teamId?: string;
    sourceConfigId: string;
    ingestionRunId: string;
    objectKey: string;
    data: ArrayBuffer;
    contentType: string;
    expiresAt: string;
    deleteAfter: string;
  },
  now = new Date(),
) {
  if (!input.objectKey.startsWith(`sources/${input.sourceConfigId}/raw/${input.ingestionRunId}/`)) {
    throw new RawPayloadUploadError('原始载荷对象键与来源或运行不匹配。', 422);
  }
  if (input.expiresAt <= now.toISOString()) {
    throw new RawPayloadUploadError('原始载荷上传会话必须在未来过期。', 422);
  }
  if (input.deleteAfter <= input.expiresAt) {
    throw new RawPayloadUploadError('原始载荷删除时间必须晚于上传会话过期时间。', 422);
  }

  const teamId = input.teamId ?? 'default';
  const digest = await sha256Bytes(input.data);
  const uploadId = `raw_upload_${sha256Hex(`${teamId}:${input.sourceConfigId}:${input.ingestionRunId}`).slice(0, 32)}`;
  const timestamp = now.toISOString();
  let replayed = false;

  await db.transaction(async (tx) => {
    const existing = await tx.prepare(`
      SELECT id, source_config_id, ingestion_run_id, state, object_key,
        sha256, byte_size, expires_at, delete_after
      FROM raw_payload_uploads WHERE ingestion_run_id = ? FOR UPDATE
    `).bind(input.ingestionRunId).first<RawPayloadUploadRow>();
    if (existing) {
      if (existing.object_key !== input.objectKey || existing.sha256 !== digest || Number(existing.byte_size) !== input.data.byteLength) {
        throw new RawPayloadUploadError('同一采集运行不能上传不同的原始载荷。');
      }
      if (!['initiated', 'uploaded', 'aborted'].includes(existing.state)) {
        throw new RawPayloadUploadError(`原始载荷上传会话已处于 ${existing.state}。`);
      }
      replayed = true;
      await tx.prepare(`
        UPDATE raw_payload_uploads
        SET state = 'initiated', expires_at = ?, delete_after = ?, updated_at = ?,
            last_error_redacted = NULL
        WHERE id = ?
      `).bind(input.expiresAt, input.deleteAfter, timestamp, existing.id).run();
      return;
    }
    await tx.prepare(`
      INSERT INTO raw_payload_uploads
        (id, team_id, source_config_id, ingestion_run_id, state, object_key,
         sha256, byte_size, created_at, updated_at, expires_at, delete_after)
      VALUES (?, ?, ?, ?, 'initiated', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      uploadId,
      teamId,
      input.sourceConfigId,
      input.ingestionRunId,
      input.objectKey,
      digest,
      input.data.byteLength,
      timestamp,
      timestamp,
      input.expiresAt,
      input.deleteAfter,
    ).run();
  });

  try {
    await storage.put(input.objectKey, input.data, {
      contentType: input.contentType,
      customMetadata: {
        rawUploadId: uploadId,
        sourceConfigId: input.sourceConfigId,
        ingestionRunId: input.ingestionRunId,
        sha256: digest,
        byteSize: String(input.data.byteLength),
        deleteAfter: input.deleteAfter,
      },
    });
  } catch (error) {
    await db.prepare(`
      UPDATE raw_payload_uploads
      SET state = 'aborted', updated_at = ?, last_error_redacted = 'OBJECT_UPLOAD_FAILED'
      WHERE id = ? AND state = 'initiated'
    `).bind(new Date().toISOString(), uploadId).run();
    throw error;
  }

  const completedAt = new Date().toISOString();
  const completed = await db.prepare(`
    UPDATE raw_payload_uploads
    SET state = 'uploaded', updated_at = ?, last_error_redacted = NULL
    WHERE id = ? AND state = 'initiated' AND sha256 = ?
  `).bind(completedAt, uploadId, digest).run();
  if (!completed.meta.changes) {
    throw new RawPayloadUploadError('原始载荷已写入，但上传会话不能完成；对象将由清理任务回收。');
  }

  return {
    id: uploadId,
    objectKey: input.objectKey,
    sha256: digest,
    byteSize: input.data.byteLength,
    expiresAt: input.expiresAt,
    deleteAfter: input.deleteAfter,
    replayed,
  };
}
