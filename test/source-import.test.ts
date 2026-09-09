import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSourceImport, persistSourceImportDrafts } from '../lib/source-import.ts';
import { createMemoryPg } from './pg-memory.ts';

void test('source import parses nested OPML feeds', () => {
  const result = parseSourceImport(`<?xml version="1.0"?><opml version="2.0"><body><outline text="Markets"><outline text="SEC" xmlUrl="https://www.sec.gov/news/pressreleases.rss"/><outline title="Company" xmlUrl="https://example.com/feed.xml"/></outline></body></opml>`);
  assert.equal(result.total, 2);
  assert.deepEqual(result.candidates.map((item) => item.name), ['SEC', 'Company']);
  assert.ok(result.candidates.every((item) => item.platform === 'rss'));
});

void test('source import parses quoted CSV and keeps row-level issues', () => {
  const result = parseSourceImport(`name,url,platform,sourceType,scheduleCron\n"API, Main",https://api.example.com/news,http_json,filing,"0 */2 * * *"\nPrivate,http://127.0.0.1/feed,rss,media,`);
  assert.equal(result.total, 2);
  assert.equal(result.candidates[0].name, 'API, Main');
  assert.equal(result.candidates[0].adapter, 'http');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].row, 3);
  assert.match(result.issues[0].message, /私有网络/);
});

void test('source import supports JSON and newline URLs without guessing blocked platforms', () => {
  const json = parseSourceImport(JSON.stringify({ sources: [{ name: 'JSON API', url: 'https://api.example.com/news', platform: 'json' }] }));
  assert.equal(json.candidates[0].platform, 'http_json');
  const lines = parseSourceImport('First feed\thttps://example.com/one.xml\nhttps://example.net/two.xml');
  assert.deepEqual(lines.candidates.map((item) => item.name), ['First feed', 'example.net']);
  assert.ok(lines.candidates.every((item) => item.platform === 'rss'));
});

void test('source import reports duplicate and invalid source metadata per row', () => {
  const result = parseSourceImport(`name,url,platform,sourceType\nOne,https://example.com/feed,rss,media\nDuplicate,https://example.com/feed,rss,media\nBlocked,https://example.com/x,wechat,social\nBad type,https://example.com/y,rss,unknown`);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.issues.map((item) => item.row), [3, 4, 5]);
});

void test('bulk source persistence creates audited drafts and skips existing locators', async () => {
  const db = await createMemoryPg();
  const parsed = parseSourceImport('SEC\thttps://www.sec.gov/news/pressreleases.rss');
  const now = new Date('2026-09-09T01:00:00.000Z');
  const first = await db.transaction((tx) => persistSourceImportDrafts(tx, {
    actor: { id: 'admin-1', role: 'admin' }, candidates: parsed.candidates,
    idempotencyKey: 'bulk-1', now,
  }));
  assert.equal(first.created.length, 1);
  assert.equal(first.requiresIndividualTestAndEnable, true);
  const source = await db.client.query('SELECT lifecycle_status, enabled, source_type, rights_status FROM source_configs WHERE id = $1', [first.created[0].sourceId]);
  assert.deepEqual(source.rows[0], { lifecycle_status: 'draft', enabled: 0, source_type: 'media', rights_status: 'pending' });
  const grants = await db.client.query('SELECT COUNT(*) AS total FROM source_rights_grants WHERE source_config_id = $1 AND revoked_at IS NULL', [first.created[0].sourceId]);
  assert.equal(Number((grants.rows[0] as { total: number }).total), 0);
  const requests = await db.client.query('SELECT status, requested_by FROM source_rights_requests WHERE source_config_id = $1', [first.created[0].sourceId]);
  assert.deepEqual(requests.rows, [{ status: 'pending', requested_by: 'admin-1' }]);
  const audit = await db.client.query("SELECT metadata_json FROM audit_events WHERE action = 'source.created' AND entity_id = $1", [first.created[0].sourceId]);
  assert.equal((audit.rows[0] as { metadata_json: { bulkImportKey: string } }).metadata_json.bulkImportKey, 'bulk-1');

  const second = await db.transaction((tx) => persistSourceImportDrafts(tx, {
    actor: { id: 'admin-1', role: 'admin' }, candidates: parsed.candidates,
    idempotencyKey: 'bulk-2', now,
  }));
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped[0].sourceId, first.created[0].sourceId);
});
