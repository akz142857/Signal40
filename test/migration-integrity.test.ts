import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyMigrationManifest } from '../lib/migration-integrity.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDirectory = path.join(repoRoot, 'drizzle');

void test('migration checksum manifest covers every PostgreSQL migration in order', async () => {
  const entries = await verifyMigrationManifest(migrationsDirectory);
  assert.equal(entries.length, 30);
  assert.equal(entries[0]?.file, '0000_baseline_postgres.sql');
  assert.equal(entries.at(-1)?.file, '0029_source_legal_operator.sql');
});

void test('migration verification fails closed on changed or unregistered SQL', async () => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'signal40-migrations-'));
  const copy = path.join(temporaryRoot, 'drizzle');
  try {
    await fs.cp(migrationsDirectory, copy, { recursive: true });
    await fs.appendFile(path.join(copy, '0001_automation_and_workers.sql'), '\n-- tampered\n');
    await assert.rejects(verifyMigrationManifest(copy), /0001_automation_and_workers\.sql/);

    await fs.rm(copy, { recursive: true, force: true });
    await fs.cp(migrationsDirectory, copy, { recursive: true });
    await fs.writeFile(path.join(copy, '9999_unregistered.sql'), 'SELECT 1;\n');
    await assert.rejects(verifyMigrationManifest(copy), /checksum manifest 不一致/);
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});

void test('migration runner persists and verifies database-side checksums', async () => {
  const runner = await fs.readFile(path.join(repoRoot, 'scripts/migrate-pg.ts'), 'utf8');
  assert.match(runner, /SELECT tag, checksum FROM schema_migrations/);
  assert.match(runner, /row\.checksum !== expected/);
  assert.match(runner, /INSERT INTO schema_migrations \(tag, checksum\)/);
});
