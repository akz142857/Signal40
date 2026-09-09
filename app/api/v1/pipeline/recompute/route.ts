import { config, db } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { runPipeline } from '@/lib/domain';
import { loadRecentArticles, persistPipeline } from '@/lib/persistence';
import { authorizeWorker } from '@/lib/worker-auth';
import { sha256Hex } from '@/lib/hash';
import { activeLeaseMatches } from '@/lib/job-lease';
import { loadApprovedEvidencePolicy } from '@/lib/social-evidence';

type RecomputeBody = { jobId?: string; workerId?: string; leaseEpoch?: number; derivationKey?: string };

function asRecord(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

export async function POST(request: Request) {
  if (!(await authorizeWorker(request, config.sourceWorkerToken))) {
    return sourceApiError('Worker 未授权。', 401);
  }
  let body: RecomputeBody;
  try { body = (await request.json()) as RecomputeBody; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!body.jobId || !body.workerId || !Number.isInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1 || !body.derivationKey) {
    return sourceApiError('jobId、workerId、有效 leaseEpoch 和 derivationKey 必填。', 422);
  }
  const jobId = body.jobId;
  const workerId = body.workerId;
  const derivationKey = body.derivationKey;
  const now = new Date();
  try {
    const result = await db.transaction(async (tx) => {
      const job = await tx.prepare(`
        SELECT status, lease_owner, lease_epoch, lease_expires_at, payload_json
        FROM jobs WHERE id = ? FOR UPDATE
      `).bind(jobId).first<{
        status: string; lease_owner: string | null; lease_epoch: number; lease_expires_at: string | null; payload_json: unknown;
      }>();
      if (!job) return { error: '派生重算作业不存在。', status: 404 as const };
      const payload = asRecord(job.payload_json);
      if (payload?.operation !== 'topic_recompute' || payload.derivationKey !== derivationKey) {
        return { error: '作业载荷与重算请求不匹配。', status: 409 as const };
      }
      if (!activeLeaseMatches(job, { workerId, leaseEpoch: Number(body.leaseEpoch) }, now)) {
        return { error: '派生重算作业租约或 leaseEpoch 无效、已过期。', status: 409 as const };
      }
      const pipelineRunId = `pipeline_derived_${sha256Hex(derivationKey).slice(0, 32)}`;
      const existing = await tx.prepare('SELECT article_count, topic_count FROM pipeline_runs WHERE id = ? LIMIT 1')
        .bind(pipelineRunId).first<{ article_count: number; topic_count: number }>();
      if (existing) return { response: { pipelineRunId, articleCount: existing.article_count, topicCount: existing.topic_count, replayed: true }, status: 200 as const };
      const rollingWindowStart = new Date(now.valueOf() - 72 * 60 * 60 * 1000);
      const corpus = await loadRecentArticles(tx, rollingWindowStart);
      const evidencePolicy = await loadApprovedEvidencePolicy(tx);
      const topics = runPipeline(corpus, now, evidencePolicy);
      await persistPipeline(tx, topics, 'import', corpus.length, now, { runId: pipelineRunId });
      return { response: { pipelineRunId, articleCount: corpus.length, topicCount: topics.length, replayed: false }, status: 200 as const };
    });
    if ('error' in result) return sourceResultError(result);
    return Response.json(result.response);
  } catch (error) {
    return sourceApiError(error instanceof Error ? error.message : '主题重算失败。', 503, {
      errorCode: 'STORAGE_ERROR', retryable: true,
    });
  }
}
