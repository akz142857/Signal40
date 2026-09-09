import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actorCanApproveSourceRights,
  createPendingSourceRightsRequest,
  decideSourceRightsRequest,
  parseSourceRightsDecisionDossier,
  submitSourceRightsRequest,
} from '../lib/source-rights-approval.ts';
import { stableHash } from '../lib/workflow.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T08:00:00.000Z');
const evidenceSha256 = 'a'.repeat(64);
const termsSnapshotSha256 = 'b'.repeat(64);
const dossierInput = {
  principal: 'Example Publisher Ltd.',
  sourceType: 'media',
  permittedFields: ['title', 'url', 'publishedAt', 'summary', 'author'],
  territory: 'global',
  evidenceRef: 'legal-dossier://source/example-feed/2026-09-09',
  evidenceSha256,
  termsVersion: 'public-feed-terms/2026-09-01',
  termsSnapshotSha256,
  grantedAt: new Date(now.valueOf() - 60_000).toISOString(),
  expiresAt: new Date(now.valueOf() + 86_400_000).toISOString(),
};

async function seedPending() {
  const db = await createMemoryPg();
  const timestamp = now.toISOString();
  await db.client.query(`
    INSERT INTO team_members
      (user_id, email, role, status, can_approve_source_rights, created_at, updated_at)
    VALUES
      ('requester', 'requester@test', 'admin', 'active', 1, $1, $1),
      ('approver', 'approver@test', 'admin', 'active', 1, $1, $1),
      ('ordinary-admin', 'ordinary@test', 'admin', 'active', 0, $1, $1)
  `, [timestamp]);
  const config = { sourceType: 'media', url: 'https://example.com/feed.xml', mapping: {} };
  const rightsConfigHash = stableHash({
    platform: 'rss', adapter: 'rss', config, retention: { mode: 'metadata', days: 30 },
  });
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, platform, config_json, config_hash, rights_config_hash,
       source_type, rights_status, enabled, lifecycle_status, health_status,
       created_at, updated_at)
    VALUES ('source-rights-approval', 'Example feed', 'rss', 'rss', $1,
      'operational-hash', $2, 'media', 'pending', 0, 'draft', 'unknown', $3, $3)
  `, [JSON.stringify(config), rightsConfigHash, timestamp]);
  const request = await createPendingSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval',
    requestedBy: 'requester',
    assertionRef: 'provisional:test',
    sourceVersion: 1,
    rightsConfigHash,
    idempotencyKey: 'rights-request-1',
  }, now);
  return { db, request, rightsConfigHash };
}

void test('rights dossier parser requires governed fields and tamper hashes', () => {
  const parsed = parseSourceRightsDecisionDossier(dossierInput, now);
  assert.equal('error' in parsed, false);
  assert.match(
    (parseSourceRightsDecisionDossier({ ...dossierInput, evidenceSha256: 'not-a-hash' }, now) as { error: string }).error,
    /evidenceSha256/,
  );
  assert.match(
    (parseSourceRightsDecisionDossier({ ...dossierInput, sourceType: 'self-declared-trust' }, now) as { error: string }).error,
    /sourceType/,
  );
  assert.match(
    (parseSourceRightsDecisionDossier({ ...dossierInput, credentialRef: 'secret-ref' }, now) as { error: string }).error,
    /未定义字段/,
  );
  assert.match(
    (parseSourceRightsDecisionDossier({ ...dossierInput, permittedFields: ['title'] }, now) as { error: string }).error,
    /必须包含/,
  );
  assert.match(
    (parseSourceRightsDecisionDossier({ ...dossierInput, permittedFields: [...dossierInput.permittedFields, 'credentialRef'] }, now) as { error: string }).error,
    /未治理字段/,
  );
});

void test('only a distinct active admin with explicit rights capability can create a verified grant', async () => {
  const { db, request, rightsConfigHash } = await seedPending();
  const requester = { id: 'requester', email: 'requester@test', role: 'admin' as const };
  const ordinary = { id: 'ordinary-admin', email: 'ordinary@test', role: 'admin' as const };
  const approver = { id: 'approver', email: 'approver@test', role: 'admin' as const };
  assert.equal(await actorCanApproveSourceRights(db, requester), true);
  assert.equal(await actorCanApproveSourceRights(db, ordinary), false);

  const dossier = parseSourceRightsDecisionDossier(dossierInput, now);
  assert.equal('error' in dossier, false);
  if ('error' in dossier) return;
  const self = await decideSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval', requestId: request.id,
    expectedSourceVersion: 1, decision: 'approve', note: '提交者不能批准自己的来源权利请求。',
    dossier: dossier.dossier, idempotencyKey: 'self-decision', actor: requester,
  }, now);
  assert.deepEqual(self, { status: 403, error: '权利声明提交者不能审批自己的请求。' });
  const noCapability = await decideSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval', requestId: request.id,
    expectedSourceVersion: 1, decision: 'approve', note: '普通管理员不应拥有隐式权利批准能力。',
    dossier: dossier.dossier, idempotencyKey: 'ordinary-decision', actor: ordinary,
  }, now);
  assert.deepEqual(noCapability, { status: 403, error: '当前成员没有独立来源权利审批能力。' });

  const mismatchedType = await decideSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval', requestId: request.id,
    expectedSourceVersion: 1, decision: 'approve', note: '审批者不能静默改变冻结请求中的来源类型。',
    dossier: { ...dossier.dossier, sourceType: 'filing' },
    idempotencyKey: 'mismatched-type-decision', actor: approver,
  }, now);
  assert.deepEqual(mismatchedType, {
    status: 409,
    error: '审批确认的 sourceType 与当前来源配置不一致；请先修改来源并生成新的权利请求。',
  });

  const approved = await decideSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval', requestId: request.id,
    expectedSourceVersion: 1, decision: 'approve', note: '已独立核对来源条款、证据快照和允许字段。',
    dossier: dossier.dossier, idempotencyKey: 'approve-decision', actor: approver,
  }, now);
  assert.equal('error' in approved, false);
  if ('error' in approved) return;
  assert.equal(approved.replayed, false);
  assert.equal(approved.sourceVersion, 2);
  const source = await db.client.query("SELECT rights_status, enabled, version, rights_config_hash FROM source_configs WHERE id = 'source-rights-approval'");
  assert.deepEqual(source.rows[0], { rights_status: 'approved', enabled: 0, version: 2, rights_config_hash: rightsConfigHash });
  const grants = await db.client.query(`
    SELECT verified_by, source_version, config_hash, evidence_ref, evidence_sha256,
      terms_version, terms_snapshot_sha256, revoked_at
    FROM source_rights_grants WHERE source_config_id = 'source-rights-approval'
  `);
  assert.deepEqual(grants.rows, [{
    verified_by: 'approver', source_version: 2, config_hash: rightsConfigHash,
    evidence_ref: dossierInput.evidenceRef, evidence_sha256: evidenceSha256,
    terms_version: dossierInput.termsVersion, terms_snapshot_sha256: termsSnapshotSha256,
    revoked_at: null,
  }]);
  const storedRequest = await db.client.query('SELECT status, requested_by, decided_by, dossier_json, dossier_hash FROM source_rights_requests WHERE id = $1', [request.id]);
  const stored = storedRequest.rows[0] as { status: string; requested_by: string; decided_by: string; dossier_json: unknown; dossier_hash: string };
  assert.equal(stored.status, 'approved');
  assert.equal(stored.requested_by, 'requester');
  assert.equal(stored.decided_by, 'approver');
  assert.equal((stored.dossier_json as { sourceType: string }).sourceType, 'media');
  assert.equal(JSON.stringify(stored.dossier_json).includes('snapshot contents'), false);
  assert.equal(typeof stored.dossier_hash, 'string');

  const replay = await decideSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval', requestId: request.id,
    expectedSourceVersion: 1, decision: 'approve', note: '已独立核对来源条款、证据快照和允许字段。',
    dossier: dossier.dossier, idempotencyKey: 'approve-decision', actor: approver,
  }, new Date(now.valueOf() + 1_000));
  assert.equal('error' in replay, false);
  if ('error' in replay) assert.fail(replay.error);
  else assert.equal(replay.replayed, true);
  assert.equal(Number(((await db.client.query("SELECT COUNT(*) AS total FROM source_rights_grants WHERE source_config_id = 'source-rights-approval'")).rows[0] as { total: number }).total), 1);
});

void test('stale rights requests fail closed and a rejection never creates a grant', async () => {
  const first = await seedPending();
  await first.db.client.query("UPDATE source_configs SET version = 2, rights_config_hash = 'changed' WHERE id = 'source-rights-approval'");
  const stale = await decideSourceRightsRequest(first.db, {
    sourceConfigId: 'source-rights-approval', requestId: first.request.id,
    expectedSourceVersion: 2, decision: 'reject', note: '配置已经改变，旧的权利请求不能继续处理。',
    idempotencyKey: 'stale-reject', actor: { id: 'approver', email: 'approver@test', role: 'admin' },
  }, now);
  assert.equal('error' in stale, true);
  if ('error' in stale) assert.equal(stale.status, 409);

  const second = await seedPending();
  const rejected = await decideSourceRightsRequest(second.db, {
    sourceConfigId: 'source-rights-approval', requestId: second.request.id,
    expectedSourceVersion: 1, decision: 'reject', note: '没有足够证据证明允许按约定用途持续采集。',
    idempotencyKey: 'reject-decision', actor: { id: 'approver', email: 'approver@test', role: 'admin' },
  }, now);
  assert.equal('error' in rejected, false);
  const source = await second.db.client.query("SELECT rights_status, enabled FROM source_configs WHERE id = 'source-rights-approval'");
  assert.deepEqual(source.rows[0], { rights_status: 'revoked', enabled: 0 });
  assert.equal(Number(((await second.db.client.query('SELECT COUNT(*) AS total FROM source_rights_grants')).rows[0] as { total: number }).total), 0);
});

void test('re-submitting a provisional assertion revokes the old grant without self-approving the new request', async () => {
  const { db, request } = await seedPending();
  const parsed = parseSourceRightsDecisionDossier(dossierInput, now);
  if ('error' in parsed) assert.fail(parsed.error);
  else {
    await decideSourceRightsRequest(db, {
      sourceConfigId: 'source-rights-approval', requestId: request.id,
      expectedSourceVersion: 1, decision: 'approve', note: '先建立一份有效授权用于重新声明测试。',
      dossier: parsed.dossier, idempotencyKey: 'initial-approval',
      actor: { id: 'approver', email: 'approver@test', role: 'admin' },
    }, now);
  }
  const submitted = await submitSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval', expectedSourceVersion: 2,
    assertionRef: 'legal-dossier:renewal-2026-09-09',
    note: '条款版本发生变化，重新提交权利材料等待独立核验。',
    idempotencyKey: 'renewal-request',
    actor: { id: 'requester', email: 'requester@test', role: 'admin' },
  }, new Date(now.valueOf() + 1_000));
  assert.equal('error' in submitted, false);
  if ('error' in submitted) return;
  assert.equal(submitted.sourceVersion, 3);
  const source = await db.client.query("SELECT rights_status, enabled, version FROM source_configs WHERE id = 'source-rights-approval'");
  assert.deepEqual(source.rows[0], { rights_status: 'pending', enabled: 0, version: 3 });
  const grants = await db.client.query("SELECT revoked_at FROM source_rights_grants WHERE source_config_id = 'source-rights-approval'");
  assert.equal((grants.rows[0] as { revoked_at: string }).revoked_at, new Date(now.valueOf() + 1_000).toISOString());
  const pending = await db.client.query("SELECT requested_by, source_version, status FROM source_rights_requests WHERE source_config_id = 'source-rights-approval' AND status = 'pending'");
  assert.deepEqual(pending.rows, [{ requested_by: 'requester', source_version: 3, status: 'pending' }]);

  const replay = await submitSourceRightsRequest(db, {
    sourceConfigId: 'source-rights-approval', expectedSourceVersion: 2,
    assertionRef: 'legal-dossier:renewal-2026-09-09',
    note: '条款版本发生变化，重新提交权利材料等待独立核验。',
    idempotencyKey: 'renewal-request',
    actor: { id: 'requester', email: 'requester@test', role: 'admin' },
  }, new Date(now.valueOf() + 2_000));
  assert.equal('error' in replay, false);
  if ('error' in replay) assert.fail(replay.error);
  else assert.equal(replay.replayed, true);
});
