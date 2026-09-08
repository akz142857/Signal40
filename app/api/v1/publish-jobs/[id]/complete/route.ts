import { env } from 'cloudflare:workers';
import { authorizeWorker } from '@/lib/worker-auth';
import { stableHash } from '@/lib/workflow';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, env.WORKER_TOKEN))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { jobId?: string; externalId?: string; finalUrl?: string; manifest?: unknown; platformResponse?: unknown; channel?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const { id } = await context.params;
  const publishJob = await env.DB.prepare('SELECT id, project_id, channel, status FROM publish_jobs WHERE id = ? LIMIT 1').bind(id).first<{ id: string; project_id: string; channel: string; status: string }>();
  if (!publishJob) return Response.json({ error: '发布任务不存在。' }, { status: 404 });
  if (publishJob.status !== 'publishing') return Response.json({ error: `发布任务处于 ${publishJob.status}，拒绝写入完成结果。` }, { status: 409 });
  const job = body.jobId ? await env.DB.prepare("SELECT id FROM jobs WHERE id = ? AND kind = 'publish' AND status = 'leased' AND project_id = ?").bind(body.jobId, publishJob.project_id).first() : null;
  if (!job || body.channel !== publishJob.channel) return Response.json({ error: '发布 Worker 租约或渠道不匹配。' }, { status: 409 });
  if (publishJob.channel === 'youtube' && !body.externalId) return Response.json({ error: 'YouTube 发布必须返回 externalId。' }, { status: 422 });
  const now = new Date().toISOString();
  let packageObjectKey: string | null = null;
  if (publishJob.channel === 'package') {
    packageObjectKey = `projects/${publishJob.project_id}/publish/${id}/manifest.json`;
    await env.MEDIA.put(packageObjectKey, JSON.stringify(body.manifest ?? {}), { httpMetadata: { contentType: 'application/json' }, customMetadata: { projectId: publishJob.project_id, publishJobId: id } });
  }
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE publish_jobs SET status = 'published', external_id = ?, package_object_key = ?, final_url = ?, platform_response_json = ?, updated_at = ? WHERE id = ? AND status = 'publishing'").bind(body.externalId ?? null, packageObjectKey, body.finalUrl ?? null, body.platformResponse === undefined ? null : JSON.stringify(body.platformResponse), now, id),
    env.DB.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) SELECT ?, ?, 'publish-worker', 'publisher', 'publish.completed', 'publish_job', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM publish_jobs WHERE id = ? AND status = 'published' AND updated_at = ?)").bind(`audit_${crypto.randomUUID()}`, publishJob.project_id, id, stableHash({ externalId: body.externalId, packageObjectKey }), JSON.stringify({ channel: publishJob.channel }), crypto.randomUUID(), now, id, now),
  ];
  if (publishJob.channel === 'youtube') statements.push(env.DB.prepare("UPDATE content_projects SET state = 'PUBLISHED', version = version + 1, updated_at = ? WHERE id = ? AND state = 'PUBLISH_SCHEDULED' AND EXISTS (SELECT 1 FROM publish_jobs WHERE id = ? AND status = 'published' AND updated_at = ?)").bind(now, publishJob.project_id, id, now));
  try {
    const [updated] = await env.DB.batch(statements);
    if (!updated.meta.changes) {
      if (packageObjectKey) await env.MEDIA.delete(packageObjectKey).catch(() => undefined);
      return Response.json({ error: '发布任务状态已变化，完成结果未写入。' }, { status: 409 });
    }
  } catch {
    if (packageObjectKey) await env.MEDIA.delete(packageObjectKey).catch(() => undefined);
    return Response.json({ error: '发布完成结果提交失败。' }, { status: 503 });
  }
  return Response.json({ publishJobId: id, status: 'published', externalId: body.externalId ?? null, finalUrl: body.finalUrl ?? null, packageObjectKey });
}
