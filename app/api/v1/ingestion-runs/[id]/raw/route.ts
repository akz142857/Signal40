import { config, db, storage } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { RawPayloadUploadError, storeRawPayloadUpload } from '@/lib/source-raw-payloads';
import { authorizeWorker } from '@/lib/worker-auth';
import { activeLeaseMatches } from '@/lib/job-lease';

// 多页 JSON 以一个有界 envelope 保存；总页面正文上限 10 MB，另留 envelope 开销。
const MAX_RAW_BYTES = 11_000_000;
const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1_000;

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.sourceWorkerToken))) return sourceApiError('Worker 未授权。', 401);
  const { id } = await context.params;
  const jobId = request.headers.get('x-job-id');
  const workerId = request.headers.get('x-worker-id');
  const leaseEpoch = Number(request.headers.get('x-lease-epoch'));
  if (!jobId || !workerId || !Number.isInteger(leaseEpoch) || leaseEpoch < 1) {
    return sourceApiError('X-Job-Id、X-Worker-Id 与有效 X-Lease-Epoch 必填。', 422);
  }
  const run = await db.prepare(`
    SELECT ir.source_config_id, ir.job_id, j.status AS job_status,
      j.lease_owner, j.lease_epoch, j.lease_expires_at, sc.team_id,
      sc.retention_mode, sc.retention_days
    FROM ingestion_runs ir JOIN jobs j ON j.id = ir.job_id JOIN source_configs sc ON sc.id = ir.source_config_id
    WHERE ir.id = ? LIMIT 1
  `).bind(id).first<{
    source_config_id: string; job_id: string; job_status: string;
    lease_owner: string | null; lease_epoch: number; lease_expires_at: string | null;
    team_id: string; retention_mode: string; retention_days: number;
  }>();
  if (!run || run.job_id !== jobId || !activeLeaseMatches({
    status: run.job_status,
    lease_owner: run.lease_owner,
    lease_epoch: run.lease_epoch,
    lease_expires_at: run.lease_expires_at,
  }, { workerId, leaseEpoch })) return sourceApiError('采集运行或 Worker 租约无效、已过期。', 409, { errorCode: 'LEASE_LOST' });
  if (run.retention_mode !== 'raw') return sourceApiError('该来源只允许保留必要元数据。', 409);
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_RAW_BYTES) return sourceApiError('原始载荷必须为 1 字节到 11 MB。', 413);
  const objectKey = `sources/${run.source_config_id}/raw/${id}/payload`;
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + UPLOAD_SESSION_TTL_MS).toISOString();
  const deleteAfter = new Date(now.valueOf() + run.retention_days * 86_400_000).toISOString();
  try {
    const upload = await storeRawPayloadUpload(db, storage, {
      teamId: run.team_id,
      sourceConfigId: run.source_config_id,
      ingestionRunId: id,
      objectKey,
      data,
      contentType: request.headers.get('content-type') || 'application/octet-stream',
      expiresAt,
      deleteAfter,
    }, now);
    return Response.json(upload, { status: 201 });
  } catch (error) {
    if (error instanceof RawPayloadUploadError) {
      return sourceApiError(error.message, error.status, { errorCode: 'STORAGE_ERROR' });
    }
    return sourceApiError('原始载荷上传失败，将由清理任务回收。', 503, {
      errorCode: 'STORAGE_ERROR', retryable: true,
    });
  }
}
