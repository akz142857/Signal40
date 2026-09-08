import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createPgDatabase } from '../lib/sql-pg.ts';

/**
 * 进程内的真 PostgreSQL（PGlite / WASM），按 `drizzle/` 的迁移建库。
 *
 * 用真 PG 而不是手写假库，是为了让方言错误（`json_extract`、`rowid`、
 * 派生表缺别名、CASE WHEN 的布尔类型）在 `node --test` 里就暴露，
 * 而不是等到连上真实数据库才发现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createMemoryPg() {
  const client = new PGlite();
  const files = fs.readdirSync(path.join(repoRoot, 'drizzle')).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(repoRoot, 'drizzle', file), 'utf8').replace(/-->\s*statement-breakpoint/g, ';');
    for (const statement of sql.split(';')) {
      const trimmed = statement.trim();
      if (trimmed) await client.exec(trimmed);
    }
  }
  return Object.assign(createPgDatabase(client), { client });
}
