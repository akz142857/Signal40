import assert from 'node:assert/strict';
import test from 'node:test';
import {
  independentEvidenceCount,
  evaluateSocialEvidenceDataset,
  maximumIndependentEvidenceMatching,
  parseSocialEvidencePolicy,
  SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY,
  socialEvidenceCalibrationPasses,
} from '../lib/social-evidence.ts';
import { recordSourceOriginCorrection } from '../lib/source-origin-corrections.ts';
import { createMemoryPg } from './pg-memory.ts';

void test('independent evidence uses maximum bipartite matching rather than set-size minimum', () => {
  assert.equal(maximumIndependentEvidenceMatching([
    { familyId: 'f1', publisherGroupId: 'g1' },
    { familyId: 'f2', publisherGroupId: 'g1' },
    { familyId: 'f3', publisherGroupId: 'g2' },
    { familyId: 'f3', publisherGroupId: 'g3' },
  ]), 2);
});

void test('managed unknown origins and social signals fail closed until correction and approved policy', () => {
  const base = {
    source: 'Social account', sourceType: 'social', contentHash: 'hash', platform: 'wechat',
    evidenceFamilyId: 'family-1', publisherEntityId: 'publisher-1', publisherOwnershipGroup: 'group-1',
    originManaged: true, originRelationship: 'unknown' as const, originConfidence: 0,
  };
  assert.equal(independentEvidenceCount([base]), 0);
  const corrected = { ...base, originRelationship: 'original' as const, originConfidence: 95, originManuallyCorrected: true };
  assert.equal(independentEvidenceCount([corrected], SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY), 0);
  assert.equal(independentEvidenceCount([corrected], {
    version: 'social-evidence/approved-1', minimumConfidence: 90,
    eligibleRelationships: ['original'], socialAutoProductionEnabled: true,
  }), 1);
});

void test('social evidence calibration requires frozen error, recall, sample and production thresholds', () => {
  const policy = {
    version: 'social-evidence/1', minimumConfidence: 90,
    eligibleRelationships: ['original'], socialAutoProductionEnabled: true,
    maximumFalseIndependentRate: 0.02, minimumIndependentRecall: 0.8,
    minimumProductionSampleSize: 30,
  };
  assert.equal(socialEvidenceCalibrationPasses(100, policy, {
    falseIndependentRate: 0.01, independentRecall: 0.9, productionSampleSize: 30,
  }), true);
  assert.equal(socialEvidenceCalibrationPasses(100, policy, {
    falseIndependentRate: 0.03, independentRecall: 0.9, productionSampleSize: 30,
  }), false);
  assert.equal(parseSocialEvidencePolicy({
    ...policy,
    eligibleRelationships: ['original', 'syndicated'],
  }), null);
});

void test('labelled-set evaluation reports false-independent rate and recall separately', () => {
  const policy = { version: 'approved', minimumConfidence: 90, eligibleRelationships: ['original'] as const, socialAutoProductionEnabled: true };
  const qualified = (suffix: string) => ({
    source: suffix, sourceType: 'social', contentHash: suffix, platform: 'wechat',
    evidenceFamilyId: `family-${suffix}`, publisherOwnershipGroup: `group-${suffix}`,
    originManaged: true, originRelationship: 'original' as const, originConfidence: 95,
    originManuallyCorrected: true,
  });
  const metrics = evaluateSocialEvidenceDataset([
    { id: 'tp', independent: true, productionSample: true, origins: [qualified('a'), qualified('b')] },
    { id: 'fn', independent: true, productionSample: false, origins: [qualified('a')] },
    { id: 'fp', independent: false, productionSample: true, origins: [qualified('c'), qualified('d')] },
    { id: 'tn', independent: false, productionSample: false, origins: [] },
  ], policy);
  assert.equal(metrics.falseIndependentRate, 0.5);
  assert.equal(metrics.independentRecall, 0.5);
  assert.equal(metrics.productionSampleSize, 2);
});

void test('origin correction is immutable, audited and enqueues a topic recompute', async () => {
  const db = await createMemoryPg();
  const now = new Date('2026-09-09T08:00:00.000Z');
  await db.client.exec(`
    INSERT INTO publisher_entities (id, legal_name, ownership_group, entity_type, created_at, updated_at)
    VALUES ('publisher-a', 'Publisher A', 'group-a', 'company', '${now.toISOString()}', '${now.toISOString()}');
    INSERT INTO source_item_origins
      (id, source_config_id, namespace, platform_item_id, article_id, ingestion_run_id,
       canonical_url_hash, fingerprint_version, content_fingerprint, relationship,
       evidence_family_id, publisher_entity_id, confidence, first_seen_at, last_seen_at)
    VALUES ('origin-a', 'source-a', 'rss', 'item-a', 'article-a', 'run-a', 'url',
      'content-v1', 'content', 'unknown', 'generated-family', 'source-a', 0,
      '${now.toISOString()}', '${now.toISOString()}');
  `);
  const actor = { id: 'editor-a', email: 'editor@example.com', role: 'editor' as const };
  const first = await recordSourceOriginCorrection(db, {
    originId: 'origin-a', relationship: 'original', evidenceFamilyId: 'family-a',
    publisherEntityId: 'publisher-a', confidence: 95,
    reason: '已对照发行主体原文和所有权目录完成修正。', actor,
  }, now);
  assert.equal(first.status, 201);
  const second = await recordSourceOriginCorrection(db, {
    originId: 'origin-a', relationship: 'syndicated', evidenceFamilyId: 'family-a',
    publisherEntityId: 'publisher-a', confidence: 100,
    reason: '复核后确认该条目属于获得授权的同步转载。', actor,
  }, new Date(now.valueOf() + 1000));
  assert.equal(second.status, 201);
  const corrections = await db.client.query("SELECT relationship, supersedes_correction_id FROM source_origin_corrections WHERE origin_id = 'origin-a' ORDER BY created_at");
  assert.equal(corrections.rows.length, 2);
  assert.ok((corrections.rows[0] as { supersedes_correction_id: string }).supersedes_correction_id);
  assert.equal((corrections.rows[1] as { supersedes_correction_id: string | null }).supersedes_correction_id, null);
  const jobs = await db.client.query("SELECT COUNT(*) AS total FROM jobs WHERE required_capability = 'source:pipeline'");
  assert.equal(Number((jobs.rows[0] as { total: number }).total), 2);
  const audits = await db.client.query("SELECT COUNT(*) AS total FROM audit_events WHERE action = 'source_origin.corrected'");
  assert.equal(Number((audits.rows[0] as { total: number }).total), 2);
});
