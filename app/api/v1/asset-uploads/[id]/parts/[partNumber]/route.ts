import { db, resolveRequestActor, storage } from '@/lib/runtime';

export async function PUT(request: Request, context: { params: Promise<{ id: string; partNumber: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['producer', 'admin'].includes(actor.role)) return Response.json({ error: '上传未授权。' }, { status: 403 });
  const { id, partNumber: rawPartNumber } = await context.params;
  const partNumber = Number(rawPartNumber);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) return Response.json({ error: 'partNumber 无效。' }, { status: 422 });
  const session = await db.prepare("SELECT upload_id, object_key, expires_at FROM asset_upload_sessions WHERE id = ? AND status = 'open'").bind(id).first<{ upload_id: string; object_key: string; expires_at: string }>();
  if (!session) return Response.json({ error: '上传会话不存在或已关闭。' }, { status: 404 });
  if (new Date(session.expires_at).valueOf() <= Date.now()) return Response.json({ error: '上传会话已过期。' }, { status: 410 });
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > 100 * 1024 * 1024) return Response.json({ error: '单个分片必须为 1 字节到 100 MB。' }, { status: 413 });
  const part = await storage.resumeMultipartUpload(session.object_key, session.upload_id).uploadPart(partNumber, data);
  return Response.json({ part });
}
