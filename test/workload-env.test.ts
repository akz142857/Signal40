import assert from 'node:assert/strict';
import test from 'node:test';

import {
  controlPlaneWorkerTokens,
  resolveWorkerEnvironment,
  validateControlPlaneEnvironment,
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

void test('production control plane fails startup when a trust-boundary secret is missing or shared', () => {
  const valid = {
    SIGNAL40_DEPLOYMENT_MODE: 'production',
    SIGNAL40_SOURCE_WORKER_TOKEN: 'source-only',
    SIGNAL40_RENDER_WORKER_TOKEN: 'render-only',
    MEDIA_SIGNING_SECRET: 'a-secure-media-signing-secret-32+',
    SIGNAL40_IDENTITY_HEADER_ID: 'x-auth-user-id',
    SIGNAL40_IDENTITY_HEADER_EMAIL: 'x-auth-user-email',
  };
  assert.doesNotThrow(() => validateControlPlaneEnvironment(valid));
  assert.throws(() => validateControlPlaneEnvironment({ ...valid, MEDIA_SIGNING_SECRET: undefined }), /MEDIA_SIGNING_SECRET/);
  assert.throws(() => validateControlPlaneEnvironment({ ...valid, SIGNAL40_RENDER_WORKER_TOKEN: 'source-only' }), /必须不同/);
  assert.throws(() => validateControlPlaneEnvironment({ ...valid, SIGNAL40_IDENTITY_HEADER_ID: undefined }), /SIGNAL40_IDENTITY_HEADER_ID/);
});
