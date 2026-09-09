import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyMigrationManifest } from '../lib/migration-integrity.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entries = await verifyMigrationManifest(path.join(repoRoot, 'drizzle'));
process.stdout.write(`迁移 checksum 验证通过（${entries.length} 个文件）。\n`);
