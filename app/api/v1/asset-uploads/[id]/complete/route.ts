import { db, resolveRequestActor, storage } from '@/lib/runtime';
import { loadContentProject, pauseAutomationStatement } from '@/lib/control-plane';
import { computeRenderSnapshotHash } from '@/lib/project-v2';
import { stableHash } from '@/lib/workflow';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['producer', 'admin'].includes(actor.role)) return Response.json({ error: '上传未授权。' }, { status: 403 });
  let body: { parts?: Array<{ partNumber: number; etag: string }> };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!Array.isArray(body.parts) || !body.parts.length || body.parts.some((part) => !Number.isInteger(part.partNumber) || part.partNumber < 1 || !part.etag)) return Response.json({ error: 'parts 无效。' }, { status: 422 });
  const { id } = await context.params;
  const session = await db.prepare("SELECT * FROM asset_upload_sessions WHERE id = ? AND status = 'open'").bind(id).first<Record<string, unknown>>();
  if (!session) return Response.json({ error: '上传会话不存在或已关闭。' }, { status: 404 });
  const projectId = String(session.project_id);
  const project = await loadContentProject(db, projectId);
  if (!project || !['SCRIPT_APPROVED', 'CHANGES_REQUESTED'].includes(project.state)) return Response.json({ error: '项目状态已变化，不能完成资产上传。' }, { status: 409 });
  const upload = storage.resumeMultipartUpload(String(session.object_key), String(session.upload_id));
  const object = await upload.complete(body.parts);
  const assetId = `asset_${crypto.randomUUID()}`;
  // 后端不返回校验和时回退到 etag；十六进制换算已收进存储适配器。
  const sha256 = object.sha256 ?? object.etag;
  const asset = {
    id: assetId,
    objectKey: object.key,
    mediaType: String(session.media_type),
    rightsStatus: session.rights_status as 'cleared' | 'restricted' | 'unknown',
    rightsNote: String(session.rights_note),
    sha256,
    usageScope: 'current-project-and-configured-channels',
    provenance: { kind: 'uploaded' as const, source: String(session.created_by), model: null, prompt: null, generatedAt: null },
    retentionUntil: null,
    crop: null,
    derivedFromAssetId: null,
  };
  const nextProject = structuredClone(project.project);
  nextProject.assets = [...nextProject.assets.filter((item) => item.objectKey !== object.key), asset];
  const immutableInputsHash = computeRenderSnapshotHash(nextProject);
  nextProject.render.snapshotHash = immutableInputsHash;
  nextProject.provenance.immutableInputsHash = immutableInputsHash;
  const now = new Date().toISOString();
  try {
    const results = await db.batch([
      db.prepare('UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?').bind(JSON.stringify(nextProject), stableHash(nextProject), project.state === 'CHANGES_REQUESTED' ? 'SCRIPT_APPROVED' : project.state, now, projectId, project.version),
      pauseAutomationStatement(db, projectId, '人工完成了分片资产上传，自动化已暂停，需显式恢复。'),
      db.prepare("INSERT INTO assets (id, project_id, object_key, media_type, asset_role, byte_size, sha256, rights_status, rights_note, usage_scope, provenance_json, created_at) SELECT ?, ?, ?, ?, 'input', ?, ?, ?, ?, 'current-project-and-configured-channels', ?, ? WHERE EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?)").bind(assetId, projectId, object.key, session.media_type, object.size, sha256, session.rights_status, session.rights_note, JSON.stringify({ kind: 'uploaded', source: session.created_by, model: null, prompt: null, generatedAt: null }), now, projectId, project.version + 1, now),
      db.prepare("UPDATE asset_upload_sessions SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'open' AND EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?)").bind(now, id, projectId, project.version + 1, now),
      db.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) SELECT ?, ?, ?, ?, 'asset.multipart_completed', 'asset', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?)").bind(`audit_${crypto.randomUUID()}`, projectId, actor.id, actor.role, assetId, sha256, JSON.stringify({ byteSize: object.size, mediaType: session.media_type, rightsStatus: session.rights_status, trigger: 'human' }), crypto.randomUUID(), now, projectId, project.version + 1, now),
    ]);
    if (!results[0].meta.changes) throw new Error('VERSION_CONFLICT');
  } catch (error) {
    await storage.delete(object.key).catch(() => undefined);
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') return Response.json({ error: '项目已被其他用户修改。' }, { status: 409 });
    throw error;
  }
  return Response.json({ asset }, { status: 201 });
}
