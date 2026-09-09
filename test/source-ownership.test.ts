import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileSourceOwnership,
  sourceOwnershipReady,
  transferSourceOwnership,
} from '../lib/source-ownership.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T04:00:00.000Z');
const actor = { id: 'admin-primary', role: 'admin' };

async function seedOwnership() {
  const db = await createMemoryPg();
  await db.client.query(
    `
      INSERT INTO team_members
        (user_id, email, role, status, created_at, updated_at)
      VALUES
        ('owner-editor', 'owner@signal40.test', 'editor', 'active', $1, $1),
        ('admin-primary', 'primary@signal40.test', 'admin', 'active', $1, $1),
        ('admin-backup', 'backup@signal40.test', 'admin', 'active', $1, $1),
        ('admin-suspended', 'suspended@signal40.test', 'admin', 'suspended', $1, $1)
    `,
    [now.toISOString()],
  );
  await db.client.query(
    `
      INSERT INTO source_configs
        (id, name, adapter, platform, config_json, rights_status, version,
         lifecycle_status, business_owner_id, credential_steward_id,
         backup_admin_id, created_at, updated_at)
      VALUES ('source-owned', 'Owned feed', 'rss', 'rss', '{}', 'approved', 3,
        'paused', 'owner-editor', 'admin-primary', 'admin-backup', $1, $1)
    `,
    [now.toISOString()],
  );
  return db;
}

void test('source ownership transfer is role validated, version guarded and audited', async () => {
  const db = await seedOwnership();
  const invalid = await transferSourceOwnership(
    db,
    {
      sourceId: 'source-owned',
      expectedVersion: 3,
      businessOwnerId: 'owner-editor',
      credentialStewardId: 'admin-suspended',
      backupAdminId: 'admin-backup',
      reason: '测试无效凭据管理员',
      actor,
    },
    now,
  );
  assert.deepEqual(invalid, {
    error: '凭据管理员必须是 active admin。',
    status: 422,
  });

  const transferred = await transferSourceOwnership(
    db,
    {
      sourceId: 'source-owned',
      expectedVersion: 3,
      businessOwnerId: 'owner-editor',
      credentialStewardId: 'admin-backup',
      backupAdminId: 'admin-primary',
      reason: '轮换主要和备用管理员',
      actor,
    },
    now,
  );
  assert.deepEqual(transferred, {
    assignment: {
      ownerTeamId: 'default',
      businessOwnerId: 'owner-editor',
      credentialStewardId: 'admin-backup',
      backupAdminId: 'admin-primary',
    },
    version: 4,
  });
  const source = await db.client.query(
    `SELECT owner_team_id, business_owner_id, credential_steward_id,
      backup_admin_id, version FROM source_configs WHERE id = 'source-owned'`,
  );
  assert.deepEqual(source.rows[0], {
    owner_team_id: 'default',
    business_owner_id: 'owner-editor',
    credential_steward_id: 'admin-backup',
    backup_admin_id: 'admin-primary',
    version: 4,
  });
  const audit = await db.client.query(
    "SELECT action, metadata_json FROM audit_events WHERE entity_id = 'source-owned'",
  );
  const auditRow = audit.rows[0] as {
    action: string;
    metadata_json: string | Record<string, unknown>;
  };
  assert.equal(auditRow.action, 'source.ownership_transferred');
  const auditMetadata =
    typeof auditRow.metadata_json === 'string'
      ? JSON.parse(auditRow.metadata_json)
      : auditRow.metadata_json;
  assert.equal(
    auditMetadata.reason,
    '轮换主要和备用管理员',
  );
  const stale = await transferSourceOwnership(
    db,
    {
      sourceId: 'source-owned',
      expectedVersion: 3,
      businessOwnerId: 'owner-editor',
      credentialStewardId: 'admin-primary',
      reason: '使用过期版本修改',
      actor,
    },
    now,
  );
  assert.deepEqual(stale, { error: '版本冲突：当前版本为 4。', status: 409 });
});

void test('ownership reconciliation raises linked actionable attention and resolves it after recovery', async () => {
  const db = await seedOwnership();
  await db.client.query(
    "UPDATE source_configs SET credential_ref = 'credential_opaque' WHERE id = 'source-owned'",
  );
  await db.client.query(
    "UPDATE team_members SET status = 'suspended' WHERE user_id = 'admin-primary'",
  );
  const projected = await reconcileSourceOwnership(db, actor, now);
  assert.deepEqual(projected, {
    checked: 1,
    issueCount: 1,
    resolvedCount: 0,
    truncated: false,
  });
  const attention = await db.client.query(
    `SELECT kind, severity, source_config_id, reason, detail_json, status
     FROM attention_items WHERE dedupe_key = 'source_ownership:source-owned'`,
  );
  const attentionRow = attention.rows[0] as {
    kind: string;
    severity: string;
    source_config_id: string;
    reason: string;
    detail_json: string | Record<string, unknown>;
  };
  assert.equal(attentionRow.kind, 'source_ownership');
  assert.equal(attentionRow.severity, 'critical');
  assert.equal(attentionRow.source_config_id, 'source-owned');
  assert.match(attentionRow.reason, /admin/);
  const detail =
    typeof attentionRow.detail_json === 'string'
      ? JSON.parse(attentionRow.detail_json)
      : attentionRow.detail_json;
  assert.equal(detail.handlerRole, 'admin');
  assert.equal(detail.businessOwner.email, 'owner@signal40.test');

  const blocked = await sourceOwnershipReady(db, 'source-owned');
  assert.equal('error' in blocked, true);
  await db.client.query(
    "UPDATE team_members SET status = 'active' WHERE user_id = 'admin-primary'",
  );
  const ready = await sourceOwnershipReady(db, 'source-owned');
  assert.equal('assignment' in ready, true);
  const recovered = await reconcileSourceOwnership(
    db,
    actor,
    new Date(now.valueOf() + 1000),
  );
  assert.equal(recovered.resolvedCount, 1);
  const resolved = await db.client.query(
    "SELECT status, resolved_by FROM attention_items WHERE dedupe_key = 'source_ownership:source-owned'",
  );
  assert.deepEqual(resolved.rows[0], {
    status: 'resolved',
    resolved_by: 'admin-primary',
  });
});
