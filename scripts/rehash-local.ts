import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { computeRenderSnapshotHash, upgradeProjectV2Defaults, type VideoProjectV2 } from '../lib/project-v2.ts';
import { stableHash } from '../lib/workflow.ts';

const inputPath = process.argv[2];
if (!inputPath) throw new Error('用法：node --experimental-strip-types scripts/rehash-local.ts <local-d1.sqlite>');
const databasePath = path.resolve(inputPath);
if (!databasePath.includes(`${path.sep}.wrangler${path.sep}state${path.sep}`) || !databasePath.endsWith('.sqlite')) {
  throw new Error('只允许迁移当前项目 .wrangler/state 下的本地 SQLite 数据库。');
}

const database = new DatabaseSync(databasePath);
const rows = database.prepare('SELECT id, state, version, project_json, immutable_hash FROM content_projects ORDER BY id').all() as Array<{
  id: string;
  state: string;
  version: number;
  project_json: string;
  immutable_hash: string;
}>;
const update = database.prepare('UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?');
const audit = database.prepare(`
  INSERT INTO audit_events
    (id, project_id, actor_id, actor_role, action, entity_type, entity_id,
     before_hash, after_hash, metadata_json, request_id, created_at)
  VALUES (?, ?, 'local-admin', 'admin', 'project.hash_migrated',
          'content_project', ?, ?, ?, ?, ?, ?)
`);
const migrated: Array<{ id: string; from: string; to: string; state: string }> = [];

database.exec('BEGIN IMMEDIATE');
try {
  for (const row of rows) {
    const project = upgradeProjectV2Defaults(JSON.parse(row.project_json) as VideoProjectV2);
    project.audio.music ??= null;
    project.audio.mix ??= { voiceVolume: 1, targetLufs: -16, duckMusicUnderVoice: true };
    const researchCore = { claims: project.research.claims, conflicts: project.research.conflicts };
    project.research.approvedHash = stableHash(researchCore);
    const snapshotHash = computeRenderSnapshotHash(project);
    project.render.snapshotHash = snapshotHash;
    project.provenance.immutableInputsHash = snapshotHash;
    const nextHash = stableHash(project);
    if (row.immutable_hash === nextHash && nextHash.startsWith('sha256:')) continue;
    const nextState = ['DRAFT', 'RESEARCHING', 'REJECTED', 'FAILED', 'CANCELLED', 'CHANGES_REQUESTED'].includes(row.state) ? row.state : 'CHANGES_REQUESTED';
    const now = new Date().toISOString();
    const result = update.run(JSON.stringify(project), nextHash, nextState, now, row.id, row.version);
    if (!result.changes) throw new Error(`项目 ${row.id} 存在版本冲突。`);
    audit.run(
      `audit_${crypto.randomUUID()}`,
      row.id,
      row.id,
      row.immutable_hash,
      nextHash,
      JSON.stringify({ algorithm: 'sha256', approvalsInvalidated: nextState === 'CHANGES_REQUESTED', localMigration: true }),
      crypto.randomUUID(),
      now,
    );
    migrated.push({ id: row.id, from: row.immutable_hash, to: nextHash, state: nextState });
  }
  database.exec('COMMIT');
} catch (error) {
  database.exec('ROLLBACK');
  throw error;
} finally {
  database.close();
}

process.stdout.write(`${JSON.stringify({ scanned: rows.length, migrated }, null, 2)}\n`);
