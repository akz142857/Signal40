import assert from 'node:assert/strict';
import pg from 'pg';

/**
 * 比对源库与恢复库：表集合一致、每张表行数一致。
 *
 * PG 没有 SQLite 的 `PRAGMA integrity_check`；等价的信心来自
 * pg_restore 本身会在遇到损坏时报错，加上这里的逐表行数比对。
 */

const sourceUrl = process.argv[2];
const restoredUrl = process.argv[3];
if (!sourceUrl || !restoredUrl) throw new Error('用法：verify-restored-pg.ts <source-url> <restored-url>');

async function inspect(connectionString: string) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const counts: Record<string, number> = {};
    for (const { table_name: name } of tables.rows) {
      const result = await client.query<{ total: string }>(`SELECT COUNT(*) AS total FROM "${name}"`);
      counts[name] = Number(result.rows[0].total);
    }
    return counts;
  } finally {
    await client.end();
  }
}

const source = await inspect(sourceUrl);
const restored = await inspect(restoredUrl);
assert.deepEqual(Object.keys(restored).sort(), Object.keys(source).sort(), '恢复库的表集合与源库不一致');
assert.deepEqual(restored, source, '恢复库的行数与源库不一致');
process.stdout.write(`${JSON.stringify({ status: 'passed', tableCount: Object.keys(source).length, rowCounts: source })}\n`);
