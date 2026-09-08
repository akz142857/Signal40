import { config, db, resolveRequestActor } from '@/lib/runtime';
import { signMediaAccess } from '@/lib/media-auth';

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  let body: { objectKey?: string; ttlSeconds?: number };
  try { body = await request.json() as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.objectKey?.startsWith('projects/') || body.objectKey.length > 500) return Response.json({ error: '媒体对象键无效。' }, { status: 422 });
  const asset = await db.prepare('SELECT id FROM assets WHERE object_key = ? LIMIT 1').bind(body.objectKey).first();
  if (!asset) return Response.json({ error: '媒体不存在。' }, { status: 404 });
  const ttlSeconds = Number.isInteger(body.ttlSeconds) ? Math.min(900, Math.max(30, Number(body.ttlSeconds))) : 300;
  const secret = config.mediaSigningSecret || (new URL(request.url).hostname === 'localhost' || new URL(request.url).hostname === '127.0.0.1' ? 'signal40-local-media-signing-key' : '');
  if (!secret) return Response.json({ error: 'MEDIA_SIGNING_SECRET 未配置。' }, { status: 503 });
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = await signMediaAccess(secret, body.objectKey, expires);
  const url = `/api/v1/media?objectKey=${encodeURIComponent(body.objectKey)}&expires=${expires}&signature=${signature}`;
  return Response.json({ url, expiresAt: new Date(expires * 1000).toISOString(), actorId: actor.id });
}
