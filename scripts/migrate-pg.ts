import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * 把 `drizzle/` 下的迁移按文件名顺序应用到 `DATABASE_URL`。
 *
 * 已应用的迁移记录在 `schema_migrations` 表里，重复执行是空操作——
 * CI 会连跑两次来验证这一点。每个迁移文件在自己的事务里执行：
 * 要么整个文件生效，要么完全不生效，不会留下应用了一半的 schema。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(repoRoot, 'drizzle');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('环境变量 DATABASE_URL 必填。');

const client = new pg.Client({ connectionString });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      tag text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query<{ tag: string }>('SELECT tag FROM schema_migrations')).rows.map((row) => row.tag),
  );
  const files = (await fs.readdir(migrationsDirectory)).filter((file) => file.endsWith('.sql')).sort();
  const pending = files.filter((file) => !applied.has(file));

  if (!pending.length) {
    process.stdout.write(`没有待应用的迁移（已应用 ${applied.size} 个）。\n`);
  }

  for (const file of pending) {
    const sql = (await fs.readFile(path.join(migrationsDirectory, file), 'utf8')).replace(/-->\s*statement-breakpoint/g, ';');
    await client.query('BEGIN');
    try {
      for (const statement of sql.split(';')) {
        const trimmed = statement.trim();
        if (trimmed) await client.query(trimmed);
      }
      await client.query('INSERT INTO schema_migrations (tag) VALUES ($1)', [file]);
      await client.query('COMMIT');
      process.stdout.write(`已应用 ${file}\n`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`迁移 ${file} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
} finally {
  await client.end();
}
