import assert from 'node:assert/strict';
import test from 'node:test';
import { enqueueIngestionRun, leaseNextJob } from '../lib/control-plane.ts';
import {
  authorizeCredentialBrokerRequest,
  bindSourceCredential,
  parseSourceCredentialPolicies,
  publicSourceCredentialPolicies,
  quarantineCredentialBlockedIngestion,
  revokeSourceCredential,
} from '../lib/source-credentials.ts';
import { stableHash } from '../lib/workflow.ts';
import { assertNoSensitiveReflection } from '../lib/source-egress.ts';
import { createMemoryPg } from './pg-memory.ts';

const now = new Date('2026-09-09T05:00:00.000Z');
const actor = { id: 'admin-credential', email: 'admin@signal40.test', role: 'admin' as const };
const config = {
  sourceType: 'market',
  url: 'https://api.example.com/news',
  mapping: { items: 'items', title: 'title', url: 'url', publishedAt: 'publishedAt' },
  pagination: { mode: 'page', pageParameter: 'page', pageSizeParameter: 'limit' },
};
const initialHash = stableHash({ platform: 'http_json', adapter: 'http', config, credentialVersion: 0 });
const rawPolicies = JSON.stringify({
  'market-data': {
    provider: 'environment', secretEnv: 'SIGNAL40_MARKET_DATA_KEY',
    targetOrigins: ['https://api.example.com'], headerName: 'Authorization', prefix: 'Bearer ',
  },
});

async function seedSource(id: string) {
  const db = await createMemoryPg();
  await db.client.query(`
    INSERT INTO source_configs
      (id, name, adapter, platform, config_json, config_hash, source_type,
       rights_status, enabled, lifecycle_status, health_status, created_at, updated_at)
    VALUES ($1, 'Market API', 'http', 'http_json', $2, $3, 'market',
      'approved', 0, 'draft', 'unknown', $4, $4)
  `, [id, JSON.stringify(config), initialHash, now.toISOString()]);
  await db.client.query(`
    INSERT INTO source_rights_grants
      (id, source_config_id, principal, provider, permitted_fields_json, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       source_version, config_hash, created_at)
    VALUES ($1, $2, 'admin-credential', 'http_json', '["title","url","publishedAt"]',
      'finance-editorial-ingestion', 'normalized-metadata', 'confirmation', 'v1',
      'admin-credential', $3, $3, 1, $4, $3)
  `, [`rights-${id}`, id, now.toISOString(), initialHash]);
  return db;
}

void test('credential policy parser fails closed and public projection never exposes provider lookup material', () => {
  const policies = parseSourceCredentialPolicies(rawPolicies);
  assert.deepEqual(publicSourceCredentialPolicies(policies), [{
    alias: 'market-data',
    targetOrigins: ['https://api.example.com'], headerName: 'Authorization',
  }]);
  assert.equal(JSON.stringify(publicSourceCredentialPolicies(policies)).includes('SIGNAL40_MARKET_DATA_KEY'), false);
  assert.throws(() => parseSourceCredentialPolicies(JSON.stringify({ bad: {
    secretEnv: 'SIGNAL40_BAD', targetOrigins: ['http://api.example.com'], headerName: 'Authorization',
  } })), /HTTPS origin/);
  assert.throws(() => parseSourceCredentialPolicies(JSON.stringify({ bad: {
    secretEnv: 'SIGNAL40_BAD', targetOrigins: ['https://api.example.com'], headerName: 'Cookie',
  } })), /禁止/);
  assert.throws(() => assertNoSensitiveReflection('{"debug":"secret-value"}', ['secret-value']), /响应已丢弃/);
  assert.doesNotThrow(() => assertNoSensitiveReflection('{"items":[]}', ['secret-value']));
});

void test('binding stores only opaque metadata, leaves legal rights immutable, and broker authorization is source/version/origin bound', async () => {
  const db = await seedSource('source-credential-bind');
  const policy = parseSourceCredentialPolicies(rawPolicies)['market-data'];
  const bound = await bindSourceCredential(db, {
    sourceId: 'source-credential-bind', expectedVersion: 1, alias: 'market-data', policy,
    actor, reason: 'bind organization credential',
  }, now);
  assert.equal('error' in bound, false);
  if ('error' in bound) return;
  assert.equal(bound.credentialVersion, 1);
  const source = (await db.client.query(`
    SELECT credential_ref, credential_version, version, enabled, lifecycle_status,
      last_tested_config_hash FROM source_configs WHERE id = 'source-credential-bind'
  `)).rows[0] as Record<string, unknown>;
  assert.deepEqual(source, {
    credential_ref: bound.credentialRef, credential_version: 1, version: 2,
    enabled: 0, lifecycle_status: 'draft', last_tested_config_hash: null,
  });
  const stored = (await db.client.query('SELECT * FROM source_credentials WHERE id = $1', [bound.credentialRef])).rows[0] as Record<string, unknown>;
  assert.equal(stored.secret_alias, 'market-data');
  assert.equal(JSON.stringify(stored).includes('SIGNAL40_MARKET_DATA_KEY'), false);
  assert.equal(JSON.stringify(stored).includes('super-secret-value'), false);
  const grant = await authorizeCredentialBrokerRequest(db, {
    sourceConfigId: 'source-credential-bind', credentialRef: bound.credentialRef,
    credentialVersion: 1, targetUrl: 'https://api.example.com/news?page=2',
  }, now);
  assert.equal(grant?.secretAlias, 'market-data');
  assert.equal(await authorizeCredentialBrokerRequest(db, {
    sourceConfigId: 'source-credential-bind', credentialRef: bound.credentialRef,
    credentialVersion: 1, targetUrl: 'https://attacker.example/news',
  }, now), null);
  assert.equal(await authorizeCredentialBrokerRequest(db, {
    sourceConfigId: 'source-credential-bind', credentialRef: bound.credentialRef,
    credentialVersion: 1, targetUrl: 'https://api.example.com/admin?page=2',
  }, now), null);
  assert.equal(await authorizeCredentialBrokerRequest(db, {
    sourceConfigId: 'source-credential-bind', credentialRef: bound.credentialRef,
    credentialVersion: 1, targetUrl: 'https://api.example.com/news?unexpected=1',
  }, now), null);
  const grants = await db.client.query("SELECT revoked_at, source_version, config_hash, verified_by FROM source_rights_grants WHERE source_config_id = 'source-credential-bind' ORDER BY source_version");
  assert.deepEqual(grants.rows, [{ revoked_at: null, source_version: 1, config_hash: initialHash, verified_by: 'admin-credential' }]);
});

void test('credential version is frozen into job/run, and rotation prevents stale leasing', async () => {
  const db = await seedSource('source-credential-run');
  const policy = parseSourceCredentialPolicies(rawPolicies)['market-data'];
  const first = await bindSourceCredential(db, {
    sourceId: 'source-credential-run', expectedVersion: 1, alias: 'market-data', policy,
    actor, reason: 'initial binding',
  }, now);
  assert.equal('error' in first, false);
  if ('error' in first) return;
  await db.client.query(`
    UPDATE source_configs SET enabled = 1, lifecycle_status = 'enabled', health_status = 'healthy'
    WHERE id = 'source-credential-run'
  `);
  const queued = await enqueueIngestionRun(db, {
    sourceConfigId: 'source-credential-run', idempotencyKey: 'credential-run', actor,
  }, new Date(now.valueOf() + 1_000));
  const jobPayload = (await db.client.query('SELECT payload_json FROM jobs WHERE id = $1', [queued.id])).rows[0] as { payload_json: Record<string, unknown> };
  assert.equal(jobPayload.payload_json.credentialRef, first.credentialRef);
  assert.equal(jobPayload.payload_json.credentialVersion, 1);
  const run = (await db.client.query('SELECT credential_ref, credential_version FROM ingestion_runs WHERE id = $1', [queued.ingestionRunId])).rows[0];
  assert.deepEqual(run, { credential_ref: first.credentialRef, credential_version: 1 });

  const rotated = await bindSourceCredential(db, {
    sourceId: 'source-credential-run', expectedVersion: 2, alias: 'market-data', policy,
    actor, reason: 'rotate compromised upstream key',
  }, new Date(now.valueOf() + 2_000));
  assert.equal('error' in rotated, false);
  const staleJob = (await db.client.query('SELECT status FROM jobs WHERE id = $1', [queued.id])).rows[0] as { status: string };
  assert.equal(staleJob.status, 'cancelled');
  const lease = await leaseNextJob(db, {
    workerId: 'source-worker', kinds: ['ingestion'], capabilities: ['source:http-json'], capabilityProtocolVersions: { 'source:http-json': 2 }, maxPayloadSchemaVersion: 2,
  }, new Date(now.valueOf() + 3_000));
  assert.equal(lease, null);
});

void test('revocation disables source and makes the previously issued broker binding unusable', async () => {
  const db = await seedSource('source-credential-revoke');
  const policy = parseSourceCredentialPolicies(rawPolicies)['market-data'];
  const bound = await bindSourceCredential(db, {
    sourceId: 'source-credential-revoke', expectedVersion: 1, alias: 'market-data', policy,
    actor, reason: 'initial binding',
  }, now);
  assert.equal('error' in bound, false);
  if ('error' in bound) return;
  const revoked = await revokeSourceCredential(db, {
    sourceId: 'source-credential-revoke', expectedVersion: 2, actor, reason: 'provider key revoked',
  }, new Date(now.valueOf() + 1_000));
  assert.equal('error' in revoked, false);
  assert.equal(await authorizeCredentialBrokerRequest(db, {
    sourceConfigId: 'source-credential-revoke', credentialRef: bound.credentialRef,
    credentialVersion: 1, targetUrl: 'https://api.example.com/news',
  }, new Date(now.valueOf() + 2_000)), null);
  const source = (await db.client.query("SELECT credential_ref, credential_version, enabled, lifecycle_status, health_status FROM source_configs WHERE id = 'source-credential-revoke'")).rows[0];
  assert.deepEqual(source, { credential_ref: null, credential_version: 2, enabled: 0, lifecycle_status: 'auth_required', health_status: 'auth_required' });
});

void test('a leased stale credential result is quarantined without normalized writes or checkpoint advance', async () => {
  const db = await seedSource('source-credential-stale');
  await db.client.query(`
    UPDATE source_configs SET enabled = 1, lifecycle_status = 'enabled', active_run_id = 'run-stale'
    WHERE id = 'source-credential-stale'
  `);
  await db.client.query(`
    INSERT INTO ingestion_runs
      (id, source_config_id, status, credential_ref, credential_version, created_at)
    VALUES ('run-stale', 'source-credential-stale', 'running', 'cred-old', 1, $1)
  `, [now.toISOString()]);
  await db.client.query(`
    INSERT INTO raw_payload_uploads
      (id, source_config_id, ingestion_run_id, state, object_key, sha256, byte_size,
       created_at, updated_at, expires_at, delete_after)
    VALUES ('raw-stale', 'source-credential-stale', 'run-stale', 'uploaded',
      'sources/stale/raw.json', 'hash', 10, $1, $1, $2, $2)
  `, [now.toISOString(), new Date(now.valueOf() + 60_000).toISOString()]);
  await db.transaction((tx) => quarantineCredentialBlockedIngestion(tx, {
    sourceConfigId: 'source-credential-stale', ingestionRunId: 'run-stale',
    credentialRef: 'cred-old', credentialVersion: 1, reason: 'credential rotated',
  }, new Date(now.valueOf() + 1_000)));
  assert.equal(((await db.client.query("SELECT status FROM ingestion_runs WHERE id = 'run-stale'")).rows[0] as { status: string }).status, 'failed');
  assert.equal(((await db.client.query("SELECT state FROM raw_payload_uploads WHERE id = 'raw-stale'")).rows[0] as { state: string }).state, 'expired');
  assert.equal(Number(((await db.client.query('SELECT COUNT(*) AS total FROM articles')).rows[0] as { total: number }).total), 0);
  const source = (await db.client.query("SELECT checkpoint_version, active_run_id, lifecycle_status FROM source_configs WHERE id = 'source-credential-stale'")).rows[0];
  assert.deepEqual(source, { checkpoint_version: 0, active_run_id: null, lifecycle_status: 'auth_required' });
});
