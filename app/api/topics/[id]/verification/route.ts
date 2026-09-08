import { env } from 'cloudflare:workers';
import { recordVerification } from '@/lib/persistence';
import type { VerificationStatus } from '@/lib/domain';
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotencyStatement,
  validIdempotencyKey,
} from '@/lib/idempotency';
import { resolveActor, stableHash } from '@/lib/workflow';

const STATUSES = ['unreviewed', 'verified', 'rejected'] as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveActor(
    request,
    env.DB,
    env.BOOTSTRAP_ADMIN_EMAILS,
  );
  if (!actor)
    return Response.json(
      { error: '用户未加入 Signal 40 团队。' },
      { status: 403 },
    );
  if (!['editor', 'admin'].includes(actor.role))
    return Response.json(
      { error: '只有编辑或管理员可以核验选题。' },
      { status: 403 },
    );
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!validIdempotencyKey(idempotencyKey))
    return Response.json(
      { error: '必须提供有效的 Idempotency-Key。' },
      { status: 400 },
    );
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object')
    return Response.json({ error: '请求体必须是对象。' }, { status: 422 });
  const body = payload as { status?: unknown; note?: unknown };
  if (!STATUSES.includes(body.status as VerificationStatus))
    return Response.json({ error: '核验状态无效。' }, { status: 422 });
  if (typeof body.note !== 'string' || body.note.length > 1_000)
    return Response.json(
      { error: '核验备注最多 1000 个字符。' },
      { status: 422 },
    );
  const note = body.note.trim();
  if (body.status !== 'unreviewed' && note.length < 10) {
    return Response.json(
      { error: '批准或驳回时，请填写至少 10 个字符的核验备注。' },
      { status: 422 },
    );
  }
  const { id } = await context.params;
  const now = new Date();
  const started = await beginIdempotentRequest(env.DB, {
    scope: `topics.verification:${actor.id}:${id}`,
    key: idempotencyKey!,
    request: { status: body.status, note },
    now,
  });
  if (started.kind === 'conflict')
    return Response.json(
      { error: '该 Idempotency-Key 已用于不同的请求。' },
      { status: 409 },
    );
  if (started.kind === 'pending')
    return Response.json(
      { error: '相同请求正在处理中，请稍后重试。' },
      { status: 425, headers: { 'Retry-After': '2' } },
    );
  if (started.kind === 'replay')
    return Response.json(started.body, {
      status: started.status,
      headers: { 'Idempotency-Replayed': 'true' },
    });
  const reservation = started.reservation;
  try {
    const result = await recordVerification(
      env.DB,
      id,
      body.status as VerificationStatus,
      note,
      now,
      {
        additionalStatements: (topic) => {
          const responseBody = { topic };
          return [
            completeIdempotencyStatement(
              env.DB,
              reservation,
              200,
              responseBody,
            ),
            env.DB
              .prepare(
                `INSERT INTO audit_events
                 (id, actor_id, actor_role, action, entity_type, entity_id,
                  after_hash, metadata_json, request_id, created_at)
                 VALUES (?, ?, ?, 'topic.verification_recorded', 'topic', ?, ?, ?, ?, ?)`,
              )
              .bind(
                `audit_${crypto.randomUUID()}`,
                actor.id,
                actor.role,
                id,
                stableHash(responseBody),
                JSON.stringify({
                  status: body.status,
                  note,
                  idempotencyKey,
                }),
                crypto.randomUUID(),
                now.toISOString(),
              ),
          ];
        },
      },
    );
    if ('error' in result) {
      await abandonIdempotentRequest(env.DB, reservation);
      return Response.json({ error: result.error }, { status: result.status });
    }
    return Response.json({ topic: result.topic });
  } catch {
    await abandonIdempotentRequest(env.DB, reservation).catch(() => undefined);
    return Response.json(
      { error: '核验记录保存失败，请稍后重试。' },
      { status: 503 },
    );
  }
}
