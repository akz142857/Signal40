import type { SqlDatabase } from './sql.ts';
import { raiseAttentionItem } from './attention.ts';
import { stableHash } from './hash.ts';

const BUSINESS_OWNER_ROLES = new Set([
  'researcher',
  'editor',
  'producer',
  'publisher',
  'admin',
]);

type OwnershipActor = { id: string; role: string };

export type SourceOwnershipInput = {
  sourceId: string;
  expectedVersion: number;
  businessOwnerId: string;
  reason: string;
  actor: OwnershipActor;
};

type MemberRow = {
  user_id: string;
  email: string;
  role: string;
  status: string;
};

export async function validateSourceOwnershipMembers(
  db: SqlDatabase,
  input: { businessOwnerId: string },
) {
  const businessOwnerId = input.businessOwnerId.trim();
  if (!businessOwnerId) return { error: '业务负责人必填。' } as const;
  const businessOwner = await db.prepare(`
    SELECT user_id, email, role, status FROM team_members
    WHERE user_id = ? LIMIT 1
  `).bind(businessOwnerId).first<MemberRow>();
  if (!businessOwner || businessOwner.status !== 'active' || !BUSINESS_OWNER_ROLES.has(businessOwner.role)) {
    return { error: '业务负责人必须是 active 的 researcher/editor/producer/publisher/admin 成员。' } as const;
  }
  return { assignment: { businessOwnerId }, members: { businessOwner } } as const;
}

export async function sourceOwnershipReady(db: SqlDatabase, sourceId: string) {
  const source = await db.prepare(`
    SELECT business_owner_id FROM source_configs WHERE id = ? LIMIT 1
  `).bind(sourceId).first<{ business_owner_id: string | null }>();
  if (!source) return { error: '来源不存在。' } as const;
  return validateSourceOwnershipMembers(db, {
    businessOwnerId: source.business_owner_id ?? '',
  });
}

export async function transferSourceOwnership(
  db: SqlDatabase,
  input: SourceOwnershipInput,
  now = new Date(),
) {
  const reason = input.reason.trim();
  if (reason.length < 5) return { error: '所有权转移原因至少 5 个字。', status: 422 as const };
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    return { error: 'expectedVersion 必填。', status: 422 as const };
  }
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const source = await tx.prepare(`
      SELECT id, team_id, owner_team_id, version, lifecycle_status, business_owner_id
      FROM source_configs WHERE id = ? FOR UPDATE
    `).bind(input.sourceId).first<{
      id: string;
      team_id: string;
      owner_team_id: string;
      version: number;
      lifecycle_status: string;
      business_owner_id: string | null;
    }>();
    if (!source) return { error: '来源不存在。', status: 404 as const };
    if (source.lifecycle_status === 'archived') return { error: '已归档来源不能转移所有权。', status: 409 as const };
    if (source.version !== input.expectedVersion) {
      return { error: `版本冲突：当前版本为 ${source.version}。`, status: 409 as const };
    }
    const validation = await validateSourceOwnershipMembers(tx, input);
    if ('error' in validation) return { error: validation.error, status: 422 as const };
    const before = { ownerTeamId: source.owner_team_id, businessOwnerId: source.business_owner_id };
    const after = { ownerTeamId: source.team_id, ...validation.assignment };
    const updated = await tx.prepare(`
      UPDATE source_configs SET owner_team_id = ?, business_owner_id = ?,
        version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).bind(after.ownerTeamId, after.businessOwnerId, timestamp, input.sourceId, input.expectedVersion).run();
    if (!updated.meta.changes) return { error: '来源已被其他管理员修改。', status: 409 as const };
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id,
         before_hash, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.ownership_transferred', 'source_config', ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`, input.actor.id, input.actor.role, input.sourceId,
      stableHash(before), stableHash(after), JSON.stringify({ before, after, reason }),
      crypto.randomUUID(), timestamp,
    ).run();
    await tx.prepare(`
      UPDATE attention_items SET status = 'resolved', resolved_by = ?,
        resolved_at = ?, updated_at = ?
      WHERE source_config_id = ? AND kind = 'source_ownership' AND status = 'open'
    `).bind(input.actor.id, timestamp, timestamp, input.sourceId).run();
    return { assignment: after, version: input.expectedVersion + 1 };
  });
}

type OwnershipProjectionRow = {
  id: string;
  name: string;
  business_owner_id: string | null;
  business_owner_email: string | null;
  business_owner_role: string | null;
  business_owner_status: string | null;
};

export async function reconcileSourceOwnership(
  db: SqlDatabase,
  actor: OwnershipActor,
  now = new Date(),
) {
  const rows = await db.prepare(`
    SELECT source.id, source.name, source.business_owner_id,
      owner.email AS business_owner_email, owner.role AS business_owner_role,
      owner.status AS business_owner_status
    FROM source_configs source
    LEFT JOIN team_members owner ON owner.user_id = source.business_owner_id
    WHERE source.lifecycle_status <> 'archived'
    ORDER BY source.id LIMIT 501
  `).all<OwnershipProjectionRow>();
  const timestamp = now.toISOString();
  let issueCount = 0;
  let resolvedCount = 0;
  for (const source of rows.results.slice(0, 500)) {
    const invalid = !source.business_owner_id || source.business_owner_status !== 'active' ||
      !BUSINESS_OWNER_ROLES.has(source.business_owner_role ?? '');
    if (invalid) {
      issueCount += 1;
      await raiseAttentionItem(db, {
        kind: 'source_ownership',
        severity: 'warning',
        sourceConfigId: source.id,
        dedupeKey: `source_ownership:${source.id}`,
        reason: `来源「${source.name}」的业务负责人缺失、已停用或角色不适用。请由 admin 转移负责人。`,
        detail: {
          sourceConfigId: source.id,
          sourceName: source.name,
          handlerRole: 'admin',
          businessOwner: source.business_owner_id ? {
            id: source.business_owner_id,
            email: source.business_owner_email,
            status: source.business_owner_status,
          } : null,
        },
      }, now);
      continue;
    }
    const resolved = await db.prepare(`
      UPDATE attention_items SET status = 'resolved', resolved_by = ?,
        resolved_at = ?, updated_at = ?
      WHERE source_config_id = ? AND kind = 'source_ownership' AND status = 'open'
    `).bind(actor.id, timestamp, timestamp, source.id).run();
    resolvedCount += Number(resolved.meta.changes ?? 0);
  }
  return {
    checked: Math.min(rows.results.length, 500),
    issueCount,
    resolvedCount,
    truncated: rows.results.length > 500,
  };
}
