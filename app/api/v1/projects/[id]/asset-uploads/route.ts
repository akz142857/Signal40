import { db, resolveRequestActor, storage } from '@/lib/runtime';
import { loadContentProject } from '@/lib/control-plane';

const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'video/mp4', 'font/woff2']);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['producer', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权创建资产上传。' }, { status: 403 });
  let body: { filename?: string; mediaType?: string; rightsStatus?: string; rightsNote?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const filename = body.filename?.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  if (!filename || !body.mediaType || !allowedTypes.has(body.mediaType) || !['cleared', 'restricted', 'unknown'].includes(body.rightsStatus ?? '')) return Response.json({ error: '文件名、媒体类型或版权状态无效。' }, { status: 422 });
  const { id: projectId } = await context.params;
  const project = await loadContentProject(db, projectId);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (!['SCRIPT_APPROVED', 'CHANGES_REQUESTED'].includes(project.state)) return Response.json({ error: '只有脚本批准后才能上传生产资产。' }, { status: 409 });
  const sessionId = `upload_${crypto.randomUUID()}`;
  const objectKey = `projects/${projectId}/inputs/${sessionId}/${filename}`;
  const upload = await storage.createMultipartUpload(objectKey, { contentType: body.mediaType, customMetadata: { projectId, sessionId } });
  const now = new Date();
  const expiresAt = new Date(now.valueOf() + 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("INSERT INTO asset_upload_sessions (id, project_id, upload_id, object_key, filename, media_type, rights_status, rights_note, status, expires_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)").bind(sessionId, projectId, upload.uploadId, objectKey, filename, body.mediaType, body.rightsStatus, body.rightsNote?.slice(0, 1000) ?? '', expiresAt, actor.id, now.toISOString(), now.toISOString()).run();
  return Response.json({ upload: { id: sessionId, uploadId: upload.uploadId, objectKey, partSize: 10 * 1024 * 1024, expiresAt } }, { status: 201 });
}
