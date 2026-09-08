import { config, db, storage } from '@/lib/runtime';
import { runAutomationTick } from '@/lib/orchestrator';
import { authorizeWorker } from '@/lib/worker-auth';

/**
 * 手动触发一轮编排。常规运行由 `scripts/scheduler.ts` 常驻进程负责，
 * 这里只是同一份逻辑的薄封装：工作量收得更紧，避免 HTTP 超时。
 */
export async function POST(request: Request) {
  if (!(await authorizeWorker(request, config.schedulerToken))) return Response.json({ error: '调度器未授权。' }, { status: 401 });
  const result = await runAutomationTick({
    db,
    storage,
    trigger: 'manual',
    automationActorId: config.automationActorId,
    monthlyRenderBudgetMicros: Number(config.monthlyRenderBudgetMicros ?? 0),
    notify: { url: config.attentionWebhookUrl, secret: config.webhookSecret },
    limits: { projects: 5, projectCreations: 1, publishes: 1, notifications: 5 },
  });
  return Response.json(result);
}
