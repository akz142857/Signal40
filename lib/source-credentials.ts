import type { SqlDatabase } from './sql.ts';
import { sourceConnectorByPlatform } from './source-connectors/registry.ts';
import { stableHash, type Actor } from './workflow.ts';

export type SourceCredentialPolicy = {
  provider: 'environment';
  secretEnv: string;
  targetOrigins: string[];
  headerName: string;
  prefix: string;
};

export type SourceCredentialPolicyPublic = Pick<SourceCredentialPolicy, 'targetOrigins' | 'headerName'> & {
  alias: string;
};

const forbiddenHeaders = new Set([
  'cookie', 'host', 'connection', 'content-length', 'proxy-authorization',
  'transfer-encoding', 'upgrade', 'x-forwarded-for', 'x-forwarded-host',
]);

function canonicalHttpsOrigin(value: unknown) {
  if (typeof value !== 'string') throw new Error('credential target origin 必须是字符串。');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('credential target origin 必须是无路径、无凭据的 HTTPS origin。');
  }
  return url.origin;
}

/** 解析运维侧 allowlist；任何一项不安全时整份配置失败关闭。 */
export function parseSourceCredentialPolicies(raw: string | undefined): Record<string, SourceCredentialPolicy> {
  if (!raw?.trim()) return {};
  let input: unknown;
  try { input = JSON.parse(raw) as unknown; }
  catch { throw new Error('SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON 不是有效 JSON。'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('credential policy 必须是对象。');
  const result: Record<string, SourceCredentialPolicy> = {};
  for (const [alias, value] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(alias)) throw new Error(`credential alias ${alias} 无效。`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`credential policy ${alias} 无效。`);
    const record = value as Record<string, unknown>;
    if (record.provider !== undefined && record.provider !== 'environment') {
      throw new Error(`credential policy ${alias} 的 provider 尚不受支持。`);
    }
    if (typeof record.secretEnv !== 'string' || !/^SIGNAL40_[A-Z0-9_]{1,100}$/.test(record.secretEnv)) {
      throw new Error(`credential policy ${alias} 的 secretEnv 无效。`);
    }
    if (!Array.isArray(record.targetOrigins) || !record.targetOrigins.length || record.targetOrigins.length > 20) {
      throw new Error(`credential policy ${alias} 至少需要一个 target origin。`);
    }
    const targetOrigins = [...new Set(record.targetOrigins.map(canonicalHttpsOrigin))];
    if (typeof record.headerName !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(record.headerName)) {
      throw new Error(`credential policy ${alias} 的 headerName 无效。`);
    }
    if (forbiddenHeaders.has(record.headerName.toLowerCase())) throw new Error(`credential policy ${alias} 使用了禁止的 Header。`);
    const prefix = record.prefix === undefined ? '' : record.prefix;
    if (typeof prefix !== 'string' || prefix.length > 30 || /[\r\n]/.test(prefix)) throw new Error(`credential policy ${alias} 的 prefix 无效。`);
    result[alias] = { provider: 'environment', secretEnv: record.secretEnv, targetOrigins, headerName: record.headerName, prefix };
  }
  return result;
}

export function publicSourceCredentialPolicies(policies: Record<string, SourceCredentialPolicy>): SourceCredentialPolicyPublic[] {
  return Object.entries(policies).map(([alias, policy]) => ({
    alias,
    targetOrigins: policy.targetOrigins,
    headerName: policy.headerName,
  }));
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Invalid stored config is handled as an empty object and cannot match a policy target. */ }
  }
  return {};
}

async function currentRightsGrantId(db: SqlDatabase, sourceConfigId: string) {
  const grant = await db.prepare(`
    SELECT id FROM source_rights_grants
    WHERE source_config_id = ? AND revoked_at IS NULL
    ORDER BY verified_at DESC, id DESC LIMIT 1
  `).bind(sourceConfigId).first<{ id: string }>();
  return grant?.id ?? null;
}

async function cancelUnleasedSourceWork(db: SqlDatabase, sourceConfigId: string, now: string) {
  const jobs = await db.prepare(`
    UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
      last_error = '来源凭据版本已变化。', updated_at = ?
    WHERE kind = 'ingestion' AND payload_json ->> 'sourceConfigId' = ?
      AND status IN ('queued', 'retrying')
  `).bind(now, sourceConfigId).run();
  await db.prepare(`
    UPDATE ingestion_runs SET status = 'cancelled', finished_at = ?, error_code = 'AUTH_REQUIRED'
    WHERE source_config_id = ? AND status = 'queued'
  `).bind(now, sourceConfigId).run();
  await db.prepare(`
    UPDATE source_configs SET active_run_id = NULL
    WHERE id = ? AND active_run_id IN (
      SELECT id FROM ingestion_runs WHERE source_config_id = ? AND status = 'cancelled'
    )
  `).bind(sourceConfigId, sourceConfigId).run();
  return Number(jobs.meta.changes ?? 0);
}

export async function bindSourceCredential(
  db: SqlDatabase,
  input: {
    sourceId: string;
    expectedVersion: number;
    alias: string;
    policy: SourceCredentialPolicy;
    actor: Actor;
    reason: string;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const source = await tx.prepare(`
      SELECT id, team_id, adapter, platform, config_json, version, credential_ref,
        credential_version, lifecycle_status
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(input.sourceId).first<{
      id: string; team_id: string; adapter: string; platform: string; config_json: unknown;
      version: number; credential_ref: string | null; credential_version: number; lifecycle_status: string;
    }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.version !== input.expectedVersion) return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    if (source.lifecycle_status === 'archived') return { status: 409 as const, error: '已归档来源不能绑定凭据。' };
    if (source.adapter !== 'http') return { status: 409 as const, error: '只有 HTTP JSON 来源可以绑定 Secret Header。' };
    const connector = sourceConnectorByPlatform(source.platform);
    if (!connector) return { status: 409 as const, error: '来源连接器不存在。' };
    const config = parseObject(source.config_json);
    const sourceUrl = typeof config.url === 'string' ? new URL(config.url) : null;
    if (!sourceUrl || !input.policy.targetOrigins.includes(sourceUrl.origin)) {
      return { status: 422 as const, error: '来源 URL 不在该 credential alias 的服务端 target allowlist。' };
    }
    if ([...sourceUrl.searchParams.keys()].some((name) => /(^|[_-])(api[_-]?key|token|secret|signature|auth)([_-]|$)/i.test(name))) {
      return { status: 422 as const, error: '来源 URL 疑似在 query 中携带 Secret；请改用 broker Header 注入。' };
    }
    const current = source.credential_ref
      ? await tx.prepare('SELECT id FROM source_credentials WHERE id = ? AND revoked_at IS NULL FOR UPDATE')
        .bind(source.credential_ref).first<{ id: string }>()
      : null;
    const nextCredentialVersion = source.credential_version + 1;
    const nextSourceVersion = source.version + 1;
    const nextConfigHash = stableHash({ platform: source.platform, adapter: source.adapter, config, credentialVersion: nextCredentialVersion });
    if (current) await tx.prepare("UPDATE source_credentials SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(timestamp, timestamp, current.id).run();
    const credentialRef = `cred_${crypto.randomUUID()}`;
    await tx.prepare(`
      INSERT INTO source_credentials
        (id, team_id, source_config_id, connector_id, provider, secret_alias,
         status, version, supersedes_credential_id, target_origins_json,
         header_name, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'environment', ?, 'active', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      credentialRef, source.team_id, source.id, connector.id, input.alias,
      nextCredentialVersion, current?.id ?? null, JSON.stringify(input.policy.targetOrigins),
      input.policy.headerName, input.actor.id, timestamp, timestamp,
    ).run();
    const updated = await tx.prepare(`
      UPDATE source_configs SET credential_ref = ?, credential_version = ?,
        config_hash = ?, enabled = 0, lifecycle_status = 'draft', health_status = 'unknown',
        rights_config_hash = CASE WHEN rights_config_hash = '' THEN config_hash ELSE rights_config_hash END,
        last_tested_config_hash = NULL, last_error = NULL, last_error_code = NULL,
        last_error_detail_redacted = NULL, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(credentialRef, nextCredentialVersion, nextConfigHash, timestamp, source.id, source.version).run();
    if (!updated.meta.changes) return { status: 409 as const, error: '来源已被其他管理员修改。' };
    const rightsGrantId = await currentRightsGrantId(tx, source.id);
    const cancelledJobs = await cancelUnleasedSourceWork(tx, source.id, timestamp);
    await tx.prepare(`
      INSERT INTO source_connection_events
        (id, source_config_id, kind, actor_id, credential_version, detail_redacted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      `source_connection_event_${crypto.randomUUID()}`, source.id, current ? 'rotated' : 'completed',
      input.actor.id, nextCredentialVersion, input.reason.slice(0, 500), timestamp,
    ).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, ?, 'source_credential', ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role,
      current ? 'source_credential.rotated' : 'source_credential.bound', credentialRef,
      source.credential_ref ? stableHash({ ref: source.credential_ref, version: source.credential_version }) : null,
      stableHash({ ref: credentialRef, version: nextCredentialVersion }),
      JSON.stringify({ sourceConfigId: source.id, alias: input.alias, provider: input.policy.provider, connectorId: connector.id, credentialVersion: nextCredentialVersion, targetOrigins: input.policy.targetOrigins, headerName: input.policy.headerName, rightsGrantId, cancelledJobs }),
      crypto.randomUUID(), timestamp,
    ).run();
    return { status: 200 as const, credentialRef, credentialVersion: nextCredentialVersion, sourceVersion: nextSourceVersion, cancelledJobs };
  });
}

export async function revokeSourceCredential(
  db: SqlDatabase,
  input: { sourceId: string; expectedVersion: number; actor: Actor; reason: string },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const source = await tx.prepare(`
      SELECT id, adapter, platform, config_json, version, credential_ref, credential_version
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(input.sourceId).first<{
      id: string; adapter: string; platform: string; config_json: unknown; version: number;
      credential_ref: string | null; credential_version: number;
    }>();
    if (!source) return { status: 404 as const, error: '来源不存在。' };
    if (source.version !== input.expectedVersion) return { status: 409 as const, error: `版本冲突：当前版本为 ${source.version}。` };
    if (!source.credential_ref) return { status: 409 as const, error: '来源没有已绑定凭据。' };
    const nextCredentialVersion = source.credential_version + 1;
    const nextSourceVersion = source.version + 1;
    const config = parseObject(source.config_json);
    const nextConfigHash = stableHash({ platform: source.platform, adapter: source.adapter, config, credentialVersion: nextCredentialVersion });
    await tx.prepare("UPDATE source_credentials SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(timestamp, timestamp, source.credential_ref).run();
    await tx.prepare(`
      UPDATE source_configs SET credential_ref = NULL, credential_version = ?, config_hash = ?,
        rights_config_hash = CASE WHEN rights_config_hash = '' THEN config_hash ELSE rights_config_hash END,
        enabled = 0, lifecycle_status = 'auth_required', health_status = 'auth_required',
        last_tested_config_hash = NULL, last_error = '来源凭据已撤销。', last_error_code = 'AUTH_REQUIRED',
        version = version + 1, updated_at = ? WHERE id = ? AND version = ?
    `).bind(nextCredentialVersion, nextConfigHash, timestamp, source.id, source.version).run();
    const cancelledJobs = await cancelUnleasedSourceWork(tx, source.id, timestamp);
    await tx.prepare(`
      INSERT INTO source_connection_events
        (id, source_config_id, kind, actor_id, credential_version, detail_redacted, created_at)
      VALUES (?, ?, 'revoked', ?, ?, ?, ?)
    `).bind(`source_connection_event_${crypto.randomUUID()}`, source.id, input.actor.id, nextCredentialVersion, input.reason.slice(0, 500), timestamp).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
         metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source_credential.revoked', 'source_credential', ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, source.credential_ref,
      stableHash({ ref: source.credential_ref, version: source.credential_version }),
      JSON.stringify({ sourceConfigId: source.id, credentialVersion: nextCredentialVersion, cancelledJobs }),
      crypto.randomUUID(), timestamp,
    ).run();
    return { status: 200 as const, credentialVersion: nextCredentialVersion, sourceVersion: nextSourceVersion, cancelledJobs };
  });
}

export type CredentialBrokerGrant = {
  credentialRef: string;
  credentialVersion: number;
  sourceConfigId: string;
  connectorId: string;
  secretAlias: string;
  targetOrigins: string[];
  headerName: string;
};

function targetMatchesSourceTemplate(configValue: unknown, targetUrl: string) {
  const config = parseObject(configValue);
  if (typeof config.url !== 'string') return false;
  let base: URL;
  let target: URL;
  try { base = new URL(config.url); target = new URL(targetUrl); }
  catch { return false; }
  if (base.origin !== target.origin || base.pathname !== target.pathname || target.username || target.password || target.hash) return false;
  const pagination = parseObject(config.pagination);
  const dynamicNames = new Set<string>();
  for (const key of ['pageParameter', 'pageSizeParameter', 'cursorParameter', 'sinceParameter']) {
    const name = pagination[key];
    if (typeof name === 'string' && /^[A-Za-z0-9._~-]{1,80}$/.test(name)) dynamicNames.add(name);
  }
  for (const name of new Set(target.searchParams.keys())) {
    if (base.searchParams.has(name)) {
      if (JSON.stringify(base.searchParams.getAll(name)) !== JSON.stringify(target.searchParams.getAll(name))) return false;
    } else if (!dynamicNames.has(name)) return false;
  }
  for (const name of new Set(base.searchParams.keys())) {
    if (JSON.stringify(base.searchParams.getAll(name)) !== JSON.stringify(target.searchParams.getAll(name))) return false;
  }
  return true;
}

/** 只返回 broker 在进程内兑换所需的 opaque metadata；不读取或返回长期 Secret。 */
export async function authorizeCredentialBrokerRequest(
  db: SqlDatabase,
  input: { sourceConfigId: string; credentialRef: string; credentialVersion: number; targetUrl: string },
  now = new Date(),
): Promise<CredentialBrokerGrant | null> {
  const targetOrigin = new URL(input.targetUrl).origin;
  const row = await db.prepare(`
    SELECT c.id, c.version, c.source_config_id, c.connector_id, c.secret_alias,
      c.target_origins_json, c.header_name, s.config_json
    FROM source_credentials c
    JOIN source_configs s ON s.id = c.source_config_id
    WHERE c.id = ? AND c.source_config_id = ? AND c.version = ?
      AND c.status = 'active' AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR c.expires_at > ?)
      AND s.credential_ref = c.id AND s.credential_version = c.version
      AND s.lifecycle_status != 'archived'
    LIMIT 1
  `).bind(input.credentialRef, input.sourceConfigId, input.credentialVersion, now.toISOString()).first<Record<string, unknown>>();
  if (!row) return null;
  const origins = Array.isArray(row.target_origins_json)
    ? row.target_origins_json.filter((value): value is string => typeof value === 'string')
    : [];
  if (!origins.includes(targetOrigin) || !targetMatchesSourceTemplate(row.config_json, input.targetUrl)) return null;
  return {
    credentialRef: String(row.id), credentialVersion: Number(row.version),
    sourceConfigId: String(row.source_config_id), connectorId: String(row.connector_id),
    secretAlias: String(row.secret_alias), targetOrigins: origins, headerName: String(row.header_name),
  };
}

/** 轮换/撤销后，旧租约即使已抓完也只能隔离，不能写文章或推进 checkpoint。 */
export async function quarantineCredentialBlockedIngestion(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    ingestionRunId: string;
    credentialRef: string | null;
    credentialVersion: number;
    reason: string;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  await db.prepare(`
    UPDATE ingestion_runs SET status = 'failed', error_code = 'AUTH_REQUIRED', retryable = 0,
      error_json = ?, quarantine_status = 'held', finished_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).bind(JSON.stringify({ message: input.reason.slice(0, 500) }), timestamp, input.ingestionRunId).run();
  await db.prepare(`
    UPDATE raw_payload_uploads SET state = 'expired', expires_at = ?, delete_after = ?, updated_at = ?
    WHERE ingestion_run_id = ? AND state IN ('initiated', 'uploaded', 'committed', 'aborted')
  `).bind(timestamp, timestamp, timestamp, input.ingestionRunId).run();
  await db.prepare(`
    UPDATE source_configs SET active_run_id = NULL, enabled = 0,
      lifecycle_status = 'auth_required', health_status = 'auth_required',
      last_error = ?, last_error_code = 'AUTH_REQUIRED',
      last_error_detail_redacted = ?, updated_at = ?
    WHERE id = ? AND active_run_id = ?
  `).bind(input.reason.slice(0, 500), input.reason.slice(0, 500), timestamp, input.sourceConfigId, input.ingestionRunId).run();
  await db.prepare(`
    INSERT INTO audit_events
      (id, actor_id, actor_role, action, entity_type, entity_id, metadata_json, request_id, created_at)
    VALUES (?, 'credential-broker', 'admin', 'source_ingestion.credential_blocked',
      'ingestion_run', ?, ?, ?, ?)
  `).bind(
    `audit_${crypto.randomUUID()}`, input.ingestionRunId,
    JSON.stringify({ sourceConfigId: input.sourceConfigId, credentialRef: input.credentialRef, credentialVersion: input.credentialVersion, reason: input.reason.slice(0, 500) }),
    crypto.randomUUID(), timestamp,
  ).run();
}
