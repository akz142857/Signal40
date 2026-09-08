import {
  SOURCE_TYPES,
  validateArticleInput,
  type ArticleInput,
  type SourceType,
} from './domain.ts';

const MAX_IMPORT_ARTICLES = 100;

function parseCsvRows(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field.trim());
      field = '';
    } else if (character === '\n') {
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV 中存在未闭合的引号。');
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parseCsv(input: string): unknown[] {
  const rows = parseCsvRows(input.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一行数据。');
  const headers = rows[0].map((header) => header.trim());
  const required = ['source', 'sourceType', 'title', 'url', 'publishedAt'];
  const missing = required.filter((header) => !headers.includes(header));
  if (missing.length) throw new Error(`CSV 缺少表头：${missing.join(', ')}`);

  return rows.slice(1).map((values) => {
    const record = Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? '']),
    );
    const metrics = {
      views: record.views ? Number(record.views) : undefined,
      likes: record.likes ? Number(record.likes) : undefined,
      recommends: record.recommends ? Number(record.recommends) : undefined,
    };
    return {
      source: record.source,
      sourceType: record.sourceType,
      author: record.author || undefined,
      title: record.title,
      summary: record.summary || undefined,
      url: record.url,
      publishedAt: record.publishedAt,
      metrics: Object.values(metrics).some((value) => value !== undefined)
        ? metrics
        : undefined,
    };
  });
}

export function parseArticleImport(
  input: string,
  now = new Date(),
): ArticleInput[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('请粘贴 JSON 或 CSV 数据。');

  let records: unknown[];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error('JSON 格式无效。');
    }
    if (Array.isArray(parsed)) records = parsed;
    else if (
      parsed &&
      typeof parsed === 'object' &&
      'articles' in parsed &&
      Array.isArray((parsed as { articles: unknown }).articles)
    ) {
      records = (parsed as { articles: unknown[] }).articles;
    } else {
      throw new Error('JSON 必须是文章数组，或包含 articles 数组的对象。');
    }
  } else {
    records = parseCsv(trimmed);
  }

  if (!records.length) throw new Error('导入内容中没有文章。');
  if (records.length > MAX_IMPORT_ARTICLES)
    throw new Error(`每次最多导入 ${MAX_IMPORT_ARTICLES} 篇文章。`);
  const issues = records
    .map((record, index) => ({
      row: index + 1,
      issue: validateArticleInput(record, now),
    }))
    .filter((item) => item.issue);
  if (issues.length) {
    throw new Error(
      issues
        .slice(0, 3)
        .map((item) => `第 ${item.row} 条：${item.issue}`)
        .join('；'),
    );
  }
  return records as ArticleInput[];
}

export function isSourceType(value: string): value is SourceType {
  return SOURCE_TYPES.includes(value as SourceType);
}
