import { env } from 'cloudflare:workers';
import { isArticleInput, runPipeline, type ArticleInput } from '@/lib/domain';
import { persistTopics } from '@/lib/persistence';
import { sampleArticles } from '@/lib/sample-data';

export async function GET() {
  const now = new Date();
  return Response.json({ topics: runPipeline(sampleArticles(now), now), source: 'sample' });
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }

  const candidate = payload as { articles?: unknown };
  const inputs = candidate.articles ?? [];
  if (!Array.isArray(inputs) || inputs.length > 500 || !inputs.every(isArticleInput)) {
    return Response.json({ error: 'articles 必须是最多 500 条合法文章记录。' }, { status: 422 });
  }

  const now = new Date();
  const articles = (inputs.length ? inputs : sampleArticles(now)) as ArticleInput[];
  const topics = runPipeline(articles, now);
  let persisted = false;
  let storageMessage = 'D1 未绑定，本次结果未持久化。';

  try {
    const db = env.DB as D1Database | undefined;
    if (db) {
      await persistTopics(db, topics, now);
      persisted = true;
      storageMessage = '候选与证据已写入 D1。';
    }
  } catch (error) {
    storageMessage = error instanceof Error ? `管道完成，但持久化失败：${error.message}` : '管道完成，但持久化失败。';
  }

  return Response.json({ topics, persisted, storageMessage });
}
