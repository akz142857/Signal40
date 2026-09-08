import type { SqlDatabase } from '../lib/sql.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from '../lib/domain.ts';
import { createVideoProject } from '../lib/video-project.ts';
import { computeRenderSnapshotHash, createProjectV2, migrateProjectV1, validateProjectV2, type VideoProjectV2 } from '../lib/project-v2.ts';
import { VIDEO_TEMPLATES } from '../lib/templates.ts';
import { sampleArticles } from './fixtures/sample-articles.ts';
import { assertTransition, parseIfMatch, resolveActor, stableHash, WorkflowError } from '../lib/workflow.ts';
import { sha256Hex } from '../lib/hash.ts';

const now = new Date('2026-09-08T02:00:00.000Z');

function verifiedTopic() {
  const topic = runPipeline(sampleArticles(now), now).find((candidate) => candidate.gate.passed);
  assert.ok(topic);
  return { ...topic, verificationStatus: 'verified' as const };
}

void test('project v2 contains claim evidence, a contiguous timeline, and immutable hashes', () => {
  const project = createProjectV2(verifiedTopic(), now);
  assert.equal(project.schemaVersion, '2.0');
  assert.ok(project.research.claims.every((claim) => claim.evidence.some((evidence) => evidence.stance === 'supports')));
  assert.equal(project.timeline.at(-1)!.startFrame + project.timeline.at(-1)!.durationFrames, 1350);
  assert.equal(project.render.snapshotHash, project.provenance.immutableInputsHash);
  assert.deepEqual(validateProjectV2(project), { valid: true, errors: [] });
});

void test('v1 projects migrate to v2 without losing claims or scenes', () => {
  const legacy = createVideoProject(verifiedTopic());
  const migrated = migrateProjectV1(legacy, now);
  assert.equal(migrated.schemaVersion, '2.0');
  assert.equal(migrated.provenance.sourceProjectVersion, '1.0');
  assert.equal(migrated.research.claims.length, legacy.claims.length);
  assert.equal(migrated.timeline.length, legacy.scenes.length);
  assert.equal(validateProjectV2(migrated).valid, true);
});

void test('state machine rejects skipped gates and unauthorized roles', () => {
  assert.throws(
    () => assertTransition({ from: 'RESEARCHING', to: 'EVIDENCE_READY', role: 'researcher', gates: [] }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'GATE_FAILED',
  );
  assert.throws(
    () => assertTransition({ from: 'EVIDENCE_READY', to: 'EDITOR_APPROVED', role: 'researcher', gates: [{ code: 'G3_MANUAL_RESEARCH', passed: true, reasons: [] }] }),
    (error: unknown) => error instanceof WorkflowError && error.code === 'FORBIDDEN',
  );
});

void test('state machine accepts ordered transitions with required gates', () => {
  assert.doesNotThrow(() =>
    assertTransition({
      from: 'RESEARCHING',
      to: 'EVIDENCE_READY',
      role: 'researcher',
      gates: [
        { code: 'G0_SOURCE_RIGHTS', passed: true, reasons: [] },
        { code: 'G1_INPUT_QUALITY', passed: true, reasons: [] },
        { code: 'G2_AUTO_EVIDENCE', passed: true, reasons: [] },
      ],
    }),
  );
});

void test('ETag parsing and hashes are deterministic', () => {
  assert.equal(parseIfMatch('"12"'), 12);
  assert.equal(parseIfMatch('W/"9"'), 9);
  assert.equal(parseIfMatch('bad'), null);
  assert.equal(stableHash({ b: 2, a: 1 }), stableHash({ a: 1, b: 2 }));
  assert.match(stableHash({ a: 1 }), /^sha256:[a-f0-9]{64}$/);
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

void test('local role simulation is scoped to loopback and production ignores role headers', async () => {
  const unusedDb = {} as SqlDatabase;
  const local = await resolveActor(new Request('http://127.0.0.1/api', { headers: { 'x-signal-role': 'publisher', 'x-signal-actor-id': 'local-publisher' } }), unusedDb);
  assert.deepEqual(local, { id: 'local-publisher', email: 'local@signal40.test', role: 'publisher' });
  const production = await resolveActor(new Request('https://signal40.example/api', { headers: { 'x-signal-role': 'admin' } }), unusedDb);
  assert.equal(production, null);
});

void test('v2 validation detects uncovered facts and broken timelines', () => {
  const project = createProjectV2(verifiedTopic(), now);
  project.research.claims[0].evidence = [];
  project.timeline[1].startFrame += 1;
  const validation = validateProjectV2(project);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('缺少支持证据')));
  assert.ok(validation.errors.some((error) => error.includes('不连续')));
});

void test('v2 validation binds background music to a project asset and safe mix range', () => {
  const project = createProjectV2(verifiedTopic(), now);
  project.audio.music = { assetId: 'missing', objectKey: 'projects/demo/music.mp3', volume: 0.8, loop: true };
  project.audio.mix = { voiceVolume: 1, targetLufs: -6, duckMusicUnderVoice: true };
  const invalid = validateProjectV2(project);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('背景音乐音量')));
  assert.ok(invalid.errors.some((error) => error.includes('项目资产')));
  assert.ok(invalid.errors.some((error) => error.includes('目标响度')));
});

void test('every registered visual template changes and validates the immutable render snapshot', () => {
  const hashes = VIDEO_TEMPLATES.map((template) => {
    const project = createProjectV2(verifiedTopic(), now);
    project.render.templateId = template.id;
    project.render.templateVersion = template.version;
    const hash = computeRenderSnapshotHash(project);
    project.render.snapshotHash = hash;
    project.provenance.immutableInputsHash = hash;
    assert.deepEqual(validateProjectV2(project), { valid: true, errors: [] });
    return hash;
  });
  assert.equal(new Set(hashes).size, VIDEO_TEMPLATES.length);
});

void test('numeric claims require explicit unit, time range, basis, entity, and evidence locator', () => {
  const project = createProjectV2(verifiedTopic(), now);
  project.research.claims[0].kind = 'numeric';
  project.research.claims[0].quantity = { value: 84.84, unit: '', currency: null, timeRange: '', basis: '', entity: '', uncertainty: null };
  project.research.claims[0].evidence[0].locator.value = '';
  const validation = validateProjectV2(project);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('数字声明')));
  assert.ok(validation.errors.some((error) => error.includes('定位信息')));
});

void test('v2 validation rejects unknown fields and malformed nested objects without throwing', () => {
  const project = createProjectV2(verifiedTopic(), now) as VideoProjectV2 & { unexpected?: string };
  project.unexpected = 'must not be silently discarded';
  assert.ok(validateProjectV2(project).errors.some((error) => error.includes('未知字段 unexpected')));
  const malformed = structuredClone(project) as unknown as VideoProjectV2;
  (malformed.research.claims as unknown[]) = [null];
  assert.doesNotThrow(() => validateProjectV2(malformed));
  assert.equal(validateProjectV2(malformed).valid, false);
});
