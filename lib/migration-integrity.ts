import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export type MigrationChecksumEntry = { file: string; sha256: string };

type MigrationChecksumManifest = {
  version: number;
  algorithm: string;
  migrations: MigrationChecksumEntry[];
};

export async function verifyMigrationManifest(migrationsDirectory: string) {
  const manifestPath = path.join(migrationsDirectory, 'checksums.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as MigrationChecksumManifest;
  if (manifest.version !== 1 || manifest.algorithm !== 'sha256' || !Array.isArray(manifest.migrations)) {
    throw new Error('迁移 checksum manifest 格式无效。');
  }
  const files = (await fs.readdir(migrationsDirectory))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const declared = manifest.migrations.map((entry) => entry.file);
  if (new Set(declared).size !== declared.length) throw new Error('迁移 checksum manifest 包含重复文件。');
  if (JSON.stringify(declared) !== JSON.stringify(files)) {
    throw new Error('迁移文件集与 checksum manifest 不一致。');
  }
  for (const entry of manifest.migrations) {
    if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(entry.file) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`迁移 checksum 条目无效：${entry.file}`);
    }
    const content = await fs.readFile(path.join(migrationsDirectory, entry.file));
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== entry.sha256) {
      throw new Error(`已登记迁移发生字节漂移：${entry.file}`);
    }
  }
  return manifest.migrations;
}
