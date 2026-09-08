import { db, resolveRequestActor } from '@/lib/runtime';
import { schedulePublishJob } from '@/lib/control-plane';

const channels = ['package', 'youtube'] as const;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await db.prepare('SELECT id, channel, logical_key, status, account_id, title, description, tags_json, cover_asset_id, scheduled_at, external_id, package_object_key, final_url, correction_of_id, created_at, updated_at FROM publish_jobs WHERE project_id = ? ORDER BY created_at DESC').bind(id).all();
  return Response.json({ publishJobs: result.results });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['publisher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权创建发布任务。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  let body: { channel?: string; accountId?: string | null; title?: string; description?: string; tags?: string[]; coverAssetId?: string | null; scheduledAt?: string | null; privacyStatus?: string; correctionOfId?: string | null };
  try { body = (await request.json()) as typeof body; }
  catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!channels.includes(body.channel as never)) return Response.json({ error: 'channel 必须是 package 或 youtube。' }, { status: 422 });
  if (!body.title?.trim() || body.title.length > 100 || (body.description?.length ?? 0) > 5000) return Response.json({ error: '标题必须为 1–100 字，描述最多 5000 字。' }, { status: 422 });
  if (body.scheduledAt && Number.isNaN(new Date(body.scheduledAt).valueOf())) return Response.json({ error: 'scheduledAt 无效。' }, { status: 422 });
  if (body.privacyStatus && !['private', 'unlisted', 'public'].includes(body.privacyStatus)) return Response.json({ error: 'privacyStatus 无效。' }, { status: 422 });
  if ((body.tags?.length ?? 0) > 30 || body.tags?.some((tag) => !tag.trim() || tag.length > 50)) return Response.json({ error: '最多 30 个有效标签，每个不超过 50 字。' }, { status: 422 });
  const { id } = await context.params;
  const result = await schedulePublishJob(db, {
    projectId: id,
    channel: body.channel as 'package' | 'youtube',
    title: body.title,
    description: body.description,
    tags: body.tags,
    coverAssetId: body.coverAssetId,
    accountId: body.accountId,
    scheduledAt: body.scheduledAt,
    privacyStatus: body.privacyStatus,
    correctionOfId: body.correctionOfId,
    requestIdempotencyKey: key,
    actor,
  });
  if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
  if ('replayed' in result) return Response.json({ publishJob: result.publishJob, replayed: true });
  return Response.json({ publishJob: result.publishJob, job: result.job }, { status: 202 });
}
