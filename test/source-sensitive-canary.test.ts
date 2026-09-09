import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  assertNoSensitiveCanary,
  scanSensitiveCanary,
  sensitiveCanaryVariants,
  validateSensitiveCanary,
} from '../lib/source-sensitive-canary.ts';

const canary = 'signal40-test:secret/value+2026';

void test('sensitive canary scanner detects raw and transformed values without returning material', () => {
  const surfaces = sensitiveCanaryVariants(canary).map(({ encoding, value }) => ({
    label: `surface-${encoding}`,
    value: { payload: value },
  }));
  const findings = scanSensitiveCanary(surfaces, canary);
  assert.ok(findings.length >= surfaces.length);
  assert.deepEqual(
    [...new Set(findings.map(({ encoding }) => encoding))].sort(),
    ['base64', 'base64url', 'hex', 'raw', 'url'],
  );
  assert.equal(JSON.stringify(findings).includes(canary), false);
  let message = '';
  try {
    assertNoSensitiveCanary(surfaces, canary);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.match(message, /surface-raw\(raw\)/);
  assert.equal(message.includes(canary), false);
});

void test('sensitive canary scanner accepts clean structured and binary artifacts', () => {
  assert.doesNotThrow(() => assertNoSensitiveCanary([
    { label: 'har', value: { log: { entries: [] } } },
    { label: 'trace', value: new TextEncoder().encode('{"spans":[]}') },
  ], canary));
});

void test('sensitive canary validation rejects weak or multiline markers', () => {
  assert.throws(() => validateSensitiveCanary('short'), /至少 16/);
  assert.throws(() => validateSensitiveCanary('long-enough-canary\n'), /换行/);
});

void test('sensitive canary scanner fails closed on compressed or binary artifacts', () => {
  assert.throws(
    () => assertNoSensitiveCanary([
      { label: 'compressed-har', value: Uint8Array.from([0x1f, 0x8b, 0x08]) },
    ], canary),
    /请先解包/,
  );
  assert.throws(
    () => assertNoSensitiveCanary([
      { label: 'binary-export', value: Uint8Array.from([0x41, 0x00, 0x42]) },
    ], canary),
    /UTF-8 文本/,
  );
});

void test('sensitive canary command remains wired into package scripts and CI', async () => {
  const [packageText, ci] = await Promise.all([
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8'),
    fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText) as { scripts?: Record<string, string> };
  assert.equal(
    packageJson.scripts?.['source:sensitive-canary'],
    'node --experimental-strip-types scripts/verify-source-sensitive-canary.ts',
  );
  assert.match(ci, /SIGNAL40_SOURCE_SCAN_CANARY:/);
  assert.match(ci, /run: npm run source:sensitive-canary/);
});
