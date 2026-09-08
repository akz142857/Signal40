import { env } from 'cloudflare:workers';
import { enqueueIngestionRun } from '@/lib/control-plane';
import { sourceRunRateLimit } from '@/lib/schedule';
import { resolveActor } from '@/lib/workflow';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await env.DB.prepare('SELECT * FROM ingestion_runs WHERE source_config_id = ? ORDER BY created_at DESC LIMIT 100').bind(id).all();
  return Response.json({ runs: result.results });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveActor(request, env.DB, env.BOOTSTRAP_ADMIN_EMAILS);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  if (!['researcher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权触发采集。' }, { status: 403 });
  const key = request.headers.get('idempotency-key');
  if (!key) return Response.json({ error: 'Idempotency-Key 必填。' }, { status: 400 });
  const { id } = await context.params;
  const source = await env.DB.prepare('SELECT id, enabled, rights_status, checkpoint, rate_limit_per_minute FROM source_configs WHERE id = ?').bind(id).first<{ id: string; enabled: number; rights_status: string; checkpoint: string | null; rate_limit_per_minute: number }>();
  if (!source) return Response.json({ error: '来源不存在。' }, { status: 404 });
  if (!source.enabled || source.rights_status !== 'approved') return Response.json({ error: '来源未启用或授权未批准。' }, { status: 409 });
  const replay = await env.DB.prepare("SELECT id FROM jobs WHERE kind = 'ingestion' AND idempotency_key = ? LIMIT 1").bind(key).first<{ id: string }>();
  if (!replay) {
    const since = new Date(Date.now() - 60_000).toISOString();
    const recent = await env.DB.prepare('SELECT created_at FROM ingestion_runs WHERE source_config_id = ? AND created_at > ? ORDER BY created_at ASC LIMIT 600').bind(id, since).all<{ created_at: string }>();
    const quota = sourceRunRateLimit(recent.results.map((run) => run.created_at), source.rate_limit_per_minute);
    if (!quota.allowed) {
      return Response.json(
        { error: `来源触发频率超过每分钟 ${source.rate_limit_per_minute} 次限制。`, retryAfterSeconds: quota.retryAfterSeconds },
        { status: 429, headers: { 'retry-after': String(quota.retryAfterSeconds) } },
      );
    }
  }
  const job = await enqueueIngestionRun(env.DB, {
    sourceConfigId: id,
    checkpoint: source.checkpoint,
    idempotencyKey: key,
    actor,
  });
  return Response.json({ job, ingestionRunId: job.ingestionRunId }, { status: job.created ? 202 : 200 });
}
