import type { SqlDatabase } from './sql.ts';
import { stableHash, type Actor } from './workflow.ts';
import { SOURCE_TYPES, type SourceType } from './domain.ts';
import {
  AUTHORIZED_RAW_SCOPE,
  INGESTION_RIGHTS_PURPOSE,
  NORMALIZED_METADATA_SCOPE,
} from './source-rights.ts';

const ALLOWED_FIELDS = new Set([
  'id',
  'title',
  'summary',
  'url',
  'publishedAt',
  'updatedAt',
  'author',
  'kind',
  'deletedAt',
]);
const REQUIRED_FIELDS = ['title', 'url', 'publishedAt'];
const DOSSIER_FIELDS = new Set([
  'principal',
  'sourceType',
  'permittedFields',
  'territory',
  'evidenceRef',
  'evidenceSha256',
  'termsVersion',
  'termsSnapshotSha256',
  'grantedAt',
  'expiresAt',
]);

export type SourceRightsDecisionDossier = {
  principal: string;
  sourceType: SourceType;
  permittedFields: string[];
  territory: string;
  evidenceRef: string;
  evidenceSha256: string;
  termsVersion: string;
  termsSnapshotSha256: string;
  grantedAt: string;
  expiresAt: string | null;
};

export function parseSourceRightsDecisionDossier(
  value: unknown,
  now = new Date(),
): { dossier: SourceRightsDecisionDossier } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: '批准时必须提供权利证据 dossier。' };
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((field) => !DOSSIER_FIELDS.has(field))) {
    return { error: '权利证据 dossier 包含未定义字段。' };
  }
  const principal = typeof input.principal === 'string' ? input.principal.trim() : '';
  const sourceType = typeof input.sourceType === 'string' ? input.sourceType.trim() : '';
  const territory = typeof input.territory === 'string' ? input.territory.trim() : '';
  const evidenceRef = typeof input.evidenceRef === 'string' ? input.evidenceRef.trim() : '';
  const evidenceSha256 = typeof input.evidenceSha256 === 'string' ? input.evidenceSha256.trim().toLowerCase() : '';
  const termsVersion = typeof input.termsVersion === 'string' ? input.termsVersion.trim() : '';
  const termsSnapshotSha256 = typeof input.termsSnapshotSha256 === 'string'
    ? input.termsSnapshotSha256.trim().toLowerCase()
    : '';
  const grantedAt = typeof input.grantedAt === 'string' ? input.grantedAt.trim() : '';
  const expiresAt = input.expiresAt === null || input.expiresAt === undefined
    ? null
    : typeof input.expiresAt === 'string'
      ? input.expiresAt.trim()
      : '';
  if (!principal || principal.length > 300) return { error: 'principal 必须为 1–300 字。' };
  if (!(SOURCE_TYPES as readonly string[]).includes(sourceType)) {
    return { error: `sourceType 必须是 ${SOURCE_TYPES.join('、')} 之一。` };
  }
  if (!territory || territory.length > 200) return { error: 'territory 必须为 1–200 字。' };
  if (!evidenceRef || evidenceRef.length > 1000) return { error: 'evidenceRef 必须为 1–1000 字。' };
  if (!/^[a-f0-9]{64}$/.test(evidenceSha256)) return { error: 'evidenceSha256 必须是 64 位 SHA-256。' };
  if (!termsVersion || termsVersion.length > 200) return { error: 'termsVersion 必须为 1–200 字。' };
  if (!/^[a-f0-9]{64}$/.test(termsSnapshotSha256)) return { error: 'termsSnapshotSha256 必须是 64 位 SHA-256。' };
  const grantedTime = Date.parse(grantedAt);
  if (!Number.isFinite(grantedTime) || grantedTime > now.valueOf() + 300_000) {
    return { error: 'grantedAt 必须是有效且不晚于当前时间 5 分钟的时间。' };
  }
  if (expiresAt) {
    const expiryTime = Date.parse(expiresAt);
    if (!Number.isFinite(expiryTime) || expiryTime <= now.valueOf()) {
      return { error: 'expiresAt 必须是未来时间或 null。' };
    }
  }
  if (!Array.isArray(input.permittedFields) || !input.permittedFields.length) {
    return { error: 'permittedFields 必须是非空字段数组。' };
  }
  const permittedFields = [...new Set(input.permittedFields.map((field) =>
    typeof field === 'string' ? field.trim() : '',
  ))];
  if (permittedFields.some((field) => !ALLOWED_FIELDS.has(field))) {
    return { error: 'permittedFields 包含未治理字段。' };
  }
  if (REQUIRED_FIELDS.some((field) => !permittedFields.includes(field))) {
    return { error: 'permittedFields 必须包含 title、url、publishedAt。' };
  }
  return {
    dossier: {
      principal,
      sourceType: sourceType as SourceType,
      permittedFields,
      territory,
      evidenceRef,
      evidenceSha256,
      termsVersion,
      termsSnapshotSha256,
      grantedAt: new Date(grantedTime).toISOString(),
      expiresAt: expiresAt ? new Date(Date.parse(expiresAt)).toISOString() : null,
    },
  };
}

export async function createPendingSourceRightsRequest(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    requestedBy: string;
    assertionRef: string;
    sourceVersion: number;
    rightsConfigHash: string;
    idempotencyKey: string;
  },
  now = new Date(),
) {
  const replay = await db.prepare(`
    SELECT id FROM source_rights_requests
    WHERE source_config_id = ? AND request_idempotency_key = ? LIMIT 1
  `).bind(input.sourceConfigId, input.idempotencyKey).first<{ id: string }>();
  if (replay) return { id: replay.id, replayed: true };
  const timestamp = now.toISOString();
  await db.prepare(`
    UPDATE source_rights_requests
    SET status = 'superseded', updated_at = ?
    WHERE source_config_id = ? AND status = 'pending'
  `).bind(timestamp, input.sourceConfigId).run();
  const id = `rights_request_${crypto.randomUUID()}`;
  await db.prepare(`
    INSERT INTO source_rights_requests
      (id, source_config_id, requested_by, status, assertion_ref,
       source_version, rights_config_hash, request_idempotency_key,
       created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.sourceConfigId,
    input.requestedBy,
    input.assertionRef,
    input.sourceVersion,
    input.rightsConfigHash,
    input.idempotencyKey,
    timestamp,
    timestamp,
  ).run();
  return { id, replayed: false };
}

export async function actorCanApproveSourceRights(
  db: SqlDatabase,
  actor: Actor,
) {
  if (actor.role !== 'admin') return false;
  const member = await db.prepare(`
    SELECT user_id FROM team_members
    WHERE user_id = ? AND role = 'admin' AND status = 'active'
      AND can_approve_source_rights = 1
    LIMIT 1
  `).bind(actor.id).first<{ user_id: string }>();
  return Boolean(member);
}

type RightsRequestRow = {
  id: string;
  source_config_id: string;
  requested_by: string;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  assertion_ref: string;
  source_version: number;
  rights_config_hash: string;
  decision: 'approve' | 'reject' | null;
  decision_note: string | null;
  dossier_hash: string | null;
  decided_by: string | null;
  decision_idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
};

const REQUEST_COLUMNS = `
  id, source_config_id, requested_by, status, assertion_ref, source_version,
  rights_config_hash, decision, decision_note, dossier_hash, decided_by,
  decision_idempotency_key,
  created_at, updated_at, decided_at
`;

export function projectPublicSourceRightsRequest(row: RightsRequestRow) {
  return {
    id: row.id,
    sourceConfigId: row.source_config_id,
    requestedBy: row.requested_by,
    status: row.status,
    assertionRef: row.assertion_ref.slice(0, 500),
    sourceVersion: row.source_version,
    decision: row.decision,
    decisionNote: row.decision_note?.slice(0, 1000) ?? null,
    dossierHash: row.dossier_hash,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

export async function listSourceRightsRequests(
  db: SqlDatabase,
  sourceConfigId: string,
) {
  const rows = await db.prepare(`
    SELECT ${REQUEST_COLUMNS} FROM source_rights_requests
    WHERE source_config_id = ?
    ORDER BY created_at DESC, id DESC LIMIT 50
  `).bind(sourceConfigId).all<RightsRequestRow>();
  return rows.results.map(projectPublicSourceRightsRequest);
}

export async function submitSourceRightsRequest(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    expectedSourceVersion: number;
    assertionRef: string;
    note: string;
    idempotencyKey: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const replay = await tx.prepare(`
      SELECT id FROM source_rights_requests
      WHERE source_config_id = ? AND request_idempotency_key = ? LIMIT 1
    `).bind(input.sourceConfigId, input.idempotencyKey).first<{ id: string }>();
    if (replay) {
      const source = await tx.prepare('SELECT version FROM source_configs WHERE id = ? LIMIT 1')
        .bind(input.sourceConfigId).first<{ version: number }>();
      return { status: 200 as const, requestId: replay.id, sourceVersion: source?.version ?? input.expectedSourceVersion, replayed: true };
    }
    const source = await tx.prepare(`
      SELECT id, version, lifecycle_status,
        COALESCE(NULLIF(rights_config_hash, ''), config_hash) AS rights_config_hash
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(input.sourceConfigId).first<{
      id: string; version: number; lifecycle_status: string; rights_config_hash: string;
    }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.version !== input.expectedSourceVersion) {
      return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    }
    if (source.lifecycle_status === 'archived') return { status: 409 as const, error: '已归档来源不能提交权利声明。' };
    if (!source.rights_config_hash) return { status: 409 as const, error: '来源权利配置摘要缺失。' };
    await tx.prepare(`
      UPDATE source_rights_grants SET revoked_at = ?
      WHERE source_config_id = ? AND revoked_at IS NULL
    `).bind(timestamp, source.id).run();
    const nextSourceVersion = source.version + 1;
    const request = await createPendingSourceRightsRequest(tx, {
      sourceConfigId: source.id,
      requestedBy: input.actor.id,
      assertionRef: input.assertionRef,
      sourceVersion: nextSourceVersion,
      rightsConfigHash: source.rights_config_hash,
      idempotencyKey: input.idempotencyKey,
    }, now);
    await tx.prepare(`
      UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
        last_error = '来源权利正在重新审批。', updated_at = ?
      WHERE kind = 'ingestion' AND status IN ('queued', 'retrying')
        AND payload_json ->> 'sourceConfigId' = ?
    `).bind(timestamp, source.id).run();
    await tx.prepare(`
      UPDATE ingestion_runs SET status = 'cancelled', error_code = 'RIGHTS_BLOCKED',
        finished_at = ?
      WHERE source_config_id = ? AND status = 'queued'
    `).bind(timestamp, source.id).run();
    await tx.prepare(`
      UPDATE source_configs
      SET rights_status = 'pending', enabled = 0,
        lifecycle_status = 'draft', health_status = 'unknown',
        next_run_at = NULL, active_run_id = CASE WHEN active_run_id IN (
          SELECT id FROM ingestion_runs WHERE source_config_id = ? AND status = 'cancelled'
        ) THEN NULL ELSE active_run_id END,
        version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(source.id, timestamp, source.id, source.version).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id,
         before_hash, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.rights_requested', 'source_rights_request', ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`,
      input.actor.id,
      input.actor.role,
      request.id,
      stableHash({ sourceVersion: source.version }),
      stableHash({ sourceVersion: nextSourceVersion, rightsConfigHash: source.rights_config_hash }),
      JSON.stringify({ sourceConfigId: source.id, note: input.note, assertionRef: input.assertionRef }),
      crypto.randomUUID(),
      timestamp,
    ).run();
    return { status: 201 as const, requestId: request.id, sourceVersion: nextSourceVersion, replayed: false };
  });
}

export async function decideSourceRightsRequest(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    requestId: string;
    expectedSourceVersion: number;
    decision: 'approve' | 'reject';
    note: string;
    dossier?: SourceRightsDecisionDossier;
    idempotencyKey: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    if (!(await actorCanApproveSourceRights(tx, input.actor))) {
      return { status: 403 as const, error: '当前成员没有独立来源权利审批能力。' };
    }
    const request = await tx.prepare(`
      SELECT ${REQUEST_COLUMNS} FROM source_rights_requests
      WHERE id = ? AND source_config_id = ? FOR UPDATE
    `).bind(input.requestId, input.sourceConfigId).first<RightsRequestRow>();
    if (!request) return { status: 404 as const, error: '权利请求不存在。' };
    if (request.status !== 'pending') {
      if (request.decision_idempotency_key === input.idempotencyKey) {
        return {
          status: 200 as const,
          request: projectPublicSourceRightsRequest(request),
          sourceVersion: request.source_version + 1,
          replayed: true,
        };
      }
      return { status: 409 as const, error: '权利请求已有决定或已被新配置取代。' };
    }
    if (request.requested_by === input.actor.id) {
      return { status: 403 as const, error: '权利声明提交者不能审批自己的请求。' };
    }
    const reused = await tx.prepare(`
      SELECT id FROM source_rights_requests
      WHERE decision_idempotency_key = ? AND id <> ? LIMIT 1
    `).bind(input.idempotencyKey, request.id).first<{ id: string }>();
    if (reused) return { status: 409 as const, error: 'Idempotency-Key 已用于其他权利决定。' };
    const source = await tx.prepare(`
      SELECT id, platform, source_type, retention_mode, lifecycle_status, rights_status,
        version, rights_config_hash
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(input.sourceConfigId).first<{
      id: string;
      platform: string;
      source_type: SourceType;
      retention_mode: 'metadata' | 'raw';
      lifecycle_status: string;
      rights_status: string;
      version: number;
      rights_config_hash: string;
    }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.lifecycle_status === 'archived') return { status: 409 as const, error: '已归档来源不能审批权利。' };
    if (source.version !== input.expectedSourceVersion || source.version !== request.source_version) {
      return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    }
    if (!source.rights_config_hash || source.rights_config_hash !== request.rights_config_hash) {
      return { status: 409 as const, error: '权利请求已因来源配置变化而失效。' };
    }
    if (input.decision === 'approve' && !input.dossier) {
      return { status: 422 as const, error: '批准时必须提供完整权利证据 dossier。' };
    }
    const dossier = input.dossier;
    if (dossier && dossier.sourceType !== source.source_type) {
      return {
        status: 409 as const,
        error: '审批确认的 sourceType 与当前来源配置不一致；请先修改来源并生成新的权利请求。',
      };
    }
    const dossierJson = dossier ? {
      ...dossier,
      provider: source.platform,
      purpose: INGESTION_RIGHTS_PURPOSE,
      usageScope: source.retention_mode === 'raw' ? AUTHORIZED_RAW_SCOPE : NORMALIZED_METADATA_SCOPE,
    } : {};
    const dossierHash = dossier ? stableHash(dossierJson) : null;
    const previousGrant = await tx.prepare(`
      SELECT id, version FROM source_rights_grants
      WHERE source_config_id = ? AND revoked_at IS NULL
      ORDER BY verified_at DESC, id DESC LIMIT 1 FOR UPDATE
    `).bind(source.id).first<{ id: string; version: number }>();
    if (previousGrant) {
      await tx.prepare(`
        UPDATE source_rights_grants SET revoked_at = ?
        WHERE id = ? AND revoked_at IS NULL
      `).bind(timestamp, previousGrant.id).run();
    }
    const nextSourceVersion = source.version + 1;
    let grantId: string | null = null;
    if (input.decision === 'approve' && dossier) {
      grantId = `rights_${crypto.randomUUID()}`;
      await tx.prepare(`
        INSERT INTO source_rights_grants
          (id, source_config_id, principal, provider, permitted_fields_json,
           purpose, usage_scope, territory, evidence_ref, evidence_sha256,
           terms_version, terms_snapshot_sha256, verified_by, granted_at,
           verified_at, expires_at, version, supersedes_grant_id,
           source_version, config_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        grantId,
        source.id,
        dossier.principal,
        source.platform,
        JSON.stringify(dossier.permittedFields),
        INGESTION_RIGHTS_PURPOSE,
        source.retention_mode === 'raw' ? AUTHORIZED_RAW_SCOPE : NORMALIZED_METADATA_SCOPE,
        dossier.territory,
        dossier.evidenceRef,
        dossier.evidenceSha256,
        dossier.termsVersion,
        dossier.termsSnapshotSha256,
        input.actor.id,
        dossier.grantedAt,
        timestamp,
        dossier.expiresAt,
        (previousGrant?.version ?? 0) + 1,
        previousGrant?.id ?? null,
        nextSourceVersion,
        source.rights_config_hash,
        timestamp,
      ).run();
    }
    const nextRequestStatus = input.decision === 'approve' ? 'approved' : 'rejected';
    await tx.prepare(`
      UPDATE source_rights_requests
      SET status = ?, decision = ?, decision_note = ?, dossier_json = ?,
        dossier_hash = ?, decided_by = ?, decision_idempotency_key = ?,
        decided_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).bind(
      nextRequestStatus,
      input.decision,
      input.note,
      JSON.stringify(dossierJson),
      dossierHash,
      input.actor.id,
      input.idempotencyKey,
      timestamp,
      timestamp,
      request.id,
    ).run();
    await tx.prepare(`
      UPDATE source_configs
      SET rights_status = ?, enabled = 0,
        lifecycle_status = 'draft', health_status = 'unknown',
        next_run_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(
      input.decision === 'approve' ? 'approved' : 'revoked',
      timestamp,
      source.id,
      source.version,
    ).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id,
         before_hash, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.rights_decided', 'source_rights_request', ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`,
      input.actor.id,
      input.actor.role,
      request.id,
      stableHash({ status: request.status, sourceVersion: request.source_version }),
      stableHash({ status: nextRequestStatus, dossierHash, grantId }),
      JSON.stringify({
        sourceConfigId: source.id,
        decision: input.decision,
        note: input.note,
        dossierHash,
        grantId,
        sourceType: dossier?.sourceType ?? null,
        sourceVersion: nextSourceVersion,
      }),
      crypto.randomUUID(),
      timestamp,
    ).run();
    const decided = await tx.prepare(`
      SELECT ${REQUEST_COLUMNS} FROM source_rights_requests WHERE id = ?
    `).bind(request.id).first<RightsRequestRow>();
    if (!decided) return { status: 503 as const, error: '权利决定保存失败。' };
    return {
      status: 200 as const,
      request: projectPublicSourceRightsRequest(decided),
      sourceVersion: nextSourceVersion,
      rightsGrantId: grantId,
      replayed: false,
    };
  });
}
