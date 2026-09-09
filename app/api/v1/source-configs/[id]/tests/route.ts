import { db, resolveRequestActor } from '@/lib/runtime';
import { sourceApiError, sourceResultError } from '@/lib/source-api-error';
import { sourceConnectorByPlatform } from '@/lib/source-connectors/registry';
import { sourceActionAllowed } from '@/lib/source-authorization';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!sourceActionAllowed(actor, 'source.test')) return sourceApiError('只有管理员可以测试来源。', 403);
  const idempotencyKey = request.headers.get('idempotency-key');
  if (!idempotencyKey) return sourceApiError('Idempotency-Key 必填。', 400);
  const { id } = await context.params;
  const now = new Date();
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.valueOf() + 24 * 60 * 60_000).toISOString();

  const result = await db.transaction(async (tx) => {
    const source = await tx.prepare(`
      SELECT id, platform, config_hash, lifecycle_status FROM source_configs
      WHERE id = ? FOR UPDATE
    `).bind(id).first<{
      id: string; platform: string; config_hash: string; lifecycle_status: string;
    }>();
    if (!source) return { error: '来源不存在。', status: 404 as const };
    if (source.lifecycle_status === 'archived') return { error: '已归档来源不能测试。', status: 409 as const };
    const connector = sourceConnectorByPlatform(source.platform);
    if (!connector || connector.availability !== 'available' || !connector.supports.test) {
      return { error: connector?.unavailableReason ?? '该来源连接器不支持测试。', status: 409 as const };
    }
    const release = await tx.prepare(`
      SELECT rollout_mode FROM source_connector_releases
      WHERE connector_id = ? AND connector_version = ?
      LIMIT 1
    `).bind(connector.id, connector.version).first<{ rollout_mode: string }>();
    if (!release || release.rollout_mode === 'disabled') {
      return { error: `连接器 ${connector.id}@${connector.version} 当前已停用。`, status: 409 as const };
    }
    const replay = await tx.prepare(`
      SELECT sct.id, sct.status, sct.job_id FROM source_connection_tests sct
      JOIN jobs j ON j.id = sct.job_id
      WHERE j.kind = 'ingestion' AND j.idempotency_key = ? LIMIT 1
    `).bind(idempotencyKey).first<{ id: string; status: string; job_id: string }>();
    if (replay) return { testId: replay.id, testStatus: replay.status, created: false };

    const testId = `source_test_${crypto.randomUUID()}`;
    const jobId = `job_${crypto.randomUUID()}`;
    const payload = {
      schemaVersion: 2,
      operation: 'source_test',
      sourceConfigId: id,
      testId,
      configHash: source.config_hash,
      connectorId: connector.id,
      connectorVersion: connector.version,
      rolloutMode: release.rollout_mode,
    };
    await tx.prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, required_capability_protocol_version,
         payload_schema_version, payload_json, status,
         idempotency_key, attempt, max_attempts, priority, timeout_seconds,
         available_at, created_at, updated_at)
      VALUES (?, 'ingestion', ?, ?, 2, ?, 'queued', ?, 0, 3, 80, 120, ?, ?, ?)
    `).bind(jobId, connector.requiredCapability, connector.capabilityProtocolVersion, JSON.stringify(payload), idempotencyKey, timestamp, timestamp, timestamp).run();
    await tx.prepare(`
      INSERT INTO source_connection_tests
        (id, source_config_id, job_id, config_hash, status, preview_json,
         capabilities_json, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, 'queued', '[]', ?, ?, ?, ?)
    `).bind(testId, id, jobId, source.config_hash, JSON.stringify(connector.supports), expiresAt, actor!.id, timestamp).run();
    await tx.prepare(`
      UPDATE source_configs SET lifecycle_status = CASE WHEN enabled = 1 THEN lifecycle_status ELSE 'connecting' END,
        last_error = NULL, last_error_code = NULL, last_error_detail_redacted = NULL, updated_at = ?
      WHERE id = ?
    `).bind(timestamp, id).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, after_hash,
         metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.test_requested', 'source_config', ?, ?, ?, ?, ?)
    `).bind(`audit_${crypto.randomUUID()}`, actor!.id, actor!.role, id, source.config_hash,
      JSON.stringify({ testId, jobId, idempotencyKey, connectorId: connector.id, connectorVersion: connector.version, rolloutMode: release.rollout_mode }), crypto.randomUUID(), timestamp).run();
    return { testId, testStatus: 'queued', created: true };
  });
  if ('error' in result) return sourceResultError(result);
  return Response.json(result, { status: result.created ? 202 : 200 });
}
