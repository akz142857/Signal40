import { db, resolveRequestActor } from '@/lib/runtime';
import { sha256Hex } from '@/lib/hash';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const { id } = await context.params;
  const result = await db.prepare('SELECT pea.*, e.name, e.primary_metric FROM project_experiment_assignments pea JOIN experiments e ON e.id = pea.experiment_id WHERE pea.project_id = ? ORDER BY pea.assigned_at DESC').bind(id).all();
  return Response.json({ assignments: result.results });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['researcher', 'editor', 'admin'].includes(actor.role)) return Response.json({ error: '当前角色无权分配实验。' }, { status: 403 });
  let body: { experimentId?: string };
  try { body = (await request.json()) as typeof body; } catch { return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 }); }
  const { id } = await context.params;
  const experiment = body.experimentId ? await db.prepare("SELECT id, variants_json, allocation_bps_json FROM experiments WHERE id = ? AND status = 'running' LIMIT 1").bind(body.experimentId).first<{ id: string; variants_json: string; allocation_bps_json: string }>() : null;
  if (!experiment) return Response.json({ error: '实验不存在或未运行。' }, { status: 409 });
  const existing = await db.prepare('SELECT variant, assignment_hash FROM project_experiment_assignments WHERE project_id = ? AND experiment_id = ? LIMIT 1').bind(id, experiment.id).first();
  if (existing) return Response.json({ assignment: existing, replayed: true });
  const variants = JSON.parse(experiment.variants_json) as string[];
  const allocations = JSON.parse(experiment.allocation_bps_json) as number[];
  const assignmentHash = `sha256:${sha256Hex(`${experiment.id}:${id}`)}`;
  const bucket = Number.parseInt(assignmentHash.slice(-8), 16) % 10_000;
  let cumulative = 0;
  const variant = variants.find((_value, index) => { cumulative += allocations[index]; return bucket < cumulative; }) ?? variants.at(-1)!;
  const assignmentId = `assignment_${crypto.randomUUID()}`;
  await db.prepare('INSERT INTO project_experiment_assignments (id, project_id, experiment_id, variant, assignment_hash, assigned_at) VALUES (?, ?, ?, ?, ?, ?)').bind(assignmentId, id, experiment.id, variant, assignmentHash, new Date().toISOString()).run();
  return Response.json({ assignment: { id: assignmentId, variant, assignmentHash } }, { status: 201 });
}
