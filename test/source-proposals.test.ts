import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSourceProposal,
  decideSourceProposal,
  listSourceProposals,
} from '../lib/source-proposals.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T04:00:00.000Z');
const researcher = { id: 'researcher-1', email: 'r@signal40.test', role: 'researcher' as const };
const otherResearcher = { id: 'researcher-2', email: 'r2@signal40.test', role: 'researcher' as const };
const admin = { id: 'admin-1', email: 'a@signal40.test', role: 'admin' as const };

void test('researcher proposal stays separate from source lifecycle until another actor approves it', async () => {
  const db = await createMemoryPg();
  const created = await createSourceProposal(db, {
    name: 'Example Feed',
    adapter: 'rss',
    platform: 'rss',
    sourceType: 'media',
    url: 'https://example.com/feed.xml',
    scheduleCron: '0 */2 * * *',
    requestNote: '请将这个公开财经 RSS 加入每日监测。',
    idempotencyKey: 'proposal-create-1',
    actor: researcher,
  }, now);
  assert.equal('error' in created, false);
  if ('error' in created) return;
  assert.equal(created.proposal.status, 'proposal_pending');
  assert.equal(Number(((await db.client.query('SELECT COUNT(*) AS total FROM source_configs')).rows[0] as { total: number }).total), 0);
  assert.equal((await listSourceProposals(db, researcher)).length, 1);
  assert.equal((await listSourceProposals(db, otherResearcher)).length, 0);
  assert.equal((await listSourceProposals(db, admin)).length, 1);

  const selfDecision = await decideSourceProposal(db, {
    proposalId: created.proposal.id,
    decision: 'approve',
    note: '不应允许提案人审批自己的来源。',
    idempotencyKey: 'proposal-self-decision',
    actor: { ...admin, id: researcher.id },
  }, now);
  assert.deepEqual(selfDecision, { status: 403, error: '提案发起人不能批准或拒绝自己的提案。' });

  const decided = await decideSourceProposal(db, {
    proposalId: created.proposal.id,
    decision: 'approve',
    note: '已确认这是可审核的公开 RSS，创建待配置来源。',
    idempotencyKey: 'proposal-decision-1',
    actor: admin,
  }, now);
  assert.equal('error' in decided, false);
  if ('error' in decided) return;
  assert.equal(decided.proposal.status, 'proposal_approved');
  assert.ok(decided.proposal.sourceConfigId);
  const source = await db.client.query(
    'SELECT lifecycle_status, health_status, rights_status, enabled, business_owner_id FROM source_configs WHERE id = $1',
    [decided.proposal.sourceConfigId],
  );
  assert.deepEqual(source.rows[0], {
    lifecycle_status: 'draft',
    health_status: 'unknown',
    rights_status: 'pending',
    enabled: 0,
    business_owner_id: researcher.id,
  });
  assert.equal(Number(((await db.client.query('SELECT COUNT(*) AS total FROM source_rights_grants')).rows[0] as { total: number }).total), 0);
  const rightsRequest = await db.client.query('SELECT status, requested_by FROM source_rights_requests WHERE source_config_id = $1', [decided.proposal.sourceConfigId]);
  assert.deepEqual(rightsRequest.rows, [{ status: 'pending', requested_by: admin.id }]);
  const auditActors = await db.client.query(
    "SELECT action, actor_id FROM audit_events WHERE entity_type = 'source_proposal' ORDER BY created_at, action",
  );
  assert.deepEqual(auditActors.rows, [
    { action: 'source.proposal_created', actor_id: researcher.id },
    { action: 'source.proposal_decided', actor_id: admin.id },
  ]);
});

void test('proposal creation and decisions are idempotent without creating duplicate drafts', async () => {
  const db = await createMemoryPg();
  const input = {
    name: 'Idempotent Feed', adapter: 'rss' as const, platform: 'rss' as const,
    sourceType: 'media' as const, url: 'https://example.com/idempotent.xml',
    scheduleCron: null, requestNote: '为了团队的财经选题监测，请审核这个来源。',
    idempotencyKey: 'proposal-create-idempotent', actor: researcher,
  };
  const first = await createSourceProposal(db, input, now);
  const replay = await createSourceProposal(db, input, new Date(now.valueOf() + 1_000));
  assert.equal('error' in first, false);
  assert.equal('error' in replay, false);
  if ('error' in first || 'error' in replay) return;
  assert.equal(replay.replayed, true);
  assert.equal(replay.proposal.id, first.proposal.id);
  const decision = {
    proposalId: first.proposal.id, decision: 'approve' as const,
    note: '由独立管理员确认后创建待配置来源。',
    idempotencyKey: 'proposal-decision-idempotent', actor: admin,
  };
  const approved = await decideSourceProposal(db, decision, now);
  const approvedReplay = await decideSourceProposal(db, decision, new Date(now.valueOf() + 2_000));
  assert.equal('error' in approved, false);
  assert.equal('error' in approvedReplay, false);
  if ('error' in approved || 'error' in approvedReplay) return;
  assert.equal(approvedReplay.replayed, true);
  assert.equal(Number(((await db.client.query('SELECT COUNT(*) AS total FROM source_configs')).rows[0] as { total: number }).total), 1);
});

void test('public web and platform feed proposals use the same governed workflow', async () => {
  const db = await createMemoryPg();
  const cases = [
    { platform: 'web_page' as const, adapter: 'web' as const, url: 'https://example.com/hot' },
    { platform: 'wechat' as const, adapter: 'rss' as const, url: 'https://example.com/wechat.xml' },
    { platform: 'xiaohongshu' as const, adapter: 'rss' as const, url: 'https://example.com/xhs.xml' },
  ];
  for (const [index, item] of cases.entries()) {
    const created = await createSourceProposal(db, {
      ...item,
      name: `Public source ${index}`,
      sourceType: 'social',
      scheduleCron: null,
      requestNote: '已确认该公开 URL 可进入来源权利审核流程。',
      idempotencyKey: `public-source-proposal-${index}`,
      actor: researcher,
    }, now);
    assert.equal('error' in created, false);
  }
  assert.equal((await listSourceProposals(db, researcher)).length, 3);
});
