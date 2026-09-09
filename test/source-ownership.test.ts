import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileSourceOwnership, sourceOwnershipReady, transferSourceOwnership } from '../lib/source-ownership.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T04:00:00.000Z');
const actor = { id: 'admin-primary', role: 'admin' };

async function seedOwnership() {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO team_members (user_id, email, role, status, created_at, updated_at)
    VALUES
      ('owner-editor', 'owner@signal40.test', 'editor', 'active', $1, $1),
      ('owner-next', 'next@signal40.test', 'researcher', 'active', $1, $1),
      ('admin-primary', 'primary@signal40.test', 'admin', 'active', $1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, platform, config_json, rights_status, version,
       lifecycle_status, business_owner_id, created_at, updated_at)
    VALUES ('source-owned', 'Owned feed', 'rss', 'rss', '{}', 'approved', 3,
      'paused', 'owner-editor', $1, $1)
  `, [now.toISOString()]);
  return db;
}

void test('source ownership transfer validates the business owner, version and audit', async () => {
  const db = await seedOwnership();
  const invalid = await transferSourceOwnership(db, {
    sourceId: 'source-owned', expectedVersion: 3, businessOwnerId: 'missing',
    reason: '测试无效负责人', actor,
  }, now);
  assert.equal('error' in invalid, true);
  const transferred = await transferSourceOwnership(db, {
    sourceId: 'source-owned', expectedVersion: 3, businessOwnerId: 'owner-next',
    reason: '调整业务负责人', actor,
  }, now);
  assert.deepEqual(transferred, {
    assignment: { ownerTeamId: 'default', businessOwnerId: 'owner-next' },
    version: 4,
  });
  assert.deepEqual((await db.client.query(
    "SELECT owner_team_id, business_owner_id, version FROM source_configs WHERE id = 'source-owned'",
  )).rows[0], { owner_team_id: 'default', business_owner_id: 'owner-next', version: 4 });
  assert.equal((await db.client.query<{ action: string }>(
    "SELECT action FROM audit_events WHERE entity_id = 'source-owned'",
  )).rows[0].action, 'source.ownership_transferred');
});

void test('ownership reconciliation raises and resolves an actionable attention item', async () => {
  const db = await seedOwnership();
  await db.client.query("UPDATE team_members SET status = 'suspended' WHERE user_id = 'owner-editor'");
  assert.equal((await reconcileSourceOwnership(db, actor, now)).issueCount, 1);
  const attention = await db.client.query(
    "SELECT severity, status FROM attention_items WHERE dedupe_key = 'source_ownership:source-owned'",
  );
  assert.deepEqual(attention.rows[0], { severity: 'warning', status: 'open' });
  await db.client.query("UPDATE team_members SET status = 'active' WHERE user_id = 'owner-editor'");
  assert.equal((await reconcileSourceOwnership(db, actor, new Date(now.valueOf() + 1000))).resolvedCount, 1);
  const ready = await sourceOwnershipReady(db, 'source-owned');
  assert.equal('error' in ready, false);
  if ('error' in ready) return;
  assert.equal(ready.assignment.businessOwnerId, 'owner-editor');
});
