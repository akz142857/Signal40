import { config, db } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { authorizeWorker } from '@/lib/worker-auth';

type PageRow = {
  page_key: string;
  page_ordinal: number;
  final_page: number;
  checkpoint_after_json: unknown;
  fetched_count: number;
  accepted_count: number;
  rejected_count: number;
  duplicate_count: number;
  request_count: number;
  byte_count: number;
};

/** 当前租约只读取恢复游标和累计数，不返回文章、原载荷或敏感配置。 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!(await authorizeWorker(request, config.sourceWorkerToken))) {
    return sourceApiError('Worker 未授权。', 401);
  }
  const url = new URL(request.url);
  const jobId = url.searchParams.get('jobId');
  const workerId = url.searchParams.get('workerId');
  const leaseEpoch = Number(url.searchParams.get('leaseEpoch'));
  if (!jobId || !workerId || !Number.isInteger(leaseEpoch) || leaseEpoch < 1) {
    return sourceApiError('jobId、workerId 和有效 leaseEpoch 必填。', 422);
  }
  const { id } = await context.params;
  const run = await db.prepare(`
    SELECT ir.job_id, ir.checkpoint_before_json, j.status AS job_status,
      j.lease_owner, j.lease_epoch, j.lease_expires_at
    FROM ingestion_runs ir
    JOIN jobs j ON j.id = ir.job_id
    WHERE ir.id = ?
    LIMIT 1
  `).bind(id).first<{
    job_id: string;
    checkpoint_before_json: unknown;
    job_status: string;
    lease_owner: string | null;
    lease_epoch: number;
    lease_expires_at: string | null;
  }>();
  if (
    !run || run.job_id !== jobId || run.job_status !== 'leased' ||
    run.lease_owner !== workerId || run.lease_epoch !== leaseEpoch ||
    !run.lease_expires_at || run.lease_expires_at <= new Date().toISOString()
  ) {
    return sourceApiError('采集运行与当前 Worker 租约或 leaseEpoch 不匹配。', 409, {
      errorCode: 'LEASE_LOST',
    });
  }
  const pages = (await db.prepare(`
    SELECT page_key, page_ordinal, final_page, checkpoint_after_json,
      fetched_count, accepted_count, rejected_count, duplicate_count,
      request_count, byte_count
    FROM ingestion_pages
    WHERE ingestion_run_id = ? AND status = 'committed' AND page_ordinal IS NOT NULL
    ORDER BY page_ordinal ASC
    LIMIT 10000
  `).bind(id).all<PageRow>()).results;
  const totals = pages.reduce((sum, page) => ({
    fetchedCount: sum.fetchedCount + Number(page.fetched_count),
    acceptedCount: sum.acceptedCount + Number(page.accepted_count),
    rejectedCount: sum.rejectedCount + Number(page.rejected_count),
    duplicateCount: sum.duplicateCount + Number(page.duplicate_count),
    requestCount: sum.requestCount + Number(page.request_count),
    byteCount: sum.byteCount + Number(page.byte_count),
  }), { fetchedCount: 0, acceptedCount: 0, rejectedCount: 0, duplicateCount: 0, requestCount: 0, byteCount: 0 });
  const last = pages.at(-1);
  return Response.json({
    ingestionRunId: id,
    pageCount: pages.length,
    nextPageOrdinal: pages.length,
    lastPageKey: last?.page_key ?? null,
    finalPageCommitted: Boolean(last?.final_page),
    resumeCheckpointJson: last?.checkpoint_after_json ?? run.checkpoint_before_json ?? {},
    totals,
  });
}
