import { env } from 'cloudflare:workers';
import { loadContentProject } from '@/lib/control-plane';
import { computeRenderSnapshotHash } from '@/lib/project-v2';
import { authorizeWorker } from '@/lib/worker-auth';
import { resolveActor, stableHash, type Actor } from '@/lib/workflow';

const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'video/mp4', 'font/woff2']);

function decodeHeader(value: string | null) {
  if (!value) return '';
  try { return decodeURIComponent(value); }
  catch { return value; }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let actor: Actor | null;
  if (await authorizeWorker(request, env.WORKER_TOKEN)) {
    actor = { id: 'media-worker', email: 'worker@signal40.internal', role: 'producer' };
  } else {
    actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  }
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  if (!['producer', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权上传生产资产。' }, { status: 403 });
  const contentType = request.headers.get('content-type')?.split(';')[0] || '';
  const filename = decodeHeader(request.headers.get('x-filename')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  const rightsStatus = request.headers.get('x-rights-status');
  const assetRole = request.headers.get('x-asset-role') || 'input';
  const audioPurpose = request.headers.get('x-audio-purpose');
  const requestedMusicVolume = Number(request.headers.get('x-music-volume') ?? 0.12);
  const rightsNote = decodeHeader(request.headers.get('x-rights-note')).slice(0, 1000);
  if (!filename || !allowedTypes.has(contentType)) return Response.json({ error: '文件名缺失或媒体类型不受支持。' }, { status: 422 });
  if (!['cleared', 'restricted', 'unknown'].includes(rightsStatus || '')) return Response.json({ error: 'x-rights-status 无效。' }, { status: 422 });
  if (!['input', 'voice-output', 'preview-output', 'render-output'].includes(assetRole)) return Response.json({ error: 'x-asset-role 无效。' }, { status: 422 });
  if (audioPurpose && audioPurpose !== 'music') return Response.json({ error: 'x-audio-purpose 仅支持 music。' }, { status: 422 });
  if (audioPurpose === 'music' && (assetRole !== 'input' || !contentType.startsWith('audio/'))) return Response.json({ error: '背景音乐必须作为音频输入资产上传。' }, { status: 422 });
  if (audioPurpose === 'music' && (!Number.isFinite(requestedMusicVolume) || requestedMusicVolume < 0 || requestedMusicVolume > 0.5)) return Response.json({ error: 'x-music-volume 必须在 0–0.5 之间。' }, { status: 422 });
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > 50 * 1024 * 1024) return Response.json({ error: '文件必须为 1 字节到 50 MB。' }, { status: 413 });
  const { id: projectId } = await context.params;
  const project = await loadContentProject(env.DB, projectId);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (assetRole === 'input' && !['SCRIPT_APPROVED', 'CHANGES_REQUESTED'].includes(project.state)) return Response.json({ error: `输入资产不能在 ${project.state} 状态上传。` }, { status: 409 });
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((value) => value.toString(16).padStart(2, '0')).join('');
  const assetId = `asset_${crypto.randomUUID()}`;
  const objectKey = `projects/${projectId}/assets/${assetId}/${filename}`;
  const now = new Date().toISOString();
  try {
    await env.MEDIA.put(objectKey, data, { httpMetadata: { contentType }, customMetadata: { projectId, assetId, sha256: digest } });
    const statements: D1PreparedStatement[] = [];
    if (assetRole === 'input') {
      const asset = {
        id: assetId,
        objectKey,
        mediaType: contentType,
        rightsStatus: rightsStatus as 'cleared' | 'restricted' | 'unknown',
        rightsNote,
        sha256: digest,
        usageScope: 'current-project-and-configured-channels',
        provenance: { kind: 'uploaded' as const, source: actor.id, model: null, prompt: null, generatedAt: null },
        retentionUntil: null,
        crop: null,
        derivedFromAssetId: null,
      };
      const nextProject = structuredClone(project.project);
      nextProject.assets = [...nextProject.assets.filter((item) => item.objectKey !== objectKey), asset];
      if (audioPurpose === 'music') {
        nextProject.audio.music = { assetId, objectKey, volume: requestedMusicVolume, loop: true };
        nextProject.audio.mix ??= { voiceVolume: 1, targetLufs: -16, duckMusicUnderVoice: true };
      }
      const immutableInputsHash = computeRenderSnapshotHash(nextProject);
      nextProject.render.snapshotHash = immutableInputsHash;
      nextProject.provenance.immutableInputsHash = immutableInputsHash;
      statements.push(env.DB.prepare('UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?').bind(JSON.stringify(nextProject), stableHash(nextProject), project.state === 'CHANGES_REQUESTED' ? 'SCRIPT_APPROVED' : project.state, now, projectId, project.version));
    }
    statements.push(
      assetRole === 'input' ? env.DB.prepare(`
        INSERT INTO assets (id, project_id, object_key, media_type, asset_role, byte_size, sha256, rights_status, rights_note, usage_scope, provenance_json, retention_until, crop_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?
        )
      `).bind(assetId, projectId, objectKey, contentType, assetRole, data.byteLength, digest, rightsStatus, rightsNote, 'current-project-and-configured-channels', JSON.stringify({ kind: assetRole === 'input' ? 'uploaded' : 'generated', source: actor.id, model: null, prompt: null, generatedAt: assetRole === 'input' ? null : now }), null, null, now, projectId, project.version + 1, now) : env.DB.prepare(`
        INSERT INTO assets (id, project_id, object_key, media_type, asset_role, byte_size, sha256, rights_status, rights_note, usage_scope, provenance_json, retention_until, crop_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(assetId, projectId, objectKey, contentType, assetRole, data.byteLength, digest, rightsStatus, rightsNote, 'current-project-and-configured-channels', JSON.stringify({ kind: 'generated', source: actor.id, model: null, prompt: null, generatedAt: now }), null, null, now),
      assetRole === 'input' ? env.DB.prepare(`
        INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
        SELECT ?, ?, ?, ?, 'asset.uploaded', 'asset', ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM content_projects WHERE id = ? AND version = ? AND updated_at = ?
        )
      `).bind(`audit_${crypto.randomUUID()}`, projectId, actor.id, actor.role, assetId, stableHash({ objectKey, digest }), JSON.stringify({ contentType, assetRole, audioPurpose, byteSize: data.byteLength, rightsStatus }), crypto.randomUUID(), now, projectId, project.version + 1, now) : env.DB.prepare(`
        INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
        VALUES (?, ?, ?, ?, 'asset.uploaded', 'asset', ?, ?, ?, ?, ?)
      `).bind(`audit_${crypto.randomUUID()}`, projectId, actor.id, actor.role, assetId, stableHash({ objectKey, digest }), JSON.stringify({ contentType, assetRole, audioPurpose, byteSize: data.byteLength, rightsStatus }), crypto.randomUUID(), now),
    );
    const results = await env.DB.batch(statements);
    if (assetRole === 'input' && !results[0].meta.changes) throw new Error('VERSION_CONFLICT');
    return Response.json({ asset: { id: assetId, objectKey, mediaType: contentType, assetRole, byteSize: data.byteLength, sha256: digest, rightsStatus } }, { status: 201 });
  } catch (error) {
    await env.MEDIA.delete(objectKey).catch(() => undefined);
    if (error instanceof Error && error.message === 'VERSION_CONFLICT') return Response.json({ error: '项目已被其他用户修改。' }, { status: 409 });
    return Response.json({ error: '资产保存失败。' }, { status: 503 });
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await env.DB.prepare('SELECT id, object_key, media_type, asset_role, byte_size, sha256, rights_status, rights_note, usage_scope, provenance_json, retention_until, crop_json, derived_from_id, created_at FROM assets WHERE project_id = ? ORDER BY created_at DESC').bind(id).all();
  return Response.json({ assets: result.results });
}
