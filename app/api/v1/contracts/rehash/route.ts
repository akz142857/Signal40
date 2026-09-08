import { db, resolveRequestActor } from '@/lib/runtime';
import { computeRenderSnapshotHash, upgradeProjectV2Defaults, type VideoProjectV2 } from '@/lib/project-v2';
import { stableHash } from '@/lib/workflow';

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return Response.json({ error: '只有管理员可以迁移快照哈希。' }, { status: 403 });
  const rows = await db.prepare('SELECT id, state, version, project_json, immutable_hash FROM content_projects ORDER BY id LIMIT 500').all<{ id: string; state: string; version: number; project_json: string; immutable_hash: string }>();
  const migrated: Array<{ id: string; from: string; to: string; state: string }> = [];
  for (const row of rows.results) {
    const project = upgradeProjectV2Defaults(JSON.parse(row.project_json) as VideoProjectV2);
    project.audio.music ??= null;
    project.audio.mix ??= { voiceVolume: 1, targetLufs: -16, duckMusicUnderVoice: true };
    const researchCore = { claims: project.research.claims, conflicts: project.research.conflicts };
    project.research.approvedHash = stableHash(researchCore);
    const snapshotHash = computeRenderSnapshotHash(project);
    project.render.snapshotHash = snapshotHash;
    project.provenance.immutableInputsHash = snapshotHash;
    const nextHash = stableHash(project);
    if (row.immutable_hash === nextHash && row.immutable_hash.startsWith('sha256:')) continue;
    const nextState = ['DRAFT', 'RESEARCHING', 'REJECTED', 'FAILED', 'CANCELLED', 'CHANGES_REQUESTED'].includes(row.state) ? row.state : 'CHANGES_REQUESTED';
    const now = new Date().toISOString();
    const results = await db.batch([
      db.prepare('UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?').bind(JSON.stringify(project), nextHash, nextState, now, row.id, row.version),
      db.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, before_hash, after_hash, metadata_json, request_id, created_at) SELECT ?, ?, ?, ?, 'project.hash_migrated', 'content_project', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?)").bind(`audit_${crypto.randomUUID()}`, row.id, actor.id, actor.role, row.id, row.immutable_hash, nextHash, JSON.stringify({ algorithm: 'sha256', approvalsInvalidated: nextState === 'CHANGES_REQUESTED' }), crypto.randomUUID(), now, row.id, row.version + 1, now),
    ]);
    if (results[0].meta.changes) migrated.push({ id: row.id, from: row.immutable_hash, to: nextHash, state: nextState });
  }
  return Response.json({ scanned: rows.results.length, migrated });
}
