import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { sourceConnectorByPlatform } from '@/lib/source-connectors/registry';
import { sourceOwnershipReady } from '@/lib/source-ownership';
import { closeManualSourceSloExclusion } from '@/lib/source-slo-exclusions';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || actor.role !== 'admin') return sourceApiError('只有管理员可以启用来源。', 403);
  let body: { expectedVersion?: number };
  try { body = (await request.json()) as typeof body; }
  catch { return sourceApiError('请求体必须是 JSON。', 400); }
  if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
    return sourceApiError('expectedVersion 必填。', 422);
  }
  const { id } = await context.params;
  const now = new Date().toISOString();
  const result = await db.transaction(async (tx) => {
    const source = await tx.prepare(`
      SELECT version, platform, config_hash,
        COALESCE(NULLIF(rights_config_hash, ''), config_hash) AS rights_config_hash,
        last_tested_config_hash, rights_status, lifecycle_status
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(id).first<{
      version: number; platform: string; config_hash: string; rights_config_hash: string; last_tested_config_hash: string | null;
      rights_status: string; lifecycle_status: string;
    }>();
    if (!source) return { error: '来源不存在。', status: 404 as const };
    if (source.version !== body.expectedVersion) return { error: `版本冲突：当前版本为 ${source.version}。`, status: 409 as const };
    if (source.lifecycle_status === 'archived') return { error: '已归档来源不能启用。', status: 409 as const };
    if (source.rights_status !== 'approved') return { error: '来源权利状态未批准。', status: 409 as const };
    const ownership = await sourceOwnershipReady(tx, id);
    if ('error' in ownership) {
      return {
        error: `来源维护责任未就绪：${ownership.error}`,
        status: 409 as const,
      };
    }
    if (!source.config_hash || source.config_hash !== source.last_tested_config_hash) {
      return { error: '当前配置尚未通过连接测试，或测试后配置已变化。', status: 409 as const };
    }
    const connector = sourceConnectorByPlatform(source.platform);
    if (!connector || connector.availability !== 'available') {
      return { error: connector?.unavailableReason ?? '来源连接器不可用。', status: 409 as const };
    }
    const release = await tx.prepare(`
      SELECT rollout_mode FROM source_connector_releases
      WHERE connector_id = ? AND connector_version = ?
      LIMIT 1
    `).bind(connector.id, connector.version).first<{ rollout_mode: string }>();
    if (!release || release.rollout_mode === 'disabled') {
      return { error: `连接器 ${connector.id}@${connector.version} 当前已停用。`, status: 409 as const };
    }
    const validTest = await tx.prepare(`
      SELECT id FROM source_connection_tests
      WHERE source_config_id = ? AND config_hash = ? AND status = 'succeeded' AND expires_at > ?
      ORDER BY finished_at DESC LIMIT 1
    `).bind(id, source.config_hash, now).first<{ id: string }>();
    if (!validTest) return { error: '连接测试已过期，请重新测试。', status: 409 as const };
    const validGrant = await tx.prepare(`
      SELECT id FROM source_rights_grants
      WHERE source_config_id = ? AND config_hash = ? AND source_version <= ?
        AND purpose = 'finance-editorial-ingestion'
        AND usage_scope IN ('normalized-metadata', 'normalized-and-authorized-raw')
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY verified_at DESC LIMIT 1
    `).bind(id, source.rights_config_hash, source.version, now).first<{ id: string }>();
    if (!validGrant) return { error: '没有与当前配置绑定的有效来源使用权记录。', status: 409 as const };
    const updated = await tx.prepare(`
      UPDATE source_configs SET enabled = 1, lifecycle_status = 'enabled',
        health_status = 'healthy', next_run_at = COALESCE(next_run_at, ?),
        version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND config_hash = last_tested_config_hash
    `).bind(now, now, id, body.expectedVersion).run();
    if (!updated.meta.changes) return { error: '来源已被其他管理员修改。', status: 409 as const };
    await closeManualSourceSloExclusion(
      tx,
      { sourceId: id, actor },
      new Date(now),
    );
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, after_hash,
         metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.enabled', 'source_config', ?, ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, source.config_hash,
      JSON.stringify({ testId: validTest.id, rightsGrantId: validGrant.id, connectorId: connector.id, connectorVersion: connector.version, rolloutMode: release.rollout_mode }), crypto.randomUUID(), now).run();
    return { enabled: true, version: body.expectedVersion + 1, nextRunAt: now };
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result);
}
