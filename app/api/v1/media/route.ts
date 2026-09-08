import { env } from 'cloudflare:workers';
import { authorizeWorker } from '@/lib/worker-auth';
import { verifyMediaAccess } from '@/lib/media-auth';
import { resolveActor } from '@/lib/workflow';

export async function GET(request: Request) {
  const worker = await authorizeWorker(request, env.WORKER_TOKEN);
  const requestUrl = new URL(request.url);
  const objectKey = requestUrl.searchParams.get('objectKey');
  if (!objectKey?.startsWith('projects/') || objectKey.length > 500) return Response.json({ error: '媒体键无效。' }, { status: 422 });
  const expires = Number(requestUrl.searchParams.get('expires'));
  const signature = requestUrl.searchParams.get('signature') ?? '';
  const secret = env.MEDIA_SIGNING_SECRET || (requestUrl.hostname === 'localhost' || requestUrl.hostname === '127.0.0.1' ? 'signal40-local-media-signing-key' : '');
  const signed = secret && await verifyMediaAccess(secret, objectKey, expires, signature);
  const actor = worker || signed ? { role: 'producer' } : await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '媒体访问未授权。' }, { status: 401 });
  const asset = await env.DB.prepare('SELECT media_type, sha256 FROM assets WHERE object_key = ? LIMIT 1').bind(objectKey).first<{ media_type: string; sha256: string }>();
  if (!asset) return Response.json({ error: '媒体不存在。' }, { status: 404 });
  const object = await env.MEDIA.get(objectKey);
  if (!object) return Response.json({ error: '媒体对象不存在。' }, { status: 404 });
  return new Response(object.body, { headers: { 'content-type': asset.media_type, etag: `"${asset.sha256}"`, 'cache-control': 'private, max-age=3600' } });
}
