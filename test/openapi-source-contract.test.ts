import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

import { SOURCE_API_ERROR_CODES } from '../lib/source-api-error.ts';
import {
  CONNECTOR_ACCEPTANCE_STATES,
  CONNECTOR_RELEASE_MODES,
  INGESTION_QUARANTINE_STATUSES,
  INGESTION_RUN_STATUSES,
  SOURCE_HEALTH_STATUSES,
  SOURCE_LIFECYCLE_STATUSES,
  SOURCE_PROPOSAL_STATUSES,
  SOURCE_RIGHTS_STATUSES,
} from '../lib/source-lifecycle-status.ts';
import { SOURCE_ACTION_ROLES } from '../lib/source-authorization.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string) => unknown };

type OpenApi = {
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, unknown>;
    requestBodies: Record<string, unknown>;
    responses: Record<string, unknown>;
  };
};

function resolveLocalRef(document: unknown, ref: string) {
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((value, key) =>
      value && typeof value === 'object' && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined, document);
}

const SOURCE_ROUTE_PREFIXES = [
  'source-configs/',
  'source-connectors/',
  'source-credentials/',
  'source-proposals/',
  'ingestion-runs/',
  'credential-broker/',
  'pipeline/',
  'worker/source-configs/',
  'worker/legal-deletion-withdrawals/',
  'workers/',
];

function actorSourceRouteToOpenApiPath(route: string) {
  return `/${route
    .replace(/\/route\.ts$/, '')
    .replace('source-configs/[id]', 'source-configs/{sourceId}')
    .replace('source-proposals/[id]', 'source-proposals/{proposalId}')
    .replace('ingestion-runs/[id]', 'ingestion-runs/{ingestionRunId}')
    .replace('worker/source-configs/[id]', 'worker/source-configs/{sourceId}')
    .replace('[connectorId]', '{connectorId}')
    .replace('[version]', '{connectorVersion}')
    .replace('[testId]', '{testId}')
    .replace('[runId]', '{runId}')
    .replace('[cutoverId]', '{cutoverId}')
    .replace('[requestId]', '{requestId}')
    .replace('[holdId]', '{holdId}')
    .replace('[pageKey]', '{pageKey}')
    .replace('[jobId]', '{jobId}')}`;
}

void test('every local OpenAPI reference resolves and source mutations use dedicated request schemas', async () => {
  const [text, files] = await Promise.all([
    readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8'),
    readdir(new URL('../app/api/v1/', import.meta.url), { recursive: true }),
  ]);
  const document = yaml.load(text) as OpenApi;
  const routes = files
    .filter((file) => file.endsWith('/route.ts'))
    .filter((file) => SOURCE_ROUTE_PREFIXES.some((prefix) => file.startsWith(prefix)));
  assert.ok(routes.length > 30);
  for (const route of routes) {
    const source = await readFile(new URL(`../app/api/v1/${route}`, import.meta.url), 'utf8');
    const methods = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\s*\(/g)]
      .map((match) => match[1].toLowerCase());
    assert.ok(methods.length > 0, `${route} must export an HTTP method`);
    const path = actorSourceRouteToOpenApiPath(route);
    assert.ok(document.paths[path], `${route} is missing OpenAPI path ${path}`);
    for (const method of methods) {
      assert.ok(document.paths[path][method], `${method.toUpperCase()} ${path} is missing from OpenAPI`);
    }
  }
  const refs: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === '$ref' && typeof nested === 'string') refs.push(nested);
      visit(nested);
    }
  };
  visit(document);
  assert.ok(refs.length > 200);
  for (const ref of refs) {
    if (ref.startsWith('#/')) assert.notEqual(resolveLocalRef(document, ref), undefined, ref);
  }

  for (const [path, operations] of Object.entries(document.paths)) {
    if (!path.startsWith('/source-')) continue;
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const operation = operations[method] as Record<string, unknown> | undefined;
      if (!operation?.requestBody) continue;
      const requestBody = operation.requestBody as Record<string, unknown>;
      assert.notEqual(
        requestBody.$ref,
        '#/components/requestBodies/JsonBody',
        `${method.toUpperCase()} ${path} must use a dedicated request schema`,
      );
    }
  }
});

void test('source error envelope freezes every connector error emitted by the current implementation', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const schema = document.components.schemas.SourceErrorCode as { enum?: unknown[] };
  assert.deepEqual(schema.enum, [...SOURCE_API_ERROR_CODES]);
  const actualCodes = new Set<string>();
  for (const relative of [
    '../app/api/v1/credential-broker/fetch/route.ts',
    '../app/api/v1/ingestion-runs/[id]/commit/route.ts',
    '../app/api/v1/ingestion-runs/[id]/complete/route.ts',
    '../app/api/v1/ingestion-runs/[id]/raw/route.ts',
    '../app/api/v1/source-configs/[id]/runs/route.ts',
    '../app/api/v1/source-configs/[id]/backfills/route.ts',
    '../app/api/v1/pipeline/recompute/route.ts',
    '../lib/source-egress.ts',
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?:errorCode:\s*|SourceEgressError\([^,]+,\s*)['"]([A-Z][A-Z0-9_]+)['"]/g)) {
      actualCodes.add(match[1]);
    }
  }
  assert.ok(actualCodes.size >= 10);
  const documentedCodes = new Set<unknown>(schema.enum ?? []);
  for (const code of actualCodes) assert.ok(documentedCodes.has(code), code);
});

void test('the source onboarding and ingestion happy path has machine-readable success schemas', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const expected: Array<[string, string, string[]]> = [
    ['/source-configs', 'get', ['200']],
    ['/source-configs', 'post', ['200', '201']],
    ['/source-configs/imports', 'post', ['200', '201']],
    ['/source-configs/{sourceId}', 'get', ['200']],
    ['/source-configs/{sourceId}', 'patch', ['200']],
    ['/source-configs/{sourceId}/tests', 'post', ['200', '202']],
    ['/source-configs/{sourceId}/tests/{testId}', 'get', ['200']],
    ['/source-configs/{sourceId}/tests/{testId}/complete', 'post', ['200']],
    ['/source-configs/{sourceId}/enable', 'post', ['200']],
    ['/source-configs/{sourceId}/runs', 'get', ['200']],
    ['/source-configs/{sourceId}/runs', 'post', ['200', '202']],
    ['/source-configs/{sourceId}/runs/{runId}', 'get', ['200']],
    ['/source-configs/{sourceId}/backfills', 'post', ['200', '202']],
    ['/source-configs/{sourceId}/backfills/estimates', 'post', ['200']],
  ];
  for (const [path, method, statuses] of expected) {
    const operation = document.paths[path]?.[method] as {
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    } | undefined;
    for (const status of statuses) {
      assert.ok(
        operation?.responses?.[status]?.content?.['application/json']?.schema,
        `${method.toUpperCase()} ${path} ${status} needs an application/json schema`,
      );
    }
  }
});

void test('source governance operations have machine-readable success schemas', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const expected: Array<[string, string, string[]]> = [
    ['/source-connectors', 'get', ['200']],
    ['/source-credentials/policies', 'get', ['200']],
    ['/source-connectors/{connectorId}/versions/{connectorVersion}/control', 'get', ['200']],
    ['/source-connectors/{connectorId}/versions/{connectorVersion}/control', 'patch', ['200']],
    ['/source-configs/{sourceId}/ownership', 'patch', ['200']],
    ['/source-configs/{sourceId}/rights', 'get', ['200']],
    ['/source-configs/{sourceId}/rights', 'post', ['200']],
    ['/source-configs/{sourceId}/rights', 'put', ['200', '201']],
    ['/source-configs/{sourceId}/credentials', 'post', ['200']],
    ['/source-configs/{sourceId}/credentials', 'delete', ['200']],
    ['/source-configs/{sourceId}/checkpoint-cutovers', 'get', ['200']],
    ['/source-configs/{sourceId}/checkpoint-cutovers', 'post', ['200', '201']],
    ['/source-configs/{sourceId}/checkpoint-cutovers/{cutoverId}', 'patch', ['200']],
    ['/source-configs/{sourceId}/disconnect', 'post', ['200']],
    ['/source-configs/{sourceId}/archive', 'post', ['200']],
    ['/source-configs/{sourceId}/content-withdrawals', 'get', ['200']],
    ['/source-configs/{sourceId}/content-withdrawals', 'post', ['200', '202']],
    ['/source-configs/{sourceId}/legal-holds', 'get', ['200']],
    ['/source-configs/{sourceId}/legal-holds', 'post', ['200', '201']],
    ['/source-configs/{sourceId}/legal-holds/{holdId}/release', 'post', ['200']],
    ['/source-configs/{sourceId}/content-withdrawals/{requestId}/retry', 'post', ['200']],
    ['/ingestion-runs/{ingestionRunId}/quarantine', 'post', ['200']],
  ];
  for (const [path, method, statuses] of expected) {
    const operation = document.paths[path]?.[method] as {
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    } | undefined;
    for (const status of statuses) {
      assert.ok(
        operation?.responses?.[status]?.content?.['application/json']?.schema,
        `${method.toUpperCase()} ${path} ${status} needs an application/json schema`,
      );
    }
  }
});

void test('source worker protocol operations have machine-readable success schemas', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const expected: Array<[string, string, string, string]> = [
    ['/ingestion-runs/{ingestionRunId}/commit', 'post', '200', 'IngestionCommitResult'],
    ['/ingestion-runs/{ingestionRunId}/pages', 'get', '200', 'IngestionRunRecovery'],
    ['/ingestion-runs/{ingestionRunId}/pages/{pageKey}', 'put', '200', 'IngestionPageCommitResult'],
    ['/ingestion-runs/{ingestionRunId}/complete', 'post', '200', 'IngestionRunCompleteResult'],
    ['/credential-broker/fetch', 'post', '200', 'CredentialBrokerFetchResult'],
    ['/pipeline/recompute', 'post', '200', 'PipelineRecomputeResult'],
    ['/worker/legal-deletion-withdrawals/{jobId}/authorize', 'post', '200', 'SourceWithdrawalAuthorizationResult'],
  ];
  for (const [path, method, status, schemaName] of expected) {
    const operation = document.paths[path]?.[method] as {
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    } | undefined;
    assert.deepEqual(
      operation?.responses?.[status]?.content?.['application/json']?.schema,
      { $ref: `#/components/schemas/${schemaName}` },
      `${method.toUpperCase()} ${path} ${status} must use ${schemaName}`,
    );
  }
});

void test('every documented source error response requires a machine-readable error code', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const envelope = document.components.schemas.SourceErrorEnvelope as {
    required?: unknown[];
  };
  assert.deepEqual(envelope.required, ['error', 'errorCode', 'correlationId']);

  const isSourcePath = (path: string) =>
    path.startsWith('/source-') ||
    path.startsWith('/ingestion-runs/') ||
    path.startsWith('/worker/source-configs/') ||
    path.startsWith('/worker/legal-deletion-withdrawals/') ||
    path === '/credential-broker/fetch' ||
    path === '/pipeline/recompute';
  let documentedErrors = 0;
  for (const [path, operations] of Object.entries(document.paths)) {
    if (!isSourcePath(path)) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = operations[method] as {
        responses?: Record<string, { $ref?: string }>;
      } | undefined;
      for (const [status, response] of Object.entries(operation?.responses ?? {})) {
        if (status.startsWith('2')) continue;
        documentedErrors += 1;
        assert.match(
          response.$ref ?? '',
          /^#\/components\/responses\/Source/,
          `${method.toUpperCase()} ${path} ${status} must use a source-specific error response`,
        );
        const component = resolveLocalRef(document, response.$ref ?? '') as {
          content?: Record<string, { schema?: { $ref?: string } }>;
        } | undefined;
        assert.equal(
          component?.content?.['application/json']?.schema?.$ref,
          '#/components/schemas/SourceErrorEnvelope',
          `${method.toUpperCase()} ${path} ${status} must require SourceErrorEnvelope`,
        );
      }
    }
  }
  assert.ok(documentedErrors >= 80, `expected broad source error coverage, got ${documentedErrors}`);

  const requiredStatuses: Array<[string, string, string[]]> = [
    ['/source-configs', 'post', ['400', '403', '409', '422']],
    ['/source-configs/imports', 'post', ['400', '403', '409', '422', '425', '503']],
    ['/source-configs/{sourceId}/runs', 'post', ['400', '403', '404', '409', '429', '503']],
    ['/source-configs/{sourceId}/backfills', 'post', ['400', '403', '404', '409', '422', '429', '503']],
    ['/source-configs/{sourceId}/backfills/estimates', 'post', ['400', '403', '404', '409', '422']],
    ['/ingestion-runs/{ingestionRunId}/commit', 'post', ['400', '401', '404', '409', '413', '422', '503']],
    ['/ingestion-runs/{ingestionRunId}/complete', 'post', ['400', '401', '404', '409', '422', '503']],
    ['/credential-broker/fetch', 'post', ['400', '401', '409', '422', '503']],
    ['/pipeline/recompute', 'post', ['400', '401', '404', '409', '422', '503']],
    ['/ingestion-runs/{ingestionRunId}/raw', 'put', ['401', '409', '413', '422', '503']],
  ];
  for (const [path, method, statuses] of requiredStatuses) {
    const operation = document.paths[path]?.[method] as {
      responses?: Record<string, unknown>;
    } | undefined;
    for (const status of statuses) {
      assert.ok(operation?.responses?.[status], `${method.toUpperCase()} ${path} must document ${status}`);
    }
  }
});

void test('source control-plane and worker routes do not return untyped error objects', async () => {
  const routes = [
    '../app/api/v1/source-configs/route.ts',
    '../app/api/v1/source-configs/imports/route.ts',
    '../app/api/v1/source-configs/[id]/route.ts',
    '../app/api/v1/source-configs/[id]/tests/route.ts',
    '../app/api/v1/source-configs/[id]/tests/[testId]/route.ts',
    '../app/api/v1/source-configs/[id]/tests/[testId]/complete/route.ts',
    '../app/api/v1/source-configs/[id]/enable/route.ts',
    '../app/api/v1/source-configs/[id]/runs/route.ts',
    '../app/api/v1/source-configs/[id]/runs/[runId]/route.ts',
    '../app/api/v1/source-configs/[id]/backfills/route.ts',
    '../app/api/v1/source-configs/[id]/backfills/estimates/route.ts',
    '../app/api/v1/worker/source-configs/[id]/route.ts',
    '../app/api/v1/worker/legal-deletion-withdrawals/[jobId]/authorize/route.ts',
    '../app/api/v1/source-connectors/route.ts',
    '../app/api/v1/source-credentials/policies/route.ts',
    '../app/api/v1/source-connectors/[connectorId]/versions/[version]/control/route.ts',
    '../app/api/v1/source-configs/[id]/ownership/route.ts',
    '../app/api/v1/source-configs/[id]/rights/route.ts',
    '../app/api/v1/source-configs/[id]/credentials/route.ts',
    '../app/api/v1/source-configs/[id]/checkpoint-cutovers/route.ts',
    '../app/api/v1/source-configs/[id]/checkpoint-cutovers/[cutoverId]/route.ts',
    '../app/api/v1/source-configs/[id]/disconnect/route.ts',
    '../app/api/v1/source-configs/[id]/archive/route.ts',
    '../app/api/v1/source-configs/[id]/content-withdrawals/route.ts',
    '../app/api/v1/source-configs/[id]/content-withdrawals/[requestId]/retry/route.ts',
    '../app/api/v1/source-configs/[id]/legal-holds/route.ts',
    '../app/api/v1/source-configs/[id]/legal-holds/[holdId]/release/route.ts',
    '../app/api/v1/ingestion-runs/[id]/quarantine/route.ts',
    '../app/api/v1/ingestion-runs/[id]/commit/route.ts',
    '../app/api/v1/ingestion-runs/[id]/complete/route.ts',
    '../app/api/v1/ingestion-runs/[id]/raw/route.ts',
    '../app/api/v1/ingestion-runs/[id]/pages/route.ts',
    '../app/api/v1/ingestion-runs/[id]/pages/[pageKey]/route.ts',
    '../app/api/v1/credential-broker/fetch/route.ts',
    '../app/api/v1/pipeline/recompute/route.ts',
  ];
  for (const route of routes) {
    const source = await readFile(new URL(route, import.meta.url), 'utf8');
    assert.doesNotMatch(
      source,
      /Response\.json\(\s*\{\s*error(?:\s*:|\s*,)/,
      `${route} must use sourceApiError/sourceResultError so errorCode is mandatory`,
    );
  }
});

void test('actor source read models are strict allowlists and the worker uses a separate schema', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const actorSchemas = [
    'SourceConfigRecord',
    'PublicSourceConfig',
    'PublicSourceMapping',
    'PublicSourcePagination',
    'SourceTestRecord',
    'PublicSourcePreviewItem',
    'PublicSourceTestCapabilities',
    'SourceRunRecord',
    'CheckpointCutoverRecord',
    'SourceDeletionRequestRecord',
    'SourceCredentialPolicyPublic',
    'SourceCredentialBindingResult',
    'SourceConnectorDescriptor',
    'SourceConnectorRuntime',
    'SourceLegalHoldRecord',
    'IngestionQuarantineResult',
    'SourceRightsRequestRecord',
  ];
  const forbidden = new Set([
    'credential_ref', 'credentialRef', 'checkpoint', 'checkpointJson',
    'checkpoint_json', 'checkpointBeforeJson', 'checkpointAfterJson',
    'checkpoint_before_json', 'checkpoint_after_json', 'cursor', 'etag',
    'objectKey', 'object_key', 'raw', 'rawBody', 'job', 'jobId', 'job_id',
    'pipelineJobId',
    'leaseOwner', 'lease_owner', 'config_json', 'locator', 'locator_json',
    'capabilities_json', 'last_error', 'error_json', 'provider', 'secretEnv',
  ]);
  for (const name of actorSchemas) {
    const schema = document.components.schemas[name] as {
      additionalProperties?: unknown;
      properties?: Record<string, unknown>;
    };
    assert.equal(schema.additionalProperties, false, `${name} must reject undeclared fields`);
    for (const property of Object.keys(schema.properties ?? {})) {
      assert.equal(forbidden.has(property), false, `${name}.${property} is not browser-safe`);
    }
  }

  const workerOperation = document.paths['/worker/source-configs/{sourceId}']?.get as {
    security?: unknown;
    responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  } | undefined;
  assert.deepEqual(workerOperation?.security, [{ sourceWorkerToken: [] }]);
  assert.deepEqual(
    workerOperation?.responses?.['200']?.content?.['application/json']?.schema,
    { $ref: '#/components/schemas/WorkerSourceConfigEnvelope' },
  );

  const actorDetail = await readFile(
    new URL('../app/api/v1/source-configs/[id]/route.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(actorDetail, /authorizeWorker|x-worker-token/);
  const workerSource = await readFile(
    new URL('../render-worker/worker.ts', import.meta.url),
    'utf8',
  );
  assert.match(workerSource, /\/api\/v1\/worker\/source-configs\//);
  assert.doesNotMatch(
    workerSource,
    /fetch\(`\$\{controlUrl\}\/api\/v1\/source-configs\/\$\{encodeURIComponent\(sourceConfigId\)\}`,/,
  );
});

void test('source state families are frozen across runtime and OpenAPI', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const expected = {
    SourceProposalStatus: SOURCE_PROPOSAL_STATUSES,
    SourceLifecycleStatus: SOURCE_LIFECYCLE_STATUSES,
    SourceHealthStatus: SOURCE_HEALTH_STATUSES,
    SourceRightsStatus: SOURCE_RIGHTS_STATUSES,
    IngestionRunStatus: INGESTION_RUN_STATUSES,
    IngestionQuarantineStatus: INGESTION_QUARANTINE_STATUSES,
    ConnectorReleaseMode: CONNECTOR_RELEASE_MODES,
    ConnectorAcceptanceState: CONNECTOR_ACCEPTANCE_STATES,
  } as const;
  for (const [name, values] of Object.entries(expected)) {
    const schema = document.components.schemas[name] as { enum?: unknown[] };
    assert.deepEqual(schema.enum, [...values], `${name} drifted from runtime`);
  }
});

void test('every actor-facing source operation references the executable RBAC matrix', async () => {
  const text = await readFile(new URL('../contracts/openapi.yaml', import.meta.url), 'utf8');
  const document = yaml.load(text) as OpenApi;
  const prefixes = [
    '/source-proposals',
    '/source-configs',
    '/source-connectors',
    '/source-credentials',
    '/ingestion-runs/{ingestionRunId}/quarantine',
  ];
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!prefixes.some((prefix) => path.startsWith(prefix))) continue;
    for (const [method, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const typed = operation as {
        security?: Array<Record<string, unknown>>;
        'x-source-action'?: string;
        'x-source-actions'?: string[];
      };
      if (typed.security?.some((entry) => 'sourceWorkerToken' in entry)) continue;
      const actions = typed['x-source-actions'] ?? (typed['x-source-action'] ? [typed['x-source-action']] : []);
      assert.ok(actions.length, `${method.toUpperCase()} ${path} lacks x-source-action`);
      for (const action of actions) {
        assert.ok(action in SOURCE_ACTION_ROLES, `${method.toUpperCase()} ${path} names unknown action ${action}`);
      }
    }
  }
});
