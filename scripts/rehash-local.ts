import pg from 'pg';
import { computeRenderSnapshotHash, upgradeProjectV2Defaults, type VideoProjectV2 } from '../lib/project-v2.ts';
import { stableHash } from '../lib/workflow.ts';

/**
 * 用当前的哈希算法重算所有项目快照，并把批准哈希已失效的项目退回 CHANGES_REQUESTED。
 *
 * 整批在一个事务里跑：要么全部迁移成功，要么一条都不改——
 * 哈希迁移改的是审批绑定关系，半途而废会留下无法解释的审计断层。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('环境变量 DATABASE_URL 必填。');

type Row = {
  id: string;
  state: string;
  version: number;
  project_json: string;
  immutable_hash: string;
};

const client = new pg.Client({ connectionString });
await client.connect();
const migrated: Array<{ id: string; from: string; to: string; state: string }> = [];
let scanned = 0;

try {
  await client.query('BEGIN');
  const rows = (await client.query<Row>('SELECT id, state, version, project_json, immutable_hash FROM content_projects ORDER BY id FOR UPDATE')).rows;
  scanned = rows.length;

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
    const updated = await client.query(
      'UPDATE content_projects SET project_json = $1, immutable_hash = $2, state = $3, version = version + 1, updated_at = $4 WHERE id = $5 AND version = $6',
      [JSON.stringify(project), nextHash, nextState, now, row.id, row.version],
    );
    if (!updated.rowCount) throw new Error(`项目 ${row.id} 存在版本冲突。`);
    await client.query(
      `INSERT INTO audit_events
         (id, project_id, actor_id, actor_role, action, entity_type, entity_id,
          before_hash, after_hash, metadata_json, request_id, created_at)
       VALUES ($1, $2, 'local-admin', 'admin', 'project.hash_migrated', 'content_project', $3, $4, $5, $6, $7, $8)`,
      [
        `audit_${crypto.randomUUID()}`,
        row.id,
        row.id,
        row.immutable_hash,
        nextHash,
        JSON.stringify({ algorithm: 'sha256', approvalsInvalidated: nextState === 'CHANGES_REQUESTED' }),
        crypto.randomUUID(),
        now,
      ],
    );
    migrated.push({ id: row.id, from: row.immutable_hash, to: nextHash, state: nextState });
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}

process.stdout.write(`${JSON.stringify({ scanned, migrated }, null, 2)}\n`);
