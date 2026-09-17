import { config, db } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { authorizeWorker } from '@/lib/worker-auth';
import { activeLeaseMatches } from '@/lib/job-lease';
import {
  applyEmbeddingResults,
  EMBEDDING_JOB_ITEM_LIMIT,
  type EmbeddingResultItem,
} from '@/lib/embedding-jobs';

type EmbeddingBody = {
  jobId?: string;
  workerId?: string;
  leaseEpoch?: number;
  model?: string;
  version?: number;
  results?: unknown;
};

function asRecord(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * 解析写回的向量。
 *
 * 任何一条不合法就整批拒绝，而不是丢掉坏的那条继续写：
 * 一批里出现结构错误说明 Worker 那边的契约理解有偏差，
 * 这时写进去的「好数据」也不值得信。
 */
function parseResults(value: unknown): EmbeddingResultItem[] | null {
  // 上限对齐作业载荷的条数上限：写回不可能比作业本身装的还多。
  if (!Array.isArray(value) || !value.length || value.length > EMBEDDING_JOB_ITEM_LIMIT)
    return null;
  const parsed: EmbeddingResultItem[] = [];
  let dimension = 0;
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) return null;
    const subject = record.subject;
    const id = record.id;
    const sourceHash = record.sourceHash;
    const embedding = record.embedding;
    if (subject !== 'article' && subject !== 'domain') return null;
    if (
      typeof id !== 'string' ||
      !id ||
      typeof sourceHash !== 'string' ||
      !sourceHash
    )
      return null;
    if (
      !Array.isArray(embedding) ||
      !embedding.length ||
      embedding.length > 4096
    )
      return null;
    if (
      embedding.some(
        (component) =>
          typeof component !== 'number' || !Number.isFinite(component),
      )
    )
      return null;
    // 批内维度必须一致：维度不同的向量之间余弦恒为 0，会静默地把相似度判定压平。
    if (!dimension) dimension = embedding.length;
    else if (embedding.length !== dimension) return null;
    parsed.push({ subject, id, sourceHash, embedding: embedding as number[] });
  }
  return parsed;
}

export async function POST(request: Request) {
  // 向量作业跑在 Render Worker 上——OPENAI_API_KEY 只有它持有。
  if (!(await authorizeWorker(request, config.renderWorkerToken))) {
    return sourceApiError('Worker 未授权。', 401);
  }
  let body: EmbeddingBody;
  try {
    body = (await request.json()) as EmbeddingBody;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  if (
    !body.jobId ||
    !body.workerId ||
    !Number.isInteger(body.leaseEpoch) ||
    Number(body.leaseEpoch) < 1 ||
    !body.model ||
    !Number.isInteger(body.version)
  ) {
    return sourceApiError(
      'jobId、workerId、有效 leaseEpoch、model 和 version 必填。',
      422,
    );
  }
  const results = parseResults(body.results);
  if (!results)
    return sourceApiError(
      'results 必须是非空的向量数组，且每条都带 subject、id、sourceHash。',
      422,
    );

  const jobId = body.jobId;
  const workerId = body.workerId;
  const model = body.model;
  const version = Number(body.version);
  const now = new Date();
  try {
    const result = await db.transaction(async (tx) => {
      const job = await tx
        .prepare(`
        SELECT status, lease_owner, lease_epoch, lease_expires_at, payload_json
        FROM jobs WHERE id = ? FOR UPDATE
      `)
        .bind(jobId)
        .first<{
          status: string;
          lease_owner: string | null;
          lease_epoch: number;
          lease_expires_at: string | null;
          payload_json: unknown;
        }>();
      if (!job) return { error: '向量作业不存在。', status: 404 as const };
      const payload = asRecord(job.payload_json);
      if (payload?.operation !== 'embedding') {
        return {
          error: '作业载荷与向量写回请求不匹配。',
          status: 409 as const,
        };
      }
      // 口径必须和入队时一致：Worker 换了模型却写回同一个作业，
      // 写进去的向量会和库里其它向量不可比，而且没人看得出来。
      if (payload.model !== model || Number(payload.version) !== version) {
        return {
          error: '写回的模型或向量口径版本与作业载荷不一致。',
          status: 409 as const,
        };
      }
      if (
        !activeLeaseMatches(
          job,
          { workerId, leaseEpoch: Number(body.leaseEpoch) },
          now,
        )
      ) {
        return {
          error: '向量作业租约或 leaseEpoch 无效、已过期。',
          status: 409 as const,
        };
      }
      /**
       * 写回的每一条都必须落在这个作业的载荷里。
       *
       * 少了这一层，租约就成了「可以写任意一行向量」的通行证：领域中心向量排在
       * 每个作业载荷最前面，任何领过一次作业的 Worker 都知道全部领域 id 和描述哈希，
       * 之后凭任意合法租约就能覆写中心向量——那是「这条选题在不在生产范围内」的
       * 唯一判据，写一个与所有文章都高余弦的中心，等于把自动生产的范围闸门常开。
       *
       * 载荷就在同一个事务里读出来了，逐条比对是零成本的。
       */
      const allowed = new Map<string, string>();
      for (const item of Array.isArray(payload.items) ? payload.items : []) {
        const entry = asRecord(item);
        if (!entry) continue;
        const hash = typeof entry.sourceHash === 'string' ? entry.sourceHash : '';
        allowed.set(`${String(entry.subject)}:${String(entry.id)}`, hash);
      }
      const outOfScope = results.some(
        (result) =>
          allowed.get(`${result.subject}:${result.id}`) !== result.sourceHash,
      );
      if (outOfScope) {
        return {
          error: '写回条目不在该作业的载荷范围内。',
          status: 409 as const,
        };
      }
      const applied = await applyEmbeddingResults(
        tx,
        results,
        model,
        version,
        now,
      );
      return {
        response: { ...applied, submitted: results.length },
        status: 200 as const,
      };
    });
    if ('error' in result) return sourceResultError(result);
    return Response.json(result.response);
  } catch (error) {
    // 不回传底层错误信息：PostgreSQL 的报错里带列名和约束名，
    // 而这是一个新增的外部可达写入面。
    process.stderr.write(
      `向量写回失败 job=${jobId}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return sourceApiError(
      '向量写回失败。',
      503,
      {
        errorCode: 'STORAGE_ERROR',
        retryable: true,
      },
    );
  }
}
