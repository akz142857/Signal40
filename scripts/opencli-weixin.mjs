#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const query = process.argv[2];
if (!query) {
  console.error('Usage: npm run ingest:weixin -- "关键词" [limit]');
  process.exit(2);
}
const limit = Math.max(1, Math.min(100, Number(process.argv[3] ?? 20)));
const result = spawnSync('opencli', ['weixin', 'search', query, '--page', '1', '--limit', String(limit), '--format', 'json'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
if (result.error?.code === 'ENOENT') {
  console.error('未找到 opencli。请先安装并运行 opencli doctor。');
  process.exit(127);
}
if (result.status !== 0) {
  console.error(result.stderr.trim() || `opencli 退出码：${result.status}`);
  process.exit(result.status ?? 1);
}

let parsed;
try { parsed = JSON.parse(result.stdout); } catch {
  console.error('OpenCLI 没有返回 JSON；请确认当前版本支持 --format json。');
  process.exit(1);
}
const rows = Array.isArray(parsed) ? parsed : parsed.data ?? parsed.results ?? [];
if (!Array.isArray(rows)) {
  console.error('无法识别 OpenCLI JSON 输出结构。');
  process.exit(1);
}

function publishedAt(value) {
  if (!value) return new Date().toISOString();
  const minute = String(value).match(/(\d+)分钟前/);
  const hour = String(value).match(/(\d+)小时前/);
  if (minute) return new Date(Date.now() - Number(minute[1]) * 60_000).toISOString();
  if (hour) return new Date(Date.now() - Number(hour[1]) * 3_600_000).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date().toISOString() : date.toISOString();
}

const articles = rows.map((row) => ({
  source: row.author || row.account || '微信搜索', sourceType: 'social', author: row.author || row.account || '',
  title: String(row.title || '').trim(), summary: String(row.summary || '').trim(),
  url: String(row.url || '').trim(), publishedAt: publishedAt(row.publish_time),
})).filter((article) => article.title && article.url);

const endpoint = process.env.SIGNAL40_API_URL;
if (!endpoint) {
  process.stdout.write(`${JSON.stringify({ articles }, null, 2)}\n`);
  process.exit(0);
}
const response = await fetch(new URL('/api/topics', endpoint), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ articles }),
});
const body = await response.text();
if (!response.ok) {
  console.error(body);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
