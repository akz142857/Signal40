import type { TopicCandidate } from './domain';

export async function persistTopics(db: D1Database, topics: TopicCandidate[], now = new Date()) {
  const articleStatements = topics.flatMap((topic) => topic.articles.map((article) => db.prepare(`
    INSERT INTO articles (id, source, source_type, author, title, summary, url, published_at, metrics_json, content_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO UPDATE SET
      source = excluded.source, source_type = excluded.source_type, author = excluded.author,
      title = excluded.title, summary = excluded.summary, url = excluded.url,
      published_at = excluded.published_at, metrics_json = excluded.metrics_json
  `).bind(
    article.id, article.source, article.sourceType, article.author, article.title, article.summary,
    article.url, article.publishedAt, JSON.stringify(article.metrics), article.contentHash, now.toISOString(),
  )));

  const topicStatements = topics.map((topic) => db.prepare(`
    INSERT INTO topics (id, title, keywords_json, score, heat_change, score_breakdown_json, source_count, status, gate_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title, keywords_json = excluded.keywords_json, score = excluded.score,
      heat_change = excluded.heat_change, score_breakdown_json = excluded.score_breakdown_json,
      source_count = excluded.source_count, status = excluded.status, gate_json = excluded.gate_json,
      updated_at = excluded.updated_at
  `).bind(
    topic.id, topic.title, JSON.stringify(topic.keywords), topic.score, topic.heatChange,
    JSON.stringify(topic.scoreBreakdown), topic.sourceCount, topic.status, JSON.stringify(topic.gate), topic.updatedAt,
  ));

  const clearLinks = topics.map((topic) => db.prepare('DELETE FROM topic_articles WHERE topic_id = ?').bind(topic.id));
  const linkStatements = topics.flatMap((topic) => topic.articles.map((article) =>
    db.prepare('INSERT OR IGNORE INTO topic_articles (topic_id, article_id) VALUES (?, ?)').bind(topic.id, article.id),
  ));

  if (articleStatements.length) await db.batch(articleStatements);
  if (topicStatements.length) await db.batch(topicStatements);
  if (clearLinks.length) await db.batch(clearLinks);
  if (linkStatements.length) await db.batch(linkStatements);
}
