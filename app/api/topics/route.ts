import { config, db } from '@/lib/runtime';
import {
  runPipeline,
  validateArticleInput,
  type ArticleInput,
} from '@/lib/domain';
import {
  createPipelineRunId,
  loadLatestTopics,
  persistPipeline,
} from '@/lib/persistence';
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotencyStatement,
  validIdempotencyKey,
  type IdempotencyReservation,
} from '@/lib/idempotency';
import { resolveActor, stableHash } from '@/lib/workflow';

const MAX_ARTICLES = 100;
const MAX_BODY_BYTES = 1_000_000;

export async function GET(request: Request) {
  const actor = await resolveActor(
    request,
    db,
    config.bootstrapAdminEmails,
  );
  if (!actor)
    return Response.json(
      { error: '用户未加入 Signal 40 团队。' },
      { status: 403 },
    );
  try {
    const persisted = await loadLatestTopics(db);
    if (persisted.run) {
      return Response.json({
        topics: persisted.topics,
        source: persisted.run.mode,
        runAt: persisted.run.created_at,
      });
    }
    // 没有已保存运行时返回空列表，不用示例数据兜底。
    // 之前这里会回退到 lib/sample-data，全新部署上看起来就像已经有了三条真实选题；
    // 对一个以证据完整性为前提的系统，分不清真假数据比没有数据危险得多。
    return Response.json({ topics: [], source: 'empty', runAt: null });
  } catch {
    return Response.json(
      { error: '无法读取选题数据库，请稍后重试。' },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const actor = await resolveActor(
    request,
    db,
    config.bootstrapAdminEmails,
  );
  if (!actor)
    return Response.json(
      { error: '用户未加入 Signal 40 团队。' },
      { status: 403 },
    );
  if (!['researcher', 'admin'].includes(actor.role))
    return Response.json(
      { error: '只有研究员或管理员可以运行选题管道。' },
      { status: 403 },
    );
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(idempotencyKey))
    return Response.json(
      { error: '必须提供有效的 Idempotency-Key。' },
      { status: 400 },
    );
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES)
    return Response.json({ error: '请求体不能超过 1 MB。' }, { status: 413 });

  let payload: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return Response.json({ error: '请求体不能超过 1 MB。' }, { status: 413 });
    }
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }

  if (!payload || typeof payload !== 'object')
    return Response.json({ error: '请求体必须是对象。' }, { status: 422 });
  const body = payload as {
    articles?: unknown;
    rightsConfirmed?: unknown;
  };
  // 只保留真实数据导入。示例数据模式已移除——它会把无法与真实采集区分的
  // 文章写进同一批表，而这个系统的前提就是每条声明都能追溯到真实来源。
  const mode = 'import' as const;
  const now = new Date();

  if (body.rightsConfirmed !== true)
    return Response.json(
      { error: '导入前必须明确确认已获得这些文章元数据的使用授权。' },
      { status: 422 },
    );
  if (
    !Array.isArray(body.articles) ||
    body.articles.length < 1 ||
    body.articles.length > MAX_ARTICLES
  ) {
    return Response.json(
      { error: `articles 必须包含 1–${MAX_ARTICLES} 条记录。` },
      { status: 422 },
    );
  }
  const issues = body.articles
    .map((article, index) => ({
      index,
      issue: validateArticleInput(article, now),
    }))
    .filter((item) => item.issue);
  if (issues.length) {
    return Response.json(
      {
        error: '文章数据校验失败。',
        issues: issues
          .slice(0, 10)
          .map((item) => ({ row: item.index + 1, message: item.issue })),
      },
      { status: 422 },
    );
  }
  const articles = body.articles as ArticleInput[];

  const topics = runPipeline(articles, now);
  let reservation: IdempotencyReservation | null = null;
  try {
    const started = await beginIdempotentRequest(db, {
      scope: `topics.pipeline:${actor.id}`,
      key: idempotencyKey!,
      request: {
        mode,
        articles: mode === 'import' ? articles : null,
        rightsConfirmed: mode === 'import' ? true : null,
      },
      now,
    });
    if (started.kind === 'conflict')
      return Response.json(
        { error: '该 Idempotency-Key 已用于不同的请求。' },
        { status: 409 },
      );
    if (started.kind === 'pending')
      return Response.json(
        { error: '相同请求正在处理中，请稍后重试。' },
        { status: 425, headers: { 'Retry-After': '2' } },
      );
    if (started.kind === 'replay')
      return Response.json(started.body, {
        status: started.status,
        headers: { 'Idempotency-Replayed': 'true' },
      });
    reservation = started.reservation;
    const runId = createPipelineRunId(now);
    const responseBody = {
      topics,
      source: mode,
      runId,
      runAt: now.toISOString(),
    };
    await persistPipeline(
      db,
      topics,
      mode,
      articles.length,
      now,
      {
        runId,
        additionalStatements: [
          completeIdempotencyStatement(db, reservation, 201, responseBody),
          db
            .prepare(
              `INSERT INTO audit_events
               (id, actor_id, actor_role, action, entity_type, entity_id, after_hash,
                metadata_json, request_id, created_at)
               VALUES (?, ?, ?, 'pipeline.manual_run', 'pipeline_run', ?, ?, ?, ?, ?)`,
            )
            .bind(
              `audit_${crypto.randomUUID()}`,
              actor.id,
              actor.role,
              runId,
              stableHash(responseBody),
              JSON.stringify({
                mode,
                articleCount: articles.length,
                topicCount: topics.length,
                rightsConfirmed: mode === 'import',
                idempotencyKey,
              }),
              crypto.randomUUID(),
              now.toISOString(),
            ),
        ],
      },
    );
    return Response.json(responseBody, {
      status: 201,
      headers: { 'Idempotency-Key': idempotencyKey! },
    });
  } catch {
    if (reservation)
      await abandonIdempotentRequest(db, reservation).catch(() => undefined);
    return Response.json(
      { error: '分析已完成，但数据库写入失败；本次结果未发布到工作台。' },
      { status: 503 },
    );
  }
}
