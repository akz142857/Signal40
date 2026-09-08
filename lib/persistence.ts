import type { SqlDatabase, SqlStatement } from './sql.ts';
import type { Article, TopicCandidate, VerificationStatus } from './domain.ts';

type TopicRow = {
  id: string;
  title: string;
  keywords_json: string;
  score: number;
  heat_change: number;
  score_breakdown_json: string;
  source_count: number;
  status: TopicCandidate['status'];
  gate_json: string;
  updated_at: string;
};

type ArticleRow = {
  topic_id: string;
  id: string;
  source: string;
  source_type: Article['sourceType'];
  author: string;
  title: string;
  summary: string;
  url: string;
  published_at: string;
  metrics_json: string;
  content_hash: string;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function createPipelineRunId(now = new Date()) {
  return `run_${now.valueOf().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function valueSlots(rowCount: number, columnCount: number) {
  const row = `(${Array.from({ length: columnCount }, () => '?').join(', ')})`;
  return Array.from({ length: rowCount }, () => row).join(', ');
}

export async function persistArticlesWithRevisions(
  db: SqlDatabase,
  incoming: Article[],
  now = new Date(),
  rawObjectKey: string | null = null,
) {
  const observedAt = now.toISOString();
  const canonical: Article[] = [];
  for (const article of incoming) {
    const existing = await db
      .prepare('SELECT id, content_hash FROM articles WHERE url = ? OR content_hash = ? ORDER BY created_at ASC LIMIT 1')
      .bind(article.url, article.contentHash)
      .first<{ id: string; content_hash: string }>();
    const value = { ...article, id: existing?.id ?? article.id };
    canonical.push(value);
    if (!existing) {
      await db.batch([
        db.prepare(`
          INSERT INTO articles (id, source, source_type, author, title, summary, url, published_at, metrics_json, content_hash, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(value.id, value.source, value.sourceType, value.author, value.title, value.summary, value.url, value.publishedAt, JSON.stringify(value.metrics), value.contentHash, observedAt),
        db.prepare(`
          INSERT INTO article_revisions (id, article_id, revision, content_json, content_hash, raw_object_key, observed_at)
          VALUES (?, ?, 1, ?, ?, ?, ?)
        `).bind(`article_revision_${crypto.randomUUID()}`, value.id, JSON.stringify(value), value.contentHash, rawObjectKey, observedAt),
      ]);
      continue;
    }
    const statements: SqlStatement[] = [
      db.prepare(`
        UPDATE articles SET source = ?, source_type = ?, author = ?, title = ?, summary = ?,
          url = ?, published_at = ?, metrics_json = ?, content_hash = ? WHERE id = ?
      `).bind(value.source, value.sourceType, value.author, value.title, value.summary, value.url, value.publishedAt, JSON.stringify(value.metrics), value.contentHash, value.id),
    ];
    if (existing.content_hash !== value.contentHash) {
      const latest = await db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM article_revisions WHERE article_id = ?').bind(value.id).first<{ revision: number }>();
      statements.push(db.prepare(`
        INSERT INTO article_revisions (id, article_id, revision, content_json, content_hash, raw_object_key, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(`article_revision_${crypto.randomUUID()}`, value.id, Number(latest?.revision ?? 0) + 1, JSON.stringify(value), value.contentHash, rawObjectKey, observedAt));
    }
    await db.batch(statements);
  }
  return canonical;
}

export async function loadRecentArticles(
  db: SqlDatabase,
  since: Date,
  limit = 1_000,
) {
  const result = await db.prepare(`
    SELECT id, source, source_type, author, title, summary, url, published_at, metrics_json, content_hash
    FROM articles WHERE published_at >= ? ORDER BY published_at DESC LIMIT ?
  `).bind(since.toISOString(), limit).all<Omit<ArticleRow, 'topic_id'>>();
  return result.results.map((row) => ({
    id: row.id,
    source: row.source,
    sourceType: row.source_type,
    author: row.author,
    title: row.title,
    summary: row.summary,
    url: row.url,
    publishedAt: row.published_at,
    metrics: parseJson(row.metrics_json, {}),
    contentHash: row.content_hash,
  }));
}

export async function persistPipeline(
  db: SqlDatabase,
  topics: TopicCandidate[],
  // 'sample' 是历史值：示例数据模式已移除，新运行一律是 'import'，
  // 但已存库的旧行仍可能是 'sample'，读取路径必须继续接受它。
  mode: 'sample' | 'import',
  articleCount: number,
  now = new Date(),
  options: {
    runId?: string;
    additionalStatements?: SqlStatement[];
  } = {},
) {
  const id = options.runId ?? createPipelineRunId(now);
  const uniqueArticles = new Map(
    topics
      .flatMap((topic) => topic.articles)
      .map((article) => [article.id, article]),
  );
  const statements: SqlStatement[] = [
    db
      .prepare(
        'INSERT INTO pipeline_runs (id, mode, article_count, topic_count, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(id, mode, articleCount, topics.length, now.toISOString()),
  ];

  for (const articleChunk of chunks([...uniqueArticles.values()], 9)) {
    statements.push(
      db
        .prepare(`
      INSERT INTO articles (id, source, source_type, author, title, summary, url, published_at, metrics_json, content_hash, created_at)
      VALUES ${valueSlots(articleChunk.length, 11)}
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source, source_type = excluded.source_type, author = excluded.author,
        title = excluded.title, summary = excluded.summary, url = excluded.url,
        published_at = excluded.published_at, metrics_json = excluded.metrics_json,
        content_hash = excluded.content_hash
    `)
        .bind(
          ...articleChunk.flatMap((article) => [
            article.id,
            article.source,
            article.sourceType,
            article.author,
            article.title,
            article.summary,
            article.url,
            article.publishedAt,
            JSON.stringify(article.metrics),
            article.contentHash,
            now.toISOString(),
          ]),
        ),
    );
  }

  for (const topicChunk of chunks(topics, 9)) {
    statements.push(
      db
        .prepare(`
      INSERT INTO topics (id, title, keywords_json, run_id, score, heat_change, score_breakdown_json, source_count, status, gate_json, updated_at)
      VALUES ${valueSlots(topicChunk.length, 11)}
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title, keywords_json = excluded.keywords_json, run_id = excluded.run_id,
        score = excluded.score, heat_change = excluded.heat_change, score_breakdown_json = excluded.score_breakdown_json,
        source_count = excluded.source_count, status = excluded.status, gate_json = excluded.gate_json,
        updated_at = excluded.updated_at
    `)
        .bind(
          ...topicChunk.flatMap((topic) => [
            topic.id,
            topic.title,
            JSON.stringify(topic.keywords),
            id,
            topic.score,
            topic.heatChange,
            JSON.stringify(topic.scoreBreakdown),
            topic.sourceCount,
            topic.status,
            JSON.stringify(topic.gate),
            topic.updatedAt,
          ]),
        ),
    );
  }

  if (topics.length) {
    statements.push(
      db
        .prepare(
          `DELETE FROM topic_articles WHERE topic_id IN (${topics.map(() => '?').join(', ')})`,
        )
        .bind(...topics.map((topic) => topic.id)),
    );
  }
  const links = topics.flatMap((topic) =>
    topic.articles.map((article) => [topic.id, article.id] as const),
  );
  for (const linkChunk of chunks(links, 50)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO topic_articles (topic_id, article_id) VALUES ${valueSlots(linkChunk.length, 2)} ON CONFLICT DO NOTHING`,
        )
        .bind(...linkChunk.flat()),
    );
  }
  for (const topicChunk of chunks(topics, 20)) {
    statements.push(
      db
        .prepare(
          `INSERT INTO verification_events (id, topic_id, status, note, created_at) VALUES ${valueSlots(topicChunk.length, 5)}`,
        )
        .bind(
          ...topicChunk.flatMap((topic) => [
            `verify_${crypto.randomUUID()}`,
            topic.id,
            'unreviewed',
            '',
            now.toISOString(),
          ]),
        ),
    );
  }

  statements.push(...(options.additionalStatements ?? []));

  await db.batch(statements);
  return id;
}

async function hydrateTopics(
  db: SqlDatabase,
  rows: TopicRow[],
): Promise<TopicCandidate[]> {
  if (!rows.length) return [];
  const placeholders = rows.map(() => '?').join(', ');
  const ids = rows.map((row) => row.id);
  const articleResult = await db
    .prepare(`
    SELECT ta.topic_id, a.id, a.source, a.source_type, a.author, a.title, a.summary, a.url,
           a.published_at, a.metrics_json, a.content_hash
    FROM topic_articles ta
    JOIN articles a ON a.id = ta.article_id
    WHERE ta.topic_id IN (${placeholders})
    ORDER BY a.published_at DESC
  `)
    .bind(...ids)
    .all<ArticleRow>();
  const verificationResult = await db
    .prepare(`
    SELECT topic_id, status, note FROM (
      SELECT topic_id, status, note,
             ROW_NUMBER() OVER (PARTITION BY topic_id ORDER BY created_at DESC, seq DESC) AS rn
      FROM verification_events
      WHERE topic_id IN (${placeholders})
    ) AS latest WHERE rn = 1
  `)
    .bind(...ids)
    .all<{ topic_id: string; status: VerificationStatus; note: string }>();

  const articlesByTopic = new Map<string, Article[]>();
  for (const row of articleResult.results) {
    const articles = articlesByTopic.get(row.topic_id) ?? [];
    articles.push({
      id: row.id,
      source: row.source,
      sourceType: row.source_type,
      author: row.author,
      title: row.title,
      summary: row.summary,
      url: row.url,
      publishedAt: row.published_at,
      metrics: parseJson(row.metrics_json, {}),
      contentHash: row.content_hash,
    });
    articlesByTopic.set(row.topic_id, articles);
  }
  const verificationByTopic = new Map<
    string,
    { status: VerificationStatus; note: string }
  >();
  for (const row of verificationResult.results)
    verificationByTopic.set(row.topic_id, {
      status: row.status,
      note: row.note,
    });

  return rows.map((row) => {
    const verification = verificationByTopic.get(row.id) ?? {
      status: 'unreviewed' as const,
      note: '',
    };
    return {
      id: row.id,
      title: row.title,
      keywords: parseJson(row.keywords_json, []),
      score: row.score,
      heatChange: row.heat_change,
      scoreBreakdown: parseJson(row.score_breakdown_json, {
        resonance: 0,
        velocity: 0,
        numericImpact: 0,
        sourceQuality: 0,
        freshness: 0,
        explainability: 0,
      }),
      sourceCount: row.source_count,
      sources: [
        ...new Set(
          (articlesByTopic.get(row.id) ?? []).map((article) => article.source),
        ),
      ],
      status: row.status,
      gate: parseJson(row.gate_json, {
        passed: false,
        hasPrimarySource: false,
        independentSourceCount: 0,
        reason: '证据状态无法读取',
      }),
      verificationStatus: verification.status,
      verificationNote: verification.note,
      articles: articlesByTopic.get(row.id) ?? [],
      updatedAt: row.updated_at,
    };
  });
}

export async function loadLatestTopics(db: SqlDatabase) {
  const latestRun = await db
    .prepare(
      'SELECT id, mode, created_at FROM pipeline_runs ORDER BY created_at DESC LIMIT 1',
    )
    .first<{ id: string; mode: 'sample' | 'import'; created_at: string }>();
  if (!latestRun) return { topics: [], run: null };
  const result = await db
    .prepare(`
    SELECT id, title, keywords_json, score, heat_change, score_breakdown_json, source_count, status, gate_json, updated_at
    FROM topics
    WHERE run_id = ?
    ORDER BY score DESC, source_count DESC
  `)
    .bind(latestRun.id)
    .all<TopicRow>();
  return { topics: await hydrateTopics(db, result.results), run: latestRun };
}

export async function loadTopic(db: SqlDatabase, id: string) {
  const row = await db
    .prepare(`
    SELECT id, title, keywords_json, score, heat_change, score_breakdown_json, source_count, status, gate_json, updated_at
    FROM topics WHERE id = ? LIMIT 1
  `)
    .bind(id)
    .first<TopicRow>();
  if (!row) return null;
  return (await hydrateTopics(db, [row]))[0] ?? null;
}

export async function recordVerification(
  db: SqlDatabase,
  topicId: string,
  status: VerificationStatus,
  note: string,
  now = new Date(),
  options: {
    additionalStatements?: (
      topic: TopicCandidate,
    ) => SqlStatement[];
  } = {},
) {
  const topic = await loadTopic(db, topicId);
  if (!topic) return { error: '选题不存在。', status: 404 as const };
  if (status === 'verified' && !topic.gate.passed)
    return {
      error: '自动证据门禁未通过，不能批准进入生产。',
      status: 409 as const,
    };
  const updated = {
    ...topic,
    verificationStatus: status,
    verificationNote: note,
  };
  await db.batch([
    db
      .prepare(
        'INSERT INTO verification_events (id, topic_id, status, note, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind(
        `verify_${crypto.randomUUID()}`,
        topicId,
        status,
        note,
        now.toISOString(),
      ),
    ...(options.additionalStatements?.(updated) ?? []),
  ]);
  return {
    topic: updated,
    status: 200 as const,
  };
}
