import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string) => unknown };

void test('governance and source consoles expose the independent legal operator workflow', async () => {
  const [governance, manager] = await Promise.all([
    readFile(new URL('../components/governance-dashboard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/source-manager.tsx', import.meta.url), 'utf8'),
  ]);
  for (const marker of [
    'canManageSourceLegal',
    '来源法律操作人',
    'active legal hold 期间必须保留两名法律操作人',
  ]) assert.ok(governance.includes(marker), marker);
  for (const marker of [
    '法律保全记录',
    '建立保全',
    '解除保全',
    '建立者不能解除自己的保全',
    'actor.canManageSourceLegal',
  ]) assert.ok(manager.includes(marker), marker);
});

void test('team member contract documents both source governance capabilities', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as {
    paths: Record<string, Record<string, {
      requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
      responses?: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    }>>;
    components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
  };
  assert.equal(
    document.paths['/team-members'].post.requestBody?.content?.['application/json']?.schema?.$ref,
    '#/components/schemas/TeamMemberCreate',
  );
  assert.equal(
    document.paths['/team-members/{userId}'].patch.requestBody?.content?.['application/json']?.schema?.$ref,
    '#/components/schemas/TeamMemberUpdate',
  );
  assert.ok(document.components.schemas.TeamMemberCreate.properties?.canManageSourceLegal);
  assert.ok(document.components.schemas.TeamMemberUpdate.properties?.canManageSourceLegal);
  assert.ok(document.components.schemas.TeamMemberListItem.properties?.can_manage_source_legal);
  assert.ok(document.components.schemas.TeamMemberMutation.properties?.canManageSourceLegal);
  assert.equal(
    document.paths['/team-members'].get.responses?.['200']?.content?.['application/json']?.schema?.$ref,
    '#/components/schemas/TeamMemberCollection',
  );
});

void test('legal action routes and membership mutation fail closed on capability loss', async () => {
  const files = await Promise.all([
    readFile(new URL('../app/api/v1/source-configs/[id]/legal-holds/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/v1/source-configs/[id]/legal-holds/[holdId]/release/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/v1/source-configs/[id]/content-withdrawals/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/v1/source-configs/[id]/content-withdrawals/[requestId]/retry/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/v1/team-members/[userId]/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../lib/source-legal-deletion.ts', import.meta.url), 'utf8'),
  ]);
  for (const route of files.slice(0, 4)) {
    assert.ok(route.includes('canManageSourceLegal'), 'legal mutation route must check capability');
  }
  assert.ok(files[4].includes('必须保留至少两名有效法律操作人'));
  assert.ok(files[4].includes('必须保留至少一名有效法律操作人'));
  assert.ok(files[4].includes("ORDER BY user_id FOR UPDATE"));
  assert.ok(files[5].includes("ORDER BY user_id FOR UPDATE"));
});
