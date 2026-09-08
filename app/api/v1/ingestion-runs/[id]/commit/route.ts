import { config, db } from '@/lib/runtime';
import { normalizeArticles, runPipeline, validateArticleInput, type ArticleInput } from '@/lib/domain';
import { loadRecentArticles, persistArticlesWithRevisions, persistPipeline } from '@/lib/persistence';
import { authorizeWorker } from '@/lib/worker-auth';

const MAX_ARTICLES = 100;
const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.workerToken))) {
    return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return Response.json({ error: '采集提交不能超过 1 MB。' }, { status: 413 });
  }
  let body: { jobId?: string; articles?: unknown; fetchedCount?: number; checkpoint?: string | null; rawObjectKey?: string | null };
  try { body = JSON.parse(raw) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.jobId || !Array.isArray(body.articles) || body.articles.length > MAX_ARTICLES) {
    return Response.json({ error: `jobId 与 0–${MAX_ARTICLES} 条 articles 必填。` }, { status: 422 });
  }
  const { id } = await context.params;
  const run = await db.prepare(
    `SELECT ir.id, ir.source_config_id, ir.status, ir.job_id, j.status AS job_status
     FROM ingestion_runs ir JOIN jobs j ON j.id = ir.job_id WHERE ir.id = ? LIMIT 1`,
  ).bind(id).first<{ id: string; source_config_id: string; status: string; job_id: string; job_status: string }>();
  if (!run) return Response.json({ error: '采集运行不存在。' }, { status: 404 });
  if (run.job_id !== body.jobId || run.job_status !== 'leased') {
    return Response.json({ error: '采集运行与当前作业租约不匹配。' }, { status: 409 });
  }
  if (!['queued', 'running'].includes(run.status)) {
    return Response.json({ error: `采集运行已处于 ${run.status}。` }, { status: 409 });
  }
  if (body.rawObjectKey && !body.rawObjectKey.startsWith(`sources/${run.source_config_id}/raw/${id}/`)) return Response.json({ error: '原始载荷对象键与来源或运行不匹配。' }, { status: 422 });
  const now = new Date();
  const issues = body.articles.map((article, index) => ({ index, issue: validateArticleInput(article, now) })).filter((item) => item.issue);
  if (issues.length) {
    return Response.json({ error: '采集数据校验失败。', issues: issues.slice(0, 10) }, { status: 422 });
  }
  const articles = body.articles as ArticleInput[];
  const normalized = await persistArticlesWithRevisions(db, normalizeArticles(articles), now, body.rawObjectKey ?? null);
  const rollingWindowStart = new Date(now.valueOf() - 72 * 60 * 60 * 1000);
  const corpus = await loadRecentArticles(db, rollingWindowStart);
  const topics = runPipeline(corpus, now);
  await db.prepare("UPDATE ingestion_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?").bind(now.toISOString(), id).run();
  const pipelineRunId = await persistPipeline(db, topics, 'import', corpus.length, now);
  const checkpoint = body.checkpoint ?? normalized[0]?.publishedAt ?? null;
  const finishedAt = new Date().toISOString();
  const fetchedCount = Math.max(normalized.length, body.fetchedCount ?? articles.length);
  const rejectedCount = Math.max(0, fetchedCount - normalized.length);
  const ingestionStatus = rejectedCount > 0 ? 'partial' : 'succeeded';
  await db.batch([
    db.prepare('UPDATE ingestion_runs SET status = ?, checkpoint_after = ?, fetched_count = ?, accepted_count = ?, rejected_count = ?, finished_at = ? WHERE id = ?').bind(ingestionStatus, checkpoint, fetchedCount, normalized.length, rejectedCount, finishedAt, id),
    db.prepare('UPDATE source_configs SET checkpoint = ?, last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?').bind(checkpoint, finishedAt, finishedAt, run.source_config_id),
  ]);
  return Response.json({ ingestionRunId: id, status: ingestionStatus, pipelineRunId, topicCount: topics.length, acceptedCount: normalized.length, rejectedCount, corpusCount: corpus.length, rollingWindowHours: 72, checkpoint });
}
