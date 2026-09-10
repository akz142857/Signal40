import { config, db, storage } from '@/lib/runtime';
import type { SqlStatement } from '@/lib/sql';
import { authorizeWorker } from '@/lib/worker-auth';
import { loadActiveJobLease } from '@/lib/job-lease';
import { stableHash } from '@/lib/workflow';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await authorizeWorker(request, config.renderWorkerToken))) return Response.json({ error: 'Worker 未授权。' }, { status: 401 });
  let body: { jobId?: string; workerId?: string; leaseEpoch?: number; externalId?: string; finalUrl?: string; manifest?: unknown; platformResponse?: unknown; channel?: string };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const { id } = await context.params;
  const publishJob = await db.prepare('SELECT id, project_id, channel, status, external_id, package_object_key, final_url, platform_response_json FROM publish_jobs WHERE id = ? LIMIT 1').bind(id).first<{ id: string; project_id: string; channel: string; status: string; external_id: string | null; package_object_key: string | null; final_url: string | null; platform_response_json: unknown }>();
  if (!publishJob) return Response.json({ error: '发布任务不存在。' }, { status: 404 });
  if (!['publishing', 'published'].includes(publishJob.status)) return Response.json({ error: `发布任务处于 ${publishJob.status}，拒绝写入完成结果。` }, { status: 409 });
  const job = body.jobId && body.workerId && Number.isInteger(body.leaseEpoch) && Number(body.leaseEpoch) > 0
    ? await loadActiveJobLease(db, { jobId: body.jobId, workerId: body.workerId.slice(0, 160), leaseEpoch: Number(body.leaseEpoch), projectId: publishJob.project_id, kinds: ['publish'] })
    : null;
  if (!job || body.channel !== publishJob.channel) return Response.json({ error: '发布 Worker 租约或渠道不匹配。' }, { status: 409 });
  if (publishJob.channel === 'youtube' && !body.externalId) return Response.json({ error: 'YouTube 发布必须返回 externalId。' }, { status: 422 });
  if (publishJob.status === 'published') {
    let matches = publishJob.external_id === (body.externalId ?? null) && publishJob.final_url === (body.finalUrl ?? null);
    if (publishJob.channel === 'package') {
      const expectedKey = `projects/${publishJob.project_id}/publish/${id}/manifest.json`;
      const object = publishJob.package_object_key === expectedKey ? await storage.get(expectedKey) : null;
      if (!object) return Response.json({ error: '已发布包的 manifest 对象缺失。' }, { status: 503 });
      try {
        matches = matches && stableHash(await new Response(object.body).json()) === stableHash(body.manifest ?? {});
      } catch {
        return Response.json({ error: '已发布包的 manifest 无法读取。' }, { status: 503 });
      }
    } else {
      let storedPlatformResponse: unknown = null;
      try {
        storedPlatformResponse = typeof publishJob.platform_response_json === 'string'
          ? JSON.parse(publishJob.platform_response_json)
          : publishJob.platform_response_json;
      } catch {
        return Response.json({ error: '已保存的平台响应无法读取。' }, { status: 503 });
      }
      matches = matches && stableHash(storedPlatformResponse) === stableHash(body.platformResponse ?? null);
    }
    if (!matches) return Response.json({ error: '该发布任务已经提交过不同的完成结果。' }, { status: 409 });
    return Response.json({ publishJobId: id, status: 'published', externalId: publishJob.external_id, finalUrl: publishJob.final_url, packageObjectKey: publishJob.package_object_key }, { headers: { 'Idempotency-Replayed': 'true' } });
  }
  const now = new Date().toISOString();
  let packageObjectKey: string | null = null;
  if (publishJob.channel === 'package') {
    packageObjectKey = `projects/${publishJob.project_id}/publish/${id}/manifest.json`;
    await storage.put(packageObjectKey, JSON.stringify(body.manifest ?? {}), { contentType: 'application/json', customMetadata: { projectId: publishJob.project_id, publishJobId: id } });
  }
  const statements: SqlStatement[] = [
    db.prepare(`UPDATE publish_jobs SET status = 'published', external_id = ?, package_object_key = ?, final_url = ?, platform_response_json = ?, updated_at = ?
      WHERE id = ? AND status = 'publishing' AND EXISTS (
        SELECT 1 FROM jobs WHERE id = ? AND project_id = ? AND kind = 'publish' AND status = 'leased'
          AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?
      )`).bind(body.externalId ?? null, packageObjectKey, body.finalUrl ?? null, body.platformResponse === undefined ? null : JSON.stringify(body.platformResponse), now, id, body.jobId!, publishJob.project_id, body.workerId!.slice(0, 160), Number(body.leaseEpoch), now),
    db.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) SELECT ?, ?, 'publish-worker', 'publisher', 'publish.completed', 'publish_job', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM publish_jobs WHERE id = ? AND status = 'published' AND updated_at = ?)").bind(`audit_${crypto.randomUUID()}`, publishJob.project_id, id, stableHash({ externalId: body.externalId, packageObjectKey }), JSON.stringify({ channel: publishJob.channel }), crypto.randomUUID(), now, id, now),
  ];
  if (publishJob.channel === 'youtube') statements.push(db.prepare("UPDATE content_projects SET state = 'PUBLISHED', version = version + 1, updated_at = ? WHERE id = ? AND state = 'PUBLISH_SCHEDULED' AND EXISTS (SELECT 1 FROM publish_jobs WHERE id = ? AND status = 'published' AND updated_at = ?)").bind(now, publishJob.project_id, id, now));
  try {
    const [updated] = await db.batch(statements);
    if (!updated.meta.changes) {
      if (packageObjectKey) await storage.delete(packageObjectKey).catch(() => undefined);
      return Response.json({ error: '发布任务状态已变化，完成结果未写入。' }, { status: 409 });
    }
  } catch {
    if (packageObjectKey) await storage.delete(packageObjectKey).catch(() => undefined);
    return Response.json({ error: '发布完成结果提交失败。' }, { status: 503 });
  }
  return Response.json({ publishJobId: id, status: 'published', externalId: body.externalId ?? null, finalUrl: body.finalUrl ?? null, packageObjectKey });
}
