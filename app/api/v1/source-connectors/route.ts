import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError } from '@/lib/source-api-error';
import { listSourceConnectors } from '@/lib/source-connectors/registry';
import { sourceActionAllowed } from '@/lib/source-authorization';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.read')) {
    return sourceApiError('当前角色无权查看来源连接器。', 403);
  }
  const controls = await db.prepare(`
    SELECT connector_id, connector_version, rollout_mode, reason, version,
      canary_enabled, canary_percent, canary_failure_rate_bps, canary_min_runs,
      canary_started_at, canary_stopped_at, updated_at
    FROM source_connector_releases
  `).all<{
    connector_id: string; connector_version: string; rollout_mode: string;
    reason: string; version: number; canary_enabled: number; canary_percent: number;
    canary_failure_rate_bps: number; canary_min_runs: number;
    canary_started_at: string | null; canary_stopped_at: string | null; updated_at: string;
  }>();
  const byRelease = new Map(controls.results.map((control) => [`${control.connector_id}@${control.connector_version}`, control]));
  return Response.json({
    connectors: listSourceConnectors().map((connector) => {
      const control = byRelease.get(`${connector.id}@${connector.version}`);
      return {
        ...connector,
        rolloutMode: control?.rollout_mode ?? 'disabled',
        rolloutReason: control?.reason ?? '发布控制记录缺失，按 fail-closed 停用。',
        rolloutVersion: control?.version ?? 0,
        rolloutUpdatedAt: control?.updated_at ?? null,
        canaryEnabled: Boolean(control?.canary_enabled),
        canaryPercent: control?.canary_percent ?? 10,
        canaryFailureRateBps: control?.canary_failure_rate_bps ?? 2000,
        canaryMinRuns: control?.canary_min_runs ?? 20,
        canaryStartedAt: control?.canary_started_at ?? null,
        canaryStoppedAt: control?.canary_stopped_at ?? null,
        effectiveAvailability: connector.availability === 'available' && control?.rollout_mode !== 'disabled'
          ? connector.availability
          : 'blocked',
      };
    }),
  });
}
