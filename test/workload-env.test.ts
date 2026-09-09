import assert from 'node:assert/strict';
import test from 'node:test';

import {
  controlPlaneWorkerTokens,
  resolveCredentialBrokerEnvironment,
  resolveWorkerEnvironment,
} from '../lib/workload-env.ts';

void test('production workers require an explicit profile and dedicated token', () => {
  assert.throws(() => resolveWorkerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_CONTROL_URL: 'https://control.example.com',
    SIGNAL40_WORKER_TOKEN: 'shared',
  }), /combined Worker|共享 Worker token/);
  assert.throws(() => resolveWorkerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_WORKER_PROFILE: 'source',
    SIGNAL40_CONTROL_URL: 'https://control.example.com',
    SIGNAL40_WORKER_TOKEN: 'shared',
  }), /共享 Worker token/);
  const source = resolveWorkerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_WORKER_PROFILE: 'source',
    SIGNAL40_CONTROL_URL: 'https://control.example.com/',
    SIGNAL40_SOURCE_WORKER_TOKEN: 'source-only',
  });
  assert.deepEqual(source, {
    production: true,
    profile: 'source',
    token: 'source-only',
    controlUrl: 'https://control.example.com',
  });
});

void test('production source and render profiles reject unrelated secrets', () => {
  assert.throws(() => resolveWorkerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_WORKER_PROFILE: 'source',
    SIGNAL40_CONTROL_URL: 'https://control.example.com',
    SIGNAL40_SOURCE_WORKER_TOKEN: 'source-only',
    OPENAI_API_KEY: 'must-not-be-visible',
  }), /OPENAI_API_KEY/);
  assert.throws(() => resolveWorkerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_WORKER_PROFILE: 'render',
    SIGNAL40_CONTROL_URL: 'https://control.example.com',
    SIGNAL40_RENDER_WORKER_TOKEN: 'render-only',
    DATABASE_URL: 'must-not-be-visible',
  }), /DATABASE_URL/);
});

void test('production control plane never falls back to a shared worker token', () => {
  assert.throws(() => controlPlaneWorkerTokens({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_WORKER_TOKEN: 'shared',
  }), /共享 Worker token/);
  assert.deepEqual(controlPlaneWorkerTokens({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_SOURCE_WORKER_TOKEN: 'source-only',
    SIGNAL40_RENDER_WORKER_TOKEN: 'render-only',
  }), { shared: undefined, source: 'source-only', render: 'render-only' });
});

void test('production credential broker requires a dedicated source token and rejects unrelated secrets', () => {
  assert.throws(() => resolveCredentialBrokerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    DATABASE_URL: 'postgres://database/broker',
    SIGNAL40_WORKER_TOKEN: 'shared',
  }), /共享 Worker token/);
  assert.throws(() => resolveCredentialBrokerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    DATABASE_URL: 'postgres://database/broker',
    SIGNAL40_SOURCE_WORKER_TOKEN: 'source-only',
    OPENAI_API_KEY: 'must-not-be-visible',
  }), /OPENAI_API_KEY/);
  assert.deepEqual(resolveCredentialBrokerEnvironment({
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    DATABASE_URL: 'postgres://database/broker',
    SIGNAL40_SOURCE_WORKER_TOKEN: 'source-only',
    SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON: '{}',
    PORT: '3002',
  }), {
    production: true,
    sourceWorkerToken: 'source-only',
    policiesJson: '{}',
    port: 3002,
  });
});
