import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sourceApiError } from '../lib/source-api-error.ts';
import { assertNoSensitiveReflection, SourceEgressError } from '../lib/source-egress.ts';
import {
  projectPublicCheckpointCutover,
  projectPublicDeletionRequest,
  projectPublicSourceRecord,
  projectPublicSourceRun,
  projectPublicSourceTestRecord,
} from '../lib/source-public-projection.ts';
import {
  assertNoSensitiveCanary,
  scanSensitiveCanary,
  sensitiveCanaryVariants,
  validateSensitiveCanary,
  type SensitiveCanarySurface,
} from '../lib/source-sensitive-canary.ts';

function artifactPaths(argv: string[]) {
  const paths: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--artifact' || !argv[index + 1]) {
      throw new Error('用法：source:sensitive-canary [--artifact <HAR/log/trace/snapshot/export 文件>]');
    }
    paths.push(argv[index + 1]);
    index += 1;
  }
  return paths;
}

async function publicContractSurfaces(canary: string): Promise<SensitiveCanarySurface[]> {
  const secretUrl = `https://user:${canary}@public.example/feed?format=json&access_token=${encodeURIComponent(canary)}#${encodeURIComponent(canary)}`;
  const source = projectPublicSourceRecord({
    id: 'source-canary', name: 'Canary source', adapter: 'http', platform: 'http_json',
    lifecycle_status: 'enabled', health_status: 'healthy', rights_status: 'approved',
    enabled: 1, version: 1, credential_ref: canary, credential_version: 1,
    checkpoint_version: 1, active_run_id: 'run-canary', last_error_code: 'NETWORK',
    checkpoint_json: { cursor: canary }, checkpoint: canary,
    locator_json: { objectKey: `raw/${canary}` }, capabilities_json: { etag: canary },
    config_json: {
      sourceType: 'market', url: secretUrl,
      mapping: { items: 'data.items', secret: canary },
      pagination: { mode: 'cursor', cursorPath: 'next.cursor', checkpoint: canary },
      credentialRef: canary,
    },
  });
  const sourceTest = projectPublicSourceTestRecord({
    id: 'test-canary', status: 'succeeded',
    preview: [{
      title: 'Public title',
      url: `https://public.example/item?signature=${encodeURIComponent(canary)}`,
      publishedAt: '2026-09-09T00:00:00Z',
      raw: canary,
    }],
    capabilities: {
      conditionalRequests: true,
      finalUrl: `https://public.example/final?api_key=${encodeURIComponent(canary)}`,
      redirectUrl: secretUrl,
      etag: canary,
    },
    error_detail_redacted: canary,
  });
  const run = projectPublicSourceRun({
    id: 'run-canary', status: 'failed', quarantine_status: 'none', trigger: 'manual',
    error_code: 'UPSTREAM_SECRET_REFLECTION', error_json: { body: canary },
    checkpoint_after_json: { cursor: canary }, raw_object_key: `raw/${canary}`,
  });
  const cutover = projectPublicCheckpointCutover({
    id: 'cutover-canary', source_config_id: 'source-canary', scope: 'live', status: 'pending',
    source_version: 1, checkpoint_version_before: 1,
    checkpoint_before_json: { cursor: canary }, checkpoint_after_json: { cursor: canary },
  });
  const deletion = projectPublicDeletionRequest({
    id: 'delete-canary', source_version: 1, status: 'deleting',
    initialized_at: '2026-09-09T00:00:00Z', summary_json: { objectKey: canary },
    last_error_redacted: canary,
  });
  const apiError = sourceApiError(`上游失败：${secretUrl}`, 503, {
    errorCode: 'NETWORK',
  });
  return [
    { label: 'actor-source-api', value: source },
    { label: 'actor-source-test-api', value: sourceTest },
    { label: 'actor-source-run-api', value: run },
    { label: 'actor-checkpoint-cutover-api', value: cutover },
    { label: 'actor-deletion-api', value: deletion },
    { label: 'actor-error-api', value: await apiError.text() },
    { label: 'redacted-audit', value: { action: 'source.tested', metadata: { outcome: 'redacted' } } },
    { label: 'redacted-log', value: 'source request failed errorCode=NETWORK url=[redacted-url]' },
    { label: 'redacted-trace', value: { span: 'source.fetch', attributes: { url: '[redacted-url]' } } },
    { label: 'redacted-snapshot', value: { sourceId: 'source-canary', checkpointVersion: 1 } },
    { label: 'redacted-export', value: { sourceId: 'source-canary', hasCredential: true } },
  ];
}

async function main() {
  const canary = validateSensitiveCanary(
    process.env.SIGNAL40_SOURCE_SCAN_CANARY ?? `signal40-source-scan:${crypto.randomUUID()}`,
  );
  const files = artifactPaths(process.argv.slice(2));
  const surfaces = await publicContractSurfaces(canary);
  for (const file of files) {
    const absolute = path.resolve(file);
    surfaces.push({ label: `artifact:${path.basename(absolute)}`, value: await fs.readFile(absolute) });
  }

  // Prove the scanner itself fails closed before trusting a clean result.
  const selfTest = scanSensitiveCanary(
    sensitiveCanaryVariants(canary).map(({ encoding, value }) => ({
      label: `scanner-self-test-${encoding}`,
      value,
    })),
    canary,
  );
  if (!selfTest.length) throw new Error('敏感值扫描器自检失败：未检出注入值。');

  let reflectionBlocked = false;
  try {
    assertNoSensitiveReflection(
      JSON.stringify({ preview: { summary: canary }, etag: canary }),
      [canary],
    );
  } catch (error) {
    reflectionBlocked = error instanceof SourceEgressError &&
      error.code === 'UPSTREAM_SECRET_REFLECTION';
  }
  if (!reflectionBlocked) {
    throw new Error('Broker 敏感回显门禁自检失败：preview/ETag 注入未被阻断。');
  }

  assertNoSensitiveCanary(surfaces, canary);
  console.log(JSON.stringify({
    status: 'passed',
    scannedSurfaces: surfaces.length,
    suppliedArtifacts: files.length,
    checkedEncodings: sensitiveCanaryVariants(canary).map(({ encoding }) => encoding),
    brokerReflectionGuard: true,
    canaryPrinted: false,
  }));
}

await main();
