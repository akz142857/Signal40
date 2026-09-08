import { db, resolveRequestActor, storage } from '@/lib/runtime';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['producer', 'admin'].includes(actor.role)) return Response.json({ error: '上传未授权。' }, { status: 403 });
  const { id } = await context.params;
  const session = await db.prepare("SELECT upload_id, object_key FROM asset_upload_sessions WHERE id = ? AND status = 'open'").bind(id).first<{ upload_id: string; object_key: string }>();
  if (!session) return Response.json({ error: '上传会话不存在或已关闭。' }, { status: 404 });
  await storage.resumeMultipartUpload(session.object_key, session.upload_id).abort();
  await db.prepare("UPDATE asset_upload_sessions SET status = 'aborted', updated_at = ? WHERE id = ?").bind(new Date().toISOString(), id).run();
  return Response.json({ id, status: 'aborted' });
}
