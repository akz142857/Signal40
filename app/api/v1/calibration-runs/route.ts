import { db, resolveRequestActor } from '@/lib/runtime';
import { stableHash } from '@/lib/workflow';

export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor', 'researcher'].includes(actor.role)) return Response.json({ error: '当前角色无权查看校准结果。' }, { status: 403 });
  const result = await db.prepare('SELECT * FROM calibration_runs ORDER BY created_at DESC LIMIT 200').all();
  return Response.json({ runs: result.results.map((row) => ({ ...row, metrics: JSON.parse(String(row.metrics_json)), metrics_json: undefined })) });
}

export async function POST(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['researcher', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权登记校准运行。' }, { status: 403 });
  let body: { algorithmVersion?: string; datasetLabel?: string; caseCount?: number; metrics?: Record<string, number>; note?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  if (!body.algorithmVersion?.trim() || !body.datasetLabel?.trim() || !Number.isInteger(body.caseCount) || Number(body.caseCount) < 100 || !body.metrics || Object.values(body.metrics).some((value) => !Number.isFinite(value))) return Response.json({ error: '算法版本、数据集标签、至少 100 个样本和有限数值指标必填。' }, { status: 422 });
  const id = `calibration_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO calibration_runs (id, algorithm_version, dataset_label, case_count, metrics_json, status, created_by, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)").bind(id, body.algorithmVersion.trim(), body.datasetLabel.trim(), body.caseCount, JSON.stringify(body.metrics), actor.id, body.note?.trim() ?? '', now, now),
    db.prepare("INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at) VALUES (?, ?, ?, 'calibration.created', 'calibration_run', ?, ?, ?, ?, ?)").bind(`audit_${crypto.randomUUID()}`, actor.id, actor.role, id, stableHash(body), JSON.stringify({ datasetLabel: body.datasetLabel, caseCount: body.caseCount }), crypto.randomUUID(), now),
  ]);
  return Response.json({ run: { id, status: 'candidate' } }, { status: 201 });
}
