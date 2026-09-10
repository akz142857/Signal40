import { config, db, resolveRequestActor, storage } from '@/lib/runtime';
import { authorizeWorker } from '@/lib/worker-auth';
import { verifyMediaAccess } from '@/lib/media-auth';

export async function GET(request: Request) {
  const worker = await authorizeWorker(request, config.renderWorkerToken);
  const requestUrl = new URL(request.url);
  const objectKey = requestUrl.searchParams.get('objectKey');
  if (!objectKey?.startsWith('projects/') || objectKey.length > 500) return Response.json({ error: '媒体键无效。' }, { status: 422 });
  const expires = Number(requestUrl.searchParams.get('expires'));
  const signature = requestUrl.searchParams.get('signature') ?? '';
  const secret = config.mediaSigningSecret || config.localMediaSigningSecret || '';
  const signed = secret && await verifyMediaAccess(secret, objectKey, expires, signature);
  const actor = worker || signed ? { role: 'producer' } : await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '媒体访问未授权。' }, { status: 401 });
  const asset = await db.prepare('SELECT media_type, sha256 FROM assets WHERE object_key = ? LIMIT 1').bind(objectKey).first<{ media_type: string; sha256: string }>();
  if (!asset) return Response.json({ error: '媒体不存在。' }, { status: 404 });
  const object = await storage.get(objectKey);
  if (!object) return Response.json({ error: '媒体对象不存在。' }, { status: 404 });
  return new Response(object.body, { headers: { 'content-type': asset.media_type, etag: `"${asset.sha256}"`, 'cache-control': 'private, max-age=3600' } });
}
