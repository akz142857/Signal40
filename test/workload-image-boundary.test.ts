import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

void test('Docker build context excludes local secrets and cloud credential directories', async () => {
  const ignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  for (const required of ['.env', '.env.*', '*.pem', '*.key', '.aws', '.config/gcloud', '.azure', '.npmrc']) {
    assert.ok(ignore.split(/\r?\n/).includes(required), `.dockerignore 缺少 ${required}`);
  }
});

void test('source and render images copy allowlisted paths instead of the workspace', async () => {
  const source = await readFile(new URL('../source-worker/Dockerfile', import.meta.url), 'utf8');
  const render = await readFile(new URL('../render-worker/Dockerfile', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^COPY \. \.$/m);
  assert.doesNotMatch(render, /^COPY \. \.$/m);
  assert.match(source, /SIGNAL40_WORKER_PROFILE=source/);
  assert.match(render, /SIGNAL40_WORKER_PROFILE=render/);
  for (const dockerfile of [source, render]) {
    assert.match(dockerfile, /SIGNAL40_DEPLOYMENT_MODE=production/);
  }
  assert.doesNotMatch(source, /apt-get.*chromium/);
  assert.doesNotMatch(source, /COPY video|media-qc|COPY render-worker \.\/render-worker/);
  assert.match(render, /chromium/);
});

void test('compose gives workers and scheduler explicit environments instead of env_file', async () => {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const sourceSection = compose.split(/\n  source-worker:/)[1]?.split(/\n  scheduler:/)[0] ?? '';
  const renderSection = compose.split(/\n  render-worker:/)[1]?.split(/\n  source-worker:/)[0] ?? '';
  const controlSection = compose.split(/\n  control-plane:/)[1]?.split(/\n  render-worker:/)[0] ?? '';
  const schedulerSection = compose.split(/\n  scheduler:/)[1]?.split(/\nvolumes:/)[0] ?? '';
  assert.doesNotMatch(sourceSection, /env_file/);
  assert.doesNotMatch(renderSection, /env_file/);
  assert.doesNotMatch(schedulerSection, /env_file/);
  assert.doesNotMatch(sourceSection, /OPENAI_API_KEY|YOUTUBE_ACCESS_TOKEN|S3_SECRET_ACCESS_KEY|DATABASE_URL/);
  assert.doesNotMatch(renderSection, /S3_SECRET_ACCESS_KEY|DATABASE_URL/);
  assert.doesNotMatch(controlSection, /SIGNAL40_MARKET_DATA_KEY/);
});

void test('CI builds and scans all workload images with pinned scanners and unique SBOM artifacts', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const verifier = await readFile(new URL('../scripts/verify-workload-image.ts', import.meta.url), 'utf8');
  for (const value of [
    'Dockerfile',
    'source-worker/Dockerfile',
    'render-worker/Dockerfile',
    'signal40-control-plane:ci',
    'signal40-source-worker:ci',
    'signal40-render-worker:ci',
  ]) assert.ok(workflow.includes(value), `CI 镜像矩阵缺少 ${value}`);
  assert.match(workflow, /aquasecurity\/trivy-action@[a-f0-9]{40}/);
  assert.match(workflow, /anchore\/sbom-action@[a-f0-9]{40}/);
  assert.match(workflow, /scanners: secret/);
  assert.match(workflow, /scanners: vuln,misconfig/);
  assert.match(workflow, /artifact-name: signal40-\$\{\{ matrix\.profile \}\}-\$\{\{ github\.sha \}\}\.spdx\.json/);
  assert.match(workflow, /npm run compose:env:verify/);
  assert.match(workflow, /--service scheduler --profile scheduler/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(verifier, /\['image', 'save', image\]/);
  assert.match(verifier, /toString\('base64'\)/);
  assert.match(verifier, /toString\('hex'\)/);
  const runtimeVerifier = await readFile(new URL('../scripts/verify-compose-runtime-env.ts', import.meta.url), 'utf8');
  for (const profile of ['control', 'source', 'render', 'scheduler']) {
    assert.ok(runtimeVerifier.includes(`'${profile}'`), `运行环境矩阵缺少 ${profile}`);
  }
  assert.match(runtimeVerifier, /docker[\s\S]*compose/);
});
