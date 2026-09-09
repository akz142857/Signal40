import type { SourceType } from './domain.ts';
import type { SqlDatabase } from './sql.ts';
import type { Actor } from './workflow.ts';
import { stableHash } from './workflow.ts';
import type { SourceAdapterName } from './source-adapters.ts';
import { sourceConnectorByPlatform } from './source-connectors/registry.ts';
import { projectPublicHttpUrl } from './source-public-projection.ts';
import { createPendingSourceRightsRequest } from './source-rights-approval.ts';

export type SourceProposalInput = {
  name: string;
  adapter: Extract<SourceAdapterName, 'rss' | 'http'>;
  platform: 'rss' | 'http_json';
  sourceType: SourceType;
  url: string;
  scheduleCron: string | null;
  requestNote: string;
};

type ProposalRow = {
  id: string;
  team_id: string;
  name: string;
  adapter: 'rss' | 'http';
  platform: 'rss' | 'http_json';
  source_type: SourceType;
  url: string;
  schedule_cron: string | null;
  status: 'proposal_pending' | 'proposal_approved' | 'proposal_rejected';
  requested_by: string;
  request_note: string;
  idempotency_key: string;
  decided_by: string | null;
  decision_note: string | null;
  decision_idempotency_key: string | null;
  source_config_id: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
};

export function projectPublicSourceProposal(row: ProposalRow) {
  return {
    id: row.id,
    name: row.name.slice(0, 160),
    adapter: row.adapter,
    platform: row.platform,
    sourceType: row.source_type,
    url: projectPublicHttpUrl(row.url),
    scheduleCron: row.schedule_cron,
    status: row.status,
    requestedBy: row.requested_by,
    requestNote: row.request_note.slice(0, 1000),
    decidedBy: row.decided_by,
    decisionNote: row.decision_note?.slice(0, 1000) ?? null,
    sourceConfigId: row.source_config_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

const PROPOSAL_COLUMNS = `
  id, team_id, name, adapter, platform, source_type, url, schedule_cron,
  status, requested_by, request_note, idempotency_key, decided_by,
  decision_note, decision_idempotency_key, source_config_id,
  created_at, updated_at, decided_at
`;

export async function listSourceProposals(db: SqlDatabase, actor: Actor) {
  const ownOnly = ['researcher', 'editor'].includes(actor.role);
  const rows = await db.prepare(`
    SELECT ${PROPOSAL_COLUMNS}
    FROM source_proposals
    ${ownOnly ? 'WHERE requested_by = ?' : ''}
    ORDER BY created_at DESC, id DESC
    LIMIT 100
  `).bind(...(ownOnly ? [actor.id] : [])).all<ProposalRow>();
  return rows.results.map(projectPublicSourceProposal);
}

export async function createSourceProposal(
  db: SqlDatabase,
  input: SourceProposalInput & { idempotencyKey: string; actor: Actor },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const replay = await tx.prepare(`
      SELECT ${PROPOSAL_COLUMNS}
      FROM source_proposals
      WHERE team_id = 'default' AND requested_by = ? AND idempotency_key = ?
      LIMIT 1
    `).bind(input.actor.id, input.idempotencyKey).first<ProposalRow>();
    if (replay) return { status: 200 as const, proposal: projectPublicSourceProposal(replay), replayed: true };
    const id = `proposal_${crypto.randomUUID()}`;
    await tx.prepare(`
      INSERT INTO source_proposals
        (id, team_id, name, adapter, platform, source_type, url, schedule_cron,
         status, requested_by, request_note, idempotency_key, created_at, updated_at)
      VALUES (?, 'default', ?, ?, ?, ?, ?, ?, 'proposal_pending', ?, ?, ?, ?, ?)
    `).bind(
      id,
      input.name,
      input.adapter,
      input.platform,
      input.sourceType,
      input.url,
      input.scheduleCron,
      input.actor.id,
      input.requestNote,
      input.idempotencyKey,
      timestamp,
      timestamp,
    ).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id,
         after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.proposal_created', 'source_proposal', ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`,
      input.actor.id,
      input.actor.role,
      id,
      stableHash({ status: 'proposal_pending', url: input.url }),
      JSON.stringify({ platform: input.platform, sourceType: input.sourceType }),
      crypto.randomUUID(),
      timestamp,
    ).run();
    const created = await tx.prepare(`
      SELECT ${PROPOSAL_COLUMNS} FROM source_proposals WHERE id = ?
    `).bind(id).first<ProposalRow>();
    if (!created) return { status: 503 as const, error: '来源提案保存失败。' };
    return { status: 201 as const, proposal: projectPublicSourceProposal(created), replayed: false };
  });
}

export async function decideSourceProposal(
  db: SqlDatabase,
  input: {
    proposalId: string;
    decision: 'approve' | 'reject';
    note: string;
    idempotencyKey: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  return db.transaction(async (tx) => {
    const proposal = await tx.prepare(`
      SELECT ${PROPOSAL_COLUMNS} FROM source_proposals WHERE id = ? FOR UPDATE
    `).bind(input.proposalId).first<ProposalRow>();
    if (!proposal) return { status: 404 as const, error: '来源提案不存在。' };
    if (proposal.requested_by === input.actor.id) {
      return { status: 403 as const, error: '提案发起人不能批准或拒绝自己的提案。' };
    }
    if (proposal.status !== 'proposal_pending') {
      if (proposal.decision_idempotency_key === input.idempotencyKey) {
        return { status: 200 as const, proposal: projectPublicSourceProposal(proposal), replayed: true };
      }
      return { status: 409 as const, error: '来源提案已有决定。' };
    }
    const reusedKey = await tx.prepare(`
      SELECT id FROM source_proposals
      WHERE decision_idempotency_key = ? AND id <> ? LIMIT 1
    `).bind(input.idempotencyKey, proposal.id).first<{ id: string }>();
    if (reusedKey) return { status: 409 as const, error: 'Idempotency-Key 已用于其他提案决定。' };

    let sourceConfigId: string | null = null;
    const nextStatus = input.decision === 'approve' ? 'proposal_approved' : 'proposal_rejected';
    if (input.decision === 'approve') {
      const connector = sourceConnectorByPlatform(proposal.platform);
      if (!connector || connector.adapter !== proposal.adapter || connector.availability !== 'available') {
        return { status: 409 as const, error: connector?.unavailableReason ?? '该来源连接器当前不可用。' };
      }
      const locator = { kind: 'url', url: proposal.url };
      const locatorHash = stableHash({ teamId: proposal.team_id, platform: proposal.platform, locator });
      const duplicate = await tx.prepare(`
        SELECT id FROM source_configs
        WHERE team_id = ? AND platform = ?
          AND (locator_hash = ? OR locator_json ->> 'url' = ?)
        LIMIT 1
      `).bind(proposal.team_id, proposal.platform, locatorHash, proposal.url).first<{ id: string }>();
      if (duplicate) return { status: 409 as const, error: '该来源已经登记。' };
      sourceConfigId = `source_${stableHash({ proposalId: proposal.id }).slice(0, 32)}`;
      const config = {
        sourceType: proposal.source_type,
        url: proposal.url,
        mapping: {},
        pagination: proposal.adapter === 'http' ? { mode: 'none' } : undefined,
      };
      const configHash = stableHash({
        platform: proposal.platform,
        adapter: proposal.adapter,
        config,
        credentialVersion: 0,
      });
      const rightsConfigHash = stableHash({
        platform: proposal.platform,
        adapter: proposal.adapter,
        config,
        retention: { mode: 'metadata', days: 30 },
      });
      await tx.prepare(`
        INSERT INTO source_configs
          (id, team_id, owner_team_id, business_owner_id, credential_steward_id,
           name, adapter, platform, config_json, locator_json, locator_hash,
           collection_policy_json, capabilities_json, lifecycle_status,
           health_status, config_hash, rights_config_hash, source_type, rights_status,
           enabled, version, schedule_cron, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 'unknown',
          ?, ?, ?, 'pending', 0, 1, ?, ?, ?)
      `).bind(
        sourceConfigId,
        proposal.team_id,
        proposal.team_id,
        proposal.requested_by,
        input.actor.id,
        proposal.name,
        proposal.adapter,
        proposal.platform,
        JSON.stringify(config),
        JSON.stringify(locator),
        locatorHash,
        JSON.stringify({ scheduleCron: proposal.schedule_cron, mode: 'standard', maxItems: 100 }),
        JSON.stringify(connector.supports),
        configHash,
        rightsConfigHash,
        proposal.source_type,
        proposal.schedule_cron,
        timestamp,
        timestamp,
      ).run();
      await createPendingSourceRightsRequest(tx, {
        sourceConfigId,
        requestedBy: input.actor.id,
        assertionRef: `proposal:${proposal.id}`,
        sourceVersion: 1,
        rightsConfigHash,
        idempotencyKey: `source-proposal:${proposal.id}`,
      }, now);
    }

    await tx.prepare(`
      UPDATE source_proposals
      SET status = ?, decided_by = ?, decision_note = ?,
        decision_idempotency_key = ?, source_config_id = ?,
        decided_at = ?, updated_at = ?
      WHERE id = ? AND status = 'proposal_pending'
    `).bind(
      nextStatus,
      input.actor.id,
      input.note,
      input.idempotencyKey,
      sourceConfigId,
      timestamp,
      timestamp,
      proposal.id,
    ).run();
    await tx.prepare(`
      INSERT INTO audit_events
        (id, actor_id, actor_role, action, entity_type, entity_id,
         before_hash, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, 'source.proposal_decided', 'source_proposal', ?, ?, ?, ?, ?, ?)
    `).bind(
      `audit_${crypto.randomUUID()}`,
      input.actor.id,
      input.actor.role,
      proposal.id,
      stableHash({ status: proposal.status }),
      stableHash({ status: nextStatus, sourceConfigId }),
      JSON.stringify({ decision: input.decision, sourceConfigId }),
      crypto.randomUUID(),
      timestamp,
    ).run();
    const decided = await tx.prepare(`
      SELECT ${PROPOSAL_COLUMNS} FROM source_proposals WHERE id = ?
    `).bind(proposal.id).first<ProposalRow>();
    if (!decided) return { status: 503 as const, error: '来源提案决定保存失败。' };
    return { status: 200 as const, proposal: projectPublicSourceProposal(decided), replayed: false };
  });
}
