import { parseRssFeed, type SourceConfigInput } from '../lib/source-adapters.ts';
import { validateArticleInput, type ArticleInput } from '../lib/domain.ts';

/**
 * 从真实公开 RSS 源抓一批文章，走导入接口喂进选题流水线。
 *
 * 只用于本地验证：真实来源的授权状态由你自己判断，
 * 导入接口要求显式确认（`rightsConfirmed`），这里不替你绕过这个确认。
 */

const FEEDS: Array<{ name: string; url: string; sourceType: SourceConfigInput['sourceType'] }> = [
  { name: 'WSJ Markets', url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', sourceType: 'media' },
  { name: 'WSJ US Business', url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml', sourceType: 'media' },
  { name: 'NYT Business', url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', sourceType: 'media' },
  { name: 'Seeking Alpha', url: 'https://seekingalpha.com/market_currents.xml', sourceType: 'market' },
  { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', sourceType: 'media' },
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', sourceType: 'filing' },
];

// 控制面地址：优先 SIGNAL40_API_URL，否则按本机 PORT 推导，
// 免得改一次端口要同步好几个变量。
const apiUrl = (process.env.SIGNAL40_API_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const role = process.env.SIGNAL40_ROLE || 'admin';
const idempotencyKey = process.env.SIGNAL40_IDEMPOTENCY_KEY || `real-feeds-${new Date().toISOString().slice(0, 16)}`;
const perFeed = Number(process.env.SIGNAL40_PER_FEED || 25);

const now = new Date();
const collected: ArticleInput[] = [];
const report: Array<{ source: string; fetched: number; accepted: number; error?: string }> = [];

for (const feed of FEEDS) {
  try {
    const response = await fetch(feed.url, {
      headers: { accept: 'application/rss+xml, application/atom+xml, text/xml;q=0.9, */*;q=0.1', 'user-agent': 'Signal40-Ingestion/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = parseRssFeed(await response.text(), { name: feed.name, sourceType: feed.sourceType });
    const usable = parsed
      .filter((article) => validateArticleInput(article, now) === null)
      .slice(0, perFeed);
    collected.push(...usable);
    report.push({ source: feed.name, fetched: parsed.length, accepted: usable.length });
  } catch (error) {
    report.push({ source: feed.name, fetched: 0, accepted: 0, error: error instanceof Error ? error.message : String(error) });
  }
}

// 导入接口单次上限 100 条。按来源轮流取，避免某一个源把名额占满。
const MAX_ARTICLES = 100;
const bySource = new Map<string, ArticleInput[]>();
for (const article of collected) {
  const list = bySource.get(article.source) ?? [];
  list.push(article);
  bySource.set(article.source, list);
}
const balanced: ArticleInput[] = [];
for (let index = 0; balanced.length < MAX_ARTICLES; index += 1) {
  const round = [...bySource.values()].map((list) => list[index]).filter(Boolean);
  if (!round.length) break;
  balanced.push(...round.slice(0, MAX_ARTICLES - balanced.length));
}

process.stdout.write(`${JSON.stringify({ feeds: report, collected: collected.length, submitted: balanced.length }, null, 2)}\n`);
if (!balanced.length) throw new Error('没有抓到任何可用文章。');

const submit = await fetch(`${apiUrl}/api/topics`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-signal-role': role, 'idempotency-key': idempotencyKey },
  body: JSON.stringify({ mode: 'import', rightsConfirmed: true, articles: balanced }),
});
const text = await submit.text();
process.stdout.write(`导入响应 HTTP ${submit.status}\n${text.slice(0, 1500)}\n`);
