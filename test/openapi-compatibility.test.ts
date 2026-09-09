import assert from 'node:assert/strict';
import test from 'node:test';

import { findOpenApiBreakingChanges } from '../lib/openapi-compatibility.ts';

function document(operation: Record<string, unknown>) {
  return {
    openapi: '3.1.0',
    security: [{ session: [] }],
    paths: { '/sources': { post: operation } },
  };
}

const responseSchema = {
  type: 'object',
  required: ['id', 'state'],
  properties: {
    id: { type: 'string' },
    state: { type: 'string', enum: ['draft', 'active'] },
  },
};

const baselineOperation = {
  parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
  requestBody: {
    required: false,
    content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string' } } } } },
  },
  responses: {
    '201': { content: { 'application/json': { schema: responseSchema } } },
    '409': { description: 'Conflict' },
  },
};

type MutableOperation = {
  security?: unknown[];
  parameters: Array<Record<string, unknown>>;
  requestBody: {
    required: boolean;
    content: Record<string, { schema: Record<string, unknown> }>;
  };
  responses: Record<string, {
    description?: string;
    content?: Record<string, { schema: Record<string, unknown> }>;
  }>;
};

function mutableOperation(): MutableOperation {
  return structuredClone(baselineOperation) as unknown as MutableOperation;
}

void test('compatible additive OpenAPI changes pass', () => {
  const current = mutableOperation();
  const schema = current.responses['201'].content?.['application/json'].schema;
  assert.ok(schema);
  const properties = schema.properties as Record<string, unknown>;
  properties.title = { type: 'string' };
  (schema.required as string[]).push('title');
  assert.deepEqual(findOpenApiBreakingChanges(document(baselineOperation), document(current)), []);
});

void test('status, required, type, enum, and security regressions fail', () => {
  const current = mutableOperation();
  current.security = [];
  current.parameters.push({ name: 'X-New', in: 'header', required: true, schema: { type: 'string' } });
  current.requestBody.required = true;
  current.requestBody.content['application/json'].schema.required = ['url'];
  const response = current.responses['201'].content?.['application/json'].schema;
  const properties = response?.properties as Record<string, Record<string, unknown>>;
  properties.id.type = 'integer';
  properties.state.enum = ['active'];
  delete current.responses['409'];
  const issues = findOpenApiBreakingChanges(document(baselineOperation), document(current));
  assert.ok(issues.some((issue) => issue.includes('security requirements were weakened')));
  assert.ok(issues.some((issue) => issue.includes('required parameter header:X-New was added')));
  assert.ok(issues.some((issue) => issue.includes('request body became required')));
  assert.ok(issues.some((issue) => issue.includes('request.url: request field became required')));
  assert.ok(issues.some((issue) => issue.includes('response 201.id: type changed')));
  assert.ok(issues.some((issue) => issue.includes('enum value "draft" was removed')));
  assert.ok(issues.some((issue) => issue.includes('response status 409 was removed')));
});

void test('operation removal needs an elapsed 90-day deprecation window', () => {
  const removed = { ...document(baselineOperation), paths: { '/sources': {} } };
  const notDeprecated = findOpenApiBreakingChanges(document(baselineOperation), removed, {
    asOf: new Date('2026-09-09T00:00:00Z'),
  });
  assert.equal(notDeprecated.length, 1);

  const deprecated = document({
    ...baselineOperation,
    deprecated: true,
    'x-deprecated-at': '2026-01-01T00:00:00Z',
    'x-sunset-at': '2026-04-01T00:00:00Z',
  });
  assert.deepEqual(findOpenApiBreakingChanges(deprecated, removed, {
    asOf: new Date('2026-09-09T00:00:00Z'),
  }), []);
});
