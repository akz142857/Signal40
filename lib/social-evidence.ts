export const EVIDENCE_RELATIONSHIPS = [
  'original',
  'repost',
  'quote',
  'syndicated',
  'unknown',
] as const;

export type EvidenceRelationship = (typeof EVIDENCE_RELATIONSHIPS)[number];

export type EvidenceQualificationPolicy = {
  version: string;
  minimumConfidence: number;
  eligibleRelationships: readonly EvidenceRelationship[];
  socialAutoProductionEnabled: boolean;
};

export type SocialEvidenceCalibrationPolicy = EvidenceQualificationPolicy & {
  maximumFalseIndependentRate: number;
  minimumIndependentRecall: number;
  minimumProductionSampleSize: number;
};

export type SocialEvidenceCalibrationMetrics = {
  falseIndependentRate: number;
  independentRecall: number;
  productionSampleSize: number;
};

export const SOCIAL_EVIDENCE_ACCEPTANCE_LIMITS = {
  maximumFalseIndependentRate: 0.02,
  minimumIndependentRecall: 0.8,
  minimumProductionSampleSize: 30,
  minimumLabelledCases: 100,
} as const;

/**
 * 未有已批准 Social Evidence 校准前的生产默认值。普通、未纳管的非社交导入
 * 继续走原有人工工作流；所有纳管 origin 与 social/web 信号都失败关闭。
 */
export const SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY: EvidenceQualificationPolicy = {
  version: 'social-evidence/not-approved',
  minimumConfidence: 100,
  eligibleRelationships: ['original'],
  socialAutoProductionEnabled: false,
};

export type EvidenceOrigin = {
  evidenceFamilyId?: string;
  publisherEntityId?: string;
  publisherOwnershipGroup?: string;
  originRelationship?: EvidenceRelationship;
  originConfidence?: number;
  originManaged?: boolean;
  originManuallyCorrected?: boolean;
  platform?: string;
  sourceType: string;
  source: string;
  contentHash: string;
};

export type QualifiedEvidenceEdge = {
  familyId: string;
  publisherGroupId: string;
};

function isSocialOrWeb(origin: EvidenceOrigin) {
  return origin.sourceType === 'social' || ['wechat', 'xiaohongshu', 'web_page'].includes(origin.platform ?? '');
}

/**
 * 只有治理元数据完整的 origin 才能成为正式边。历史/人工非社交导入没有 origin，
 * 仍保留旧人工工作流的稳定身份；social/web 永远不能借此回退提权。
 */
export function qualifiedEvidenceEdge(
  origin: EvidenceOrigin,
  policy: EvidenceQualificationPolicy,
): QualifiedEvidenceEdge | null {
  if (!origin.originManaged) {
    if (isSocialOrWeb(origin)) return null;
    return {
      familyId: origin.evidenceFamilyId || `legacy-content:${origin.contentHash}`,
      publisherGroupId: origin.publisherOwnershipGroup || origin.publisherEntityId || `legacy-source:${origin.source}`,
    };
  }
  if (isSocialOrWeb(origin) && !policy.socialAutoProductionEnabled) return null;
  if (!origin.evidenceFamilyId || !(origin.publisherOwnershipGroup || origin.publisherEntityId)) return null;
  if (!origin.originRelationship || !policy.eligibleRelationships.includes(origin.originRelationship)) return null;
  if (!Number.isInteger(origin.originConfidence) || Number(origin.originConfidence) < policy.minimumConfidence) return null;
  return {
    familyId: origin.evidenceFamilyId,
    publisherGroupId: origin.publisherOwnershipGroup || origin.publisherEntityId!,
  };
}

/** 对 family ↔ publisher ownership group 二分图求最大匹配。 */
export function maximumIndependentEvidenceMatching(edges: readonly QualifiedEvidenceEdge[]) {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const groups = adjacency.get(edge.familyId) ?? new Set<string>();
    groups.add(edge.publisherGroupId);
    adjacency.set(edge.familyId, groups);
  }
  const matchedFamilyByGroup = new Map<string, string>();
  function augment(familyId: string, visitedGroups: Set<string>): boolean {
    for (const groupId of adjacency.get(familyId) ?? []) {
      if (visitedGroups.has(groupId)) continue;
      visitedGroups.add(groupId);
      const currentFamily = matchedFamilyByGroup.get(groupId);
      if (!currentFamily || augment(currentFamily, visitedGroups)) {
        matchedFamilyByGroup.set(groupId, familyId);
        return true;
      }
    }
    return false;
  }
  let count = 0;
  for (const familyId of [...adjacency.keys()].sort()) {
    if (augment(familyId, new Set())) count += 1;
  }
  return count;
}

export function independentEvidenceCount(
  origins: readonly EvidenceOrigin[],
  policy: EvidenceQualificationPolicy = SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY,
) {
  return maximumIndependentEvidenceMatching(
    origins.flatMap((origin) => {
      const edge = qualifiedEvidenceEdge(origin, policy);
      return edge ? [edge] : [];
    }),
  );
}

function record(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseSocialEvidencePolicy(value: unknown): SocialEvidenceCalibrationPolicy | null {
  const input = record(value);
  if (!input || typeof input.version !== 'string' || !input.version.trim()) return null;
  if (!Number.isInteger(input.minimumConfidence) || Number(input.minimumConfidence) < 0 || Number(input.minimumConfidence) > 100) return null;
  if (!Array.isArray(input.eligibleRelationships) || !input.eligibleRelationships.length) return null;
  const relationships = [...new Set(input.eligibleRelationships)];
  if (relationships.some((item) => !EVIDENCE_RELATIONSHIPS.includes(item as EvidenceRelationship))) return null;
  // v2.0 只允许可证明的原创关系进入自动生产；转载、引用和联播不能被配置绕过。
  if (relationships.some((item) => item !== 'original')) return null;
  if (input.socialAutoProductionEnabled !== true) return null;
  if (typeof input.maximumFalseIndependentRate !== 'number' || input.maximumFalseIndependentRate < 0 || input.maximumFalseIndependentRate > SOCIAL_EVIDENCE_ACCEPTANCE_LIMITS.maximumFalseIndependentRate) return null;
  if (typeof input.minimumIndependentRecall !== 'number' || input.minimumIndependentRecall < SOCIAL_EVIDENCE_ACCEPTANCE_LIMITS.minimumIndependentRecall || input.minimumIndependentRecall > 1) return null;
  if (!Number.isInteger(input.minimumProductionSampleSize) || Number(input.minimumProductionSampleSize) < SOCIAL_EVIDENCE_ACCEPTANCE_LIMITS.minimumProductionSampleSize) return null;
  return {
    version: input.version.trim().slice(0, 120),
    minimumConfidence: Number(input.minimumConfidence),
    eligibleRelationships: relationships as EvidenceRelationship[],
    socialAutoProductionEnabled: true,
    maximumFalseIndependentRate: input.maximumFalseIndependentRate,
    minimumIndependentRecall: input.minimumIndependentRecall,
    minimumProductionSampleSize: Number(input.minimumProductionSampleSize),
  };
}

export function parseSocialEvidenceMetrics(value: unknown): SocialEvidenceCalibrationMetrics | null {
  const input = record(value);
  if (!input) return null;
  if (typeof input.falseIndependentRate !== 'number' || input.falseIndependentRate < 0 || input.falseIndependentRate > 1) return null;
  if (typeof input.independentRecall !== 'number' || input.independentRecall < 0 || input.independentRecall > 1) return null;
  if (!Number.isInteger(input.productionSampleSize) || Number(input.productionSampleSize) < 0) return null;
  return {
    falseIndependentRate: input.falseIndependentRate,
    independentRecall: input.independentRecall,
    productionSampleSize: Number(input.productionSampleSize),
  };
}

export function socialEvidenceCalibrationPasses(
  caseCount: number,
  policyValue: unknown,
  metricsValue: unknown,
) {
  const policy = parseSocialEvidencePolicy(policyValue);
  const metrics = parseSocialEvidenceMetrics(metricsValue);
  return Boolean(
    policy && metrics && caseCount >= SOCIAL_EVIDENCE_ACCEPTANCE_LIMITS.minimumLabelledCases &&
    metrics.falseIndependentRate <= policy.maximumFalseIndependentRate &&
    metrics.independentRecall >= policy.minimumIndependentRecall &&
    metrics.productionSampleSize >= policy.minimumProductionSampleSize,
  );
}

export async function loadApprovedEvidencePolicy(db: {
  prepare(sql: string): { first<T>(): Promise<T | null> };
}) {
  const row = await db.prepare(`
    SELECT policy_json FROM calibration_runs
    WHERE calibration_kind = 'social_evidence' AND status = 'approved'
    ORDER BY updated_at DESC, id DESC LIMIT 1
  `).first<{ policy_json: unknown }>();
  return parseSocialEvidencePolicy(row?.policy_json) ?? SOCIAL_EVIDENCE_FAIL_CLOSED_POLICY;
}

export type SocialEvidenceLabelledCase = {
  id: string;
  independent: boolean;
  productionSample: boolean;
  origins: EvidenceOrigin[];
};

export function evaluateSocialEvidenceDataset(
  cases: readonly SocialEvidenceLabelledCase[],
  policy: EvidenceQualificationPolicy,
): SocialEvidenceCalibrationMetrics & { truePositive: number; falsePositive: number; trueNegative: number; falseNegative: number } {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  for (const item of cases) {
    const predicted = independentEvidenceCount(item.origins, policy) >= 2;
    if (predicted && item.independent) truePositive += 1;
    else if (predicted) falsePositive += 1;
    else if (item.independent) falseNegative += 1;
    else trueNegative += 1;
  }
  const negativeCount = falsePositive + trueNegative;
  const positiveCount = truePositive + falseNegative;
  return {
    falseIndependentRate: negativeCount ? falsePositive / negativeCount : 1,
    independentRecall: positiveCount ? truePositive / positiveCount : 0,
    productionSampleSize: cases.filter((item) => item.productionSample).length,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
  };
}
