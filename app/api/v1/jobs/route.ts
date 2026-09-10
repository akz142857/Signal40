import { config, db, resolveRequestActor } from '@/lib/runtime';
import { enqueueJob, loadContentProject } from '@/lib/control-plane';
import { stableHash } from '@/lib/workflow';
import { abandonIdempotentRequest, beginIdempotentRequest, completeIdempotencyStatement, validIdempotencyKey } from '@/lib/idempotency';

const kinds = ['voice', 'preview', 'render'] as const;

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(idempotencyKey)) return Response.json({ error: '有效的 Idempotency-Key 必填。' }, { status: 400 });
  let body: { kind?: string; projectId?: string; payload?: unknown; maxAttempts?: number; priority?: number; timeoutSeconds?: number; estimatedCostMicros?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!kinds.includes(body.kind as never)) return Response.json({ error: '作业类型无效。' }, { status: 422 });
  const rolesByKind: Record<(typeof kinds)[number], string[]> = { voice: ['producer', 'admin'], preview: ['producer', 'admin'], render: ['producer', 'admin'] };
  if (!rolesByKind[body.kind as (typeof kinds)[number]].includes(actor.role)) return Response.json({ error: `角色 ${actor.role} 无权创建 ${body.kind} 作业。` }, { status: 403 });
  if (body.maxAttempts !== undefined && (!Number.isInteger(body.maxAttempts) || body.maxAttempts < 1 || body.maxAttempts > 20))
    return Response.json({ error: 'maxAttempts 必须是 1–20 的整数。' }, { status: 422 });
  if (body.priority !== undefined && (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 100)) return Response.json({ error: 'priority 必须是 0–100 的整数。' }, { status: 422 });
  if (body.timeoutSeconds !== undefined && (!Number.isInteger(body.timeoutSeconds) || body.timeoutSeconds < 30 || body.timeoutSeconds > 1800)) return Response.json({ error: 'timeoutSeconds 必须是 30–1800 的整数。' }, { status: 422 });
  if (body.estimatedCostMicros !== undefined && (!Number.isInteger(body.estimatedCostMicros) || body.estimatedCostMicros < 0)) return Response.json({ error: 'estimatedCostMicros 必须是非负整数。' }, { status: 422 });
  if (!body.projectId) return Response.json({ error: 'projectId 必填。' }, { status: 422 });
  const project = await loadContentProject(db, body.projectId);
  if (!project) return Response.json({ error: '项目不存在。' }, { status: 404 });
  const payload = body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : {};
  if (body.kind === 'voice' && (project.state !== 'SCRIPT_APPROVED' || payload.scriptHash !== stableHash(project.project.script) || payload.scriptVersion !== project.project.script.version)) return Response.json({ error: '配音作业必须绑定当前已批准脚本版本。' }, { status: 409 });
  if (body.kind === 'preview' && (project.state !== 'ASSETS_READY' || payload.snapshotHash !== project.project.render.snapshotHash)) return Response.json({ error: '预览作业必须绑定当前资产就绪快照。' }, { status: 409 });
  if (body.kind === 'render' && (project.state !== 'ASSETS_READY' || payload.snapshotHash !== project.project.render.snapshotHash)) return Response.json({ error: '渲染作业必须绑定当前资产就绪快照。' }, { status: 409 });
  if (body.kind === 'preview' || body.kind === 'render') {
    const budget = Number(config.monthlyRenderBudgetMicros ?? 0);
    if (budget > 0) {
      const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
      const used = await db.prepare("SELECT COALESCE(SUM(CASE WHEN cost_micros > 0 THEN cost_micros ELSE estimated_cost_micros END), 0) AS total FROM jobs WHERE kind IN ('preview', 'render') AND created_at >= ? AND status != 'cancelled'").bind(monthStart.toISOString()).first<{ total: number }>();
      if (Number(used?.total ?? 0) + Number(body.estimatedCostMicros ?? 0) > budget) return Response.json({ error: '本月渲染成本预算不足。' }, { status: 409 });
    }
  }
  const idempotency = await beginIdempotentRequest(db, {
    scope: `jobs.create:${actor.id}`,
    key: idempotencyKey!,
    request: {
      kind: body.kind,
      projectId: body.projectId,
      payload,
      maxAttempts: body.maxAttempts ?? null,
      priority: body.priority ?? null,
      timeoutSeconds: body.timeoutSeconds ?? null,
      estimatedCostMicros: body.estimatedCostMicros ?? null,
    },
  });
  if (idempotency.kind === 'conflict') return Response.json({ error: '该 Idempotency-Key 已用于不同的作业请求。' }, { status: 409 });
  if (idempotency.kind === 'pending') return Response.json({ error: '相同请求正在处理中，请稍后重试。' }, { status: 425 });
  if (idempotency.kind === 'replay') return Response.json(idempotency.body, { status: idempotency.status });
  try {
    const result = await db.transaction(async (tx) => {
      const job = await enqueueJob(tx, {
        kind: body.kind as (typeof kinds)[number],
        projectId: body.projectId,
        payload,
        idempotencyKey: idempotencyKey!,
        maxAttempts: body.maxAttempts,
        priority: body.priority,
        timeoutSeconds: body.timeoutSeconds,
        estimatedCostMicros: body.estimatedCostMicros,
        actor,
      });
      if ((body.kind === 'preview' || body.kind === 'render') && job.created) {
        await tx.prepare('INSERT INTO render_snapshots (id, project_id, snapshot_json, snapshot_hash, template_id, template_version, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(`render_${crypto.randomUUID()}`, project.id, JSON.stringify(project.project), project.project.render.snapshotHash, project.project.render.templateId ?? 'signal40-editorial', project.project.render.templateVersion, actor.id, new Date().toISOString()).run();
      }
      const status = job.created ? 202 : 200;
      const responseBody = { job };
      await completeIdempotencyStatement(tx, idempotency.reservation, status, responseBody).run();
      return { job, status, responseBody };
    });
    return Response.json(result.responseBody, { status: result.status });
  } catch (error) {
    await abandonIdempotentRequest(db, idempotency.reservation);
    if (error instanceof Error && error.message === 'IDEMPOTENCY_CONFLICT') {
      return Response.json({ error: '该 Idempotency-Key 已用于不同的作业请求。' }, { status: 409 });
    }
    return Response.json({ error: '作业入队失败。' }, { status: 503 });
  }
}
