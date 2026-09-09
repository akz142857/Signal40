import { db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';
import {
  parseSocialEvidenceMetrics,
  parseSocialEvidencePolicy,
  SOCIAL_EVIDENCE_ACCEPTANCE_LIMITS,
} from '@/lib/social-evidence';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor', 'researcher'].includes(actor.role)) return Response.json({ error: '当前角色无权查看校准结果。' }, { status: 403 });
  const result = await db.prepare('SELECT * FROM calibration_runs ORDER BY created_at DESC LIMIT 200').all();
  return Response.json({ runs: result.results.map((row) => ({
    ...row,
    metrics: JSON.parse(String(row.metrics_json)),
    policy: typeof row.policy_json === 'string' ? JSON.parse(row.policy_json) : row.policy_json,
    metrics_json: undefined,
    policy_json: undefined,
  })) });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['researcher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权登记校准运行。' }, { status: 403 });
  let body: {
    calibrationKind?: 'score' | 'social_evidence'; algorithmVersion?: string;
    datasetLabel?: string; datasetRef?: string; datasetSha256?: string;
    caseCount?: number; metrics?: Record<string, number>; policy?: Record<string, unknown>; note?: string;
  };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const calibrationKind = body.calibrationKind ?? 'score';
  if (!body.algorithmVersion?.trim() || !body.datasetLabel?.trim() || !Number.isInteger(body.caseCount) || Number(body.caseCount) < 100 || !body.metrics || Object.values(body.metrics).some((value) => !Number.isFinite(value))) return Response.json({ error: '算法版本、数据集标签、至少 100 个样本和有限数值指标必填。' }, { status: 422 });
  if (!['score', 'social_evidence'].includes(calibrationKind)) return Response.json({ error: '校准类型无效。' }, { status: 422 });
  if (calibrationKind === 'social_evidence') {
    if (!body.datasetRef?.trim() || body.datasetRef.length > 1000 || !/^[a-f0-9]{64}$/.test(body.datasetSha256 ?? '')) {
      return Response.json({ error: 'Social Evidence 校准必须绑定数据集引用和 64 位 SHA-256。' }, { status: 422 });
    }
    if (!parseSocialEvidencePolicy(body.policy) || !parseSocialEvidenceMetrics(body.metrics)) {
      return Response.json({ error: `Social Evidence 策略或指标无效；误独立率上限不得高于 ${SOCIAL_EVIDENCE_ACCEPTANCE_LIMITS.maximumFalseIndependentRate}。` }, { status: 422 });
    }
  }
  const id = `calibration_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO calibration_runs (id, calibration_kind, algorithm_version, dataset_label, dataset_ref, dataset_sha256, case_count, metrics_json, policy_json, status, created_by, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)").bind(id, calibrationKind, body.algorithmVersion.trim(), body.datasetLabel.trim(), body.datasetRef?.trim() ?? null, body.datasetSha256 ?? null, body.caseCount, JSON.stringify(body.metrics), JSON.stringify(body.policy ?? {}), actor.id, body.note?.trim() ?? '', now, now),
    db.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'calibration.created', 'calibration_run', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash(body), JSON.stringify({ calibrationKind, datasetLabel: body.datasetLabel, datasetSha256: body.datasetSha256 ?? null, caseCount: body.caseCount }), crypto.randomUUID(), now),
  ]);
  return Response.json({ run: { id, status: 'candidate' } }, { status: 201 });
}
