import { env } from 'cloudflare:workers';
import { evaluateProjectGates, loadContentProject } from '@/lib/control-plane';
import { resolveActor, stableHash } from '@/lib/workflow';

const channels = ['package', 'youtube'] as const;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await env.DB.prepare('SELECT id, channel, logical_key, status, account_id, title, description, tags_json, cover_asset_id, scheduled_at, external_id, package_object_key, final_url, correction_of_id, created_at, updated_at FROM publish_jobs WHERE project_id = ? ORDER BY created_at DESC').bind(id).all();
  return Response.json({ publishJobs: result.results });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
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
  const project = await loadContentProject(env.DB, id);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  if (project.state !== 'PUBLISH_SCHEDULED') return Response.json({ error: '项目必须先完成独立发布批准并进入 PUBLISH_SCHEDULED。' }, { status: 409 });
  const gates = await evaluateProjectGates(env.DB, id);
  if (!gates.find((gate) => gate.code === 'G7_PUBLISH_APPROVAL')?.passed) return Response.json({ error: '独立发布批准未通过或已过期。' }, { status: 409 });
  const asset = await env.DB.prepare("SELECT id, object_key, byte_size, sha256 FROM assets WHERE project_id = ? AND media_type = 'video/mp4' AND asset_role = 'render-output' AND rights_status = 'cleared' ORDER BY created_at DESC LIMIT 1").bind(id).first<{ id: string; object_key: string; byte_size: number; sha256: string }>();
  if (!asset) return Response.json({ error: '没有通过版权检查的 MP4 成片。' }, { status: 409 });
  const accountId = body.accountId?.trim() || project.project.distribution.accountId || 'default';
  const scheduledAt = body.scheduledAt ?? project.project.distribution.scheduledAt ?? null;
  const tags = body.tags ?? project.project.distribution.tags ?? [];
  const coverAssetId = body.coverAssetId ?? project.project.distribution.coverAssetId ?? null;
  const coverAsset = coverAssetId ? await env.DB.prepare("SELECT id, object_key, media_type, byte_size, sha256 FROM assets WHERE id = ? AND project_id = ? AND media_type LIKE 'image/%' AND rights_status = 'cleared'").bind(coverAssetId, id).first<{ id: string; object_key: string; media_type: string; byte_size: number; sha256: string }>() : null;
  if (coverAssetId && !coverAsset) return Response.json({ error: '封面资产不存在、不是图片或版权未清除。' }, { status: 422 });
  const logicalKey = stableHash({ projectVersion: project.version, channel: body.channel, accountId, scheduledAt });
  const existing = await env.DB.prepare('SELECT id, status FROM publish_jobs WHERE channel = ? AND logical_key = ? LIMIT 1').bind(body.channel, logicalKey).first<{ id: string; status: string }>();
  if (existing) return Response.json({ publishJob: existing, replayed: true });
  if (body.correctionOfId) {
    const corrected = await env.DB.prepare("SELECT id FROM publish_jobs WHERE id = ? AND project_id = ? AND status IN ('published', 'withdrawn') LIMIT 1").bind(body.correctionOfId, id).first();
    if (!corrected) return Response.json({ error: 'correctionOfId 必须指向本项目已发布或已撤回的版本。' }, { status: 422 });
  }
  const publishJobId = `publish_${crypto.randomUUID()}`;
  const workerJobId = `job_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const payload = { publishJobId, projectId: id, operation: 'publish', channel: body.channel, accountId, asset, coverAsset, title: body.title.trim(), description: body.description?.trim() ?? '', tags, scheduledAt, privacyStatus: body.privacyStatus ?? 'private', correctionOfId: body.correctionOfId ?? null, snapshotHash: project.project.render.snapshotHash, sources: project.project.research.claims.flatMap((claim) => claim.evidence.map((evidence) => evidence.url)) };
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO publish_jobs (id, project_id, channel, logical_key, status, account_id, title, description, tags_json, cover_asset_id, scheduled_at, correction_of_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(publishJobId, id, body.channel, logicalKey, accountId, body.title.trim(), body.description?.trim() ?? '', JSON.stringify(tags), coverAssetId, scheduledAt, body.correctionOfId ?? null, now, now),
      env.DB.prepare(`
        INSERT INTO jobs
          (id, kind, project_id, payload_json, status, idempotency_key, attempt,
           max_attempts, priority, timeout_seconds, estimated_cost_micros, available_at, created_at, updated_at)
        VALUES (?, 'publish', ?, ?, 'queued', ?, 0, 5, 50, 900, 0, ?, ?, ?)
      `).bind(workerJobId, id, JSON.stringify(payload), `publish:${body.channel}:${logicalKey}`, scheduledAt ?? now, now, now),
      env.DB.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'job.enqueued', 'job', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, id, actor.id, actor.role, workerJobId, stableHash(payload), JSON.stringify({ kind: 'publish', idempotencyKey: `publish:${body.channel}:${logicalKey}`, requestIdempotencyKey: key }), crypto.randomUUID(), now),
      env.DB.prepare("INSERT INTO audit_events (id, project_id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, ?, 'publish.scheduled', 'publish_job', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, id, actor.id, actor.role, publishJobId, stableHash(payload), JSON.stringify({ channel: body.channel, accountId, scheduledAt, coverAssetId, correctionOfId: body.correctionOfId ?? null }), crypto.randomUUID(), now),
    ]);
    return Response.json({ publishJob: { id: publishJobId, status: 'scheduled', channel: body.channel }, job: { id: workerJobId, status: 'queued', created: true } }, { status: 202 });
  } catch {
    const replay = await env.DB.prepare('SELECT id, status FROM publish_jobs WHERE channel = ? AND logical_key = ? LIMIT 1').bind(body.channel, logicalKey).first<{ id: string; status: string }>();
    if (replay) return Response.json({ publishJob: replay, replayed: true });
    return Response.json({ error: '发布任务入队失败。' }, { status: 503 });
  }
}
