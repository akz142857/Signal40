import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

const sourcePath = process.argv[2];
const restoredPath = process.argv[3];
if (!sourcePath || !restoredPath) throw new Error('用法：verify-restored-d1.ts <source.sqlite> <restored.sqlite>');

function inspect(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    const counts = Object.fromEntries(tables.map(({ name }) => [name, Number((database.prepare(`SELECT COUNT(*) AS total FROM "${name}"`).get() as { total: number }).total)]));
    return { integrity: integrity.integrity_check, counts };
  } finally { database.close(); }
}

const source = inspect(sourcePath);
const restored = inspect(restoredPath);
assert.equal(source.integrity, 'ok');
assert.equal(restored.integrity, 'ok');
assert.deepEqual(restored.counts, source.counts);
process.stdout.write(`${JSON.stringify({ status: 'passed', tableCount: Object.keys(source.counts).length, rowCounts: source.counts })}\n`);
