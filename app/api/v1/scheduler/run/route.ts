import { env } from 'cloudflare:workers';
import { enqueueIngestionRun, type Actor } from '@/lib/control-plane';
import { scheduledMinuteSince } from '@/lib/schedule';
import { purgeExpiredSourcePayloads } from '@/lib/source-retention';
import { authorizeWorker } from '@/lib/worker-auth';

export async function POST(request: Request) {
  if (!(await authorizeWorker(request, env.SCHEDULER_TOKEN))) return Response.json({ error: '调度器未授权。' }, { status: 401 });
  const now = new Date();
  const retention = await purgeExpiredSourcePayloads(env.DB, env.MEDIA, now);
  const rows = await env.DB.prepare(`
    SELECT sc.id, sc.checkpoint, sc.schedule_cron, sc.created_at,
      COALESCE(MAX(ir.created_at), sc.created_at) AS last_run_at
    FROM source_configs sc LEFT JOIN ingestion_runs ir ON ir.source_config_id = sc.id
    WHERE sc.enabled = 1 AND sc.rights_status = 'approved' AND sc.schedule_cron IS NOT NULL
    GROUP BY sc.id, sc.checkpoint, sc.schedule_cron, sc.created_at
    LIMIT 500
  `).all<{ id: string; checkpoint: string | null; schedule_cron: string; created_at: string; last_run_at: string }>();
  const actor: Actor = { id: 'source-scheduler', email: 'scheduler@signal40.internal', role: 'admin' };
  const queued = [];
  for (const source of rows.results) {
    const scheduledMinute = scheduledMinuteSince(source.schedule_cron, source.last_run_at, now);
    if (!scheduledMinute) continue;
    const job = await enqueueIngestionRun(env.DB, {
      sourceConfigId: source.id,
      checkpoint: source.checkpoint,
      idempotencyKey: `schedule:${source.id}:${scheduledMinute}`,
      actor,
    }, now);
    queued.push({ sourceConfigId: source.id, scheduledMinute, jobId: job.id, ingestionRunId: job.ingestionRunId, created: job.created });
  }
  return Response.json({ checked: rows.results.length, queued, retention });
}
