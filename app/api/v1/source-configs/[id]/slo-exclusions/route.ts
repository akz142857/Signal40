import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { sourceActionAllowed } from '@/lib/source-authorization';
import {
  cancelPlannedSourceSloExclusion,
  createPlannedSourceSloExclusion,
  listSourceSloExclusions,
  type SourceSloExclusion,
} from '@/lib/source-slo-exclusions';

function publicExclusion(exclusion: SourceSloExclusion) {
  return {
    id: exclusion.id,
    kind: exclusion.kind,
    startsAt: exclusion.starts_at,
    endsAt: exclusion.ends_at,
    reason: exclusion.reason,
    cancelledAt: exclusion.cancelled_at ?? null,
  };
}

function exclusionError(error: unknown) {
  const message = error instanceof Error ? error.message : 'SLO 排除窗口操作失败。';
  if (/不存在|已归档/.test(message)) return sourceApiError(message, 404);
  if (/已经开始/.test(message)) return sourceApiError(message, 409);
  return sourceApiError(message, 422);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!sourceActionAllowed(await resolveRequestActor(request), 'source.read')) {
    return sourceApiError('无权读取来源 SLO 排除窗口。', 403);
  }
  const { id } = await context.params;
  const exclusions = await listSourceSloExclusions(db, id);
  return Response.json({ exclusions: exclusions.map(publicExclusion) });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.update')) {
    return sourceApiError('只有管理员可以登记计划维护窗口。', 403);
  }
  let body: { startsAt?: string; endsAt?: string; reason?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  const { id } = await context.params;
  try {
    const result = await createPlannedSourceSloExclusion(db, {
      sourceId: id,
      startsAt: body.startsAt ?? '',
      endsAt: body.endsAt ?? '',
      reason: body.reason ?? '',
      actor: actor!,
    });
    return Response.json(
      {
        exclusion: publicExclusion(result.exclusion),
        replayed: result.replayed,
      },
      { status: result.replayed ? 200 : 201 },
    );
  } catch (error) {
    return exclusionError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.update')) {
    return sourceApiError('只有管理员可以取消计划维护窗口。', 403);
  }
  let body: { exclusionId?: string; reason?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return sourceApiError('请求体必须是 JSON。', 400);
  }
  const { id } = await context.params;
  try {
    return Response.json(
      await cancelPlannedSourceSloExclusion(db, {
        sourceId: id,
        exclusionId: body.exclusionId ?? '',
        reason: body.reason ?? '',
        actor: actor!,
      }),
    );
  } catch (error) {
    return exclusionError(error);
  }
}
