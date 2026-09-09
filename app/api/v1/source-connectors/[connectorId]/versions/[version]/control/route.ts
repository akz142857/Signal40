import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { sourceConnectorById } from '@/lib/source-connectors/registry';
import {
  getConnectorReleaseControl,
  setConnectorReleaseControl,
  type ConnectorRolloutMode,
} from '@/lib/source-release-control';

type RouteContext = { params: Promise<{ connectorId: string; version: string }> };

export async function GET(request: Request, context: RouteContext) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) {
    return sourceApiError('只有管理员或审计员可以查看连接器发布控制。', 403);
  }
  const { connectorId, version } = await context.params;
  const connector = sourceConnectorById(connectorId, version);
  if (!connector) return sourceApiError('连接器版本不存在。', 404);
  const control = await getConnectorReleaseControl(db, connector.id, connector.version);
  if (!control) return sourceApiError('连接器发布控制记录不存在。', 404);
  return Response.json({ connector, control });
}

export async function PATCH(request: Request, context: RouteContext) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') {
    return sourceApiError('只有管理员可以修改连接器发布控制。', 403);
  }
  let body: {
    rolloutMode?: ConnectorRolloutMode;
    expectedVersion?: number;
    reason?: string;
    canary?: { enabled?: boolean; percent?: number; failureRateBps?: number; minRuns?: number };
  };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!['disabled', 'shadow', 'enabled'].includes(body.rolloutMode ?? '') || !Number.isInteger(body.expectedVersion) || !body.reason?.trim()) {
    return sourceApiError('rolloutMode、expectedVersion 与 reason 必填。', 422);
  }
  if (body.canary && (
    typeof body.canary.enabled !== 'boolean' ||
    !Number.isInteger(body.canary.percent) || Number(body.canary.percent) < 1 || Number(body.canary.percent) > 100 ||
    !Number.isInteger(body.canary.failureRateBps) || Number(body.canary.failureRateBps) < 1 || Number(body.canary.failureRateBps) > 10_000 ||
    !Number.isInteger(body.canary.minRuns) || Number(body.canary.minRuns) < 1 || Number(body.canary.minRuns) > 10_000
  )) return sourceApiError('canary 需要 enabled、1–100 percent、1–10000 failureRateBps 和 1–10000 minRuns。', 422);
  if (body.canary?.enabled && body.rolloutMode !== 'enabled') {
    return sourceApiError('Canary 只能在 enabled 发布模式下启用。', 422);
  }
  const { connectorId, version } = await context.params;
  const connector = sourceConnectorById(connectorId, version);
  if (!connector) return sourceApiError('连接器版本不存在。', 404);
  if (connector.availability !== 'available' && body.rolloutMode !== 'disabled') {
    return sourceApiError(connector.unavailableReason ?? '该连接器尚不可发布。', 409, {
      errorCode: 'CONNECTOR_UNAVAILABLE',
    });
  }
  const result = await setConnectorReleaseControl(db, {
    connector,
    rolloutMode: body.rolloutMode as ConnectorRolloutMode,
    expectedVersion: Number(body.expectedVersion),
    reason: body.reason.trim(),
    actor,
    ...(body.canary ? {
      canary: {
        enabled: Boolean(body.canary.enabled),
        percent: Number(body.canary.percent),
        failureRateBps: Number(body.canary.failureRateBps),
        minRuns: Number(body.canary.minRuns),
      },
    } : {}),
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}
