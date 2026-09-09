import { config, db } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { authorizeWorker } from '@/lib/worker-auth';
import { activeLeaseMatches } from '@/lib/job-lease';
import {
  projectPublicSourceTestCapabilities,
  projectPublicSourceTestPreview,
} from '@/lib/source-public-projection';

type TestCompletion = {
  jobId?: string;
  workerId?: string;
  leaseEpoch?: number;
  configHash?: string;
  preview?: unknown;
  capabilities?: unknown;
};

export async function POST(request: Request, context: { params: Promise<{ id: string; testId: string }> }) {
  if (!(await authorizeWorker(request, config.sourceWorkerToken))) {
    return sourceApiError('Worker 未授权。', 401);
  }
  let body: TestCompletion;
  try { body = (await request.json()) as TestCompletion; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!body.jobId || !body.workerId || !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1 || !body.configHash || !Array.isArray(body.preview) || body.preview.length > 5) {
    return sourceApiError('jobId、workerId、有效 leaseEpoch、configHash 与最多 5 条 preview 必填。', 422);
  }
  const preview = projectPublicSourceTestPreview(body.preview);
  if (preview.length !== body.preview.length) {
    return sourceApiError('preview 只能包含有效的 title、url、publishedAt 及可选 author/summary。', 422);
  }
  const capabilities = projectPublicSourceTestCapabilities(body.capabilities);
  const workerId = body.workerId;
  const leaseEpoch = Number(body.leaseEpoch);
  const { id, testId } = await context.params;
  const now = new Date().toISOString();
  const result = await db.transaction(async (tx) => {
    const row = await tx.prepare(`
      SELECT sct.status, sct.job_id, sct.config_hash, sct.expires_at,
        j.status AS job_status, j.lease_owner, j.lease_epoch, j.lease_expires_at,
        sc.config_hash AS current_config_hash
      FROM source_connection_tests sct
      JOIN jobs j ON j.id = sct.job_id
      JOIN source_configs sc ON sc.id = sct.source_config_id
      WHERE sct.id = ? AND sct.source_config_id = ?
      FOR UPDATE OF sct, j, sc
    `).bind(testId, id).first<{
      status: string; job_id: string; config_hash: string; expires_at: string;
      job_status: string; lease_owner: string | null; lease_epoch: number; lease_expires_at: string | null;
      current_config_hash: string;
    }>();
    if (!row) return { error: '来源测试不存在。', status: 404 as const };
    if (row.status === 'succeeded') return { completed: true, replayed: true };
    if (row.job_id !== body.jobId || !activeLeaseMatches({ status: row.job_status, lease_owner: row.lease_owner, lease_epoch: row.lease_epoch, lease_expires_at: row.lease_expires_at }, { workerId, leaseEpoch }, new Date(now))) {
      return { error: '来源测试与当前 Worker 租约、leaseEpoch 不匹配或已过期。', status: 409 as const };
    }
    if (row.expires_at <= now || row.config_hash !== body.configHash || row.current_config_hash !== body.configHash) {
      return { error: '来源配置或测试已经过期，请重新测试。', status: 409 as const };
    }
    await tx.batch([
      tx.prepare(`
        UPDATE source_connection_tests SET status = 'succeeded', preview_json = ?,
          capabilities_json = ?, error_code = NULL, error_detail_redacted = NULL,
          finished_at = ? WHERE id = ?
      `).bind(JSON.stringify(preview), JSON.stringify(capabilities), now, testId),
      tx.prepare(`
        UPDATE source_configs SET lifecycle_status = CASE WHEN enabled = 1 THEN 'enabled' ELSE 'tested' END,
          health_status = 'healthy', last_tested_config_hash = config_hash,
          last_tested_at = ?, last_error = NULL, last_error_code = NULL,
          last_error_detail_redacted = NULL, retry_after = NULL,
          backoff_until = NULL, updated_at = ?
        WHERE id = ? AND config_hash = ?
      `).bind(now, now, id, body.configHash),
    ]);
    return { completed: true, replayed: false };
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}
