import { env } from 'cloudflare:workers';
import { resolveActor } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '访问未授权。' }, { status: 403 });
  const { id } = await context.params;
  const row = await env.DB.prepare("SELECT package_object_key FROM publish_jobs WHERE id = ? AND channel = 'package' AND status = 'published'").bind(id).first<{ package_object_key: string }>();
  if (!row?.package_object_key) return Response.json({ error: '发布包尚未生成。' }, { status: 404 });
  const object = await env.MEDIA.get(row.package_object_key);
  if (!object) return Response.json({ error: '发布包对象不存在。' }, { status: 404 });
  return new Response(object.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${id}.manifest.json"` } });
}
