import { db, resolveRequestActor } from '@/lib/runtime';
import { recordApproval } from '@/lib/control-plane';

const kinds = ['research', 'script', 'qc', 'publish'] as const;
const decisions = ['approved', 'changes_requested', 'rejected'] as const;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  let body: { kind?: string; decision?: string; subjectHash?: string; note?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: '请求体必须是 JSON。' }, { status: 400 });
  }
  if (!kinds.includes(body.kind as never) || !decisions.includes(body.decision as never))
    return Response.json({ error: '批准类型或决定无效。' }, { status: 422 });
  if (!body.subjectHash || !body.note || body.note.trim().length < 10)
    return Response.json({ error: 'subjectHash 必填，备注至少 10 个字符。' }, { status: 422 });
  const { id } = await context.params;
  const result = await recordApproval(db, {
    projectId: id,
    kind: body.kind as (typeof kinds)[number],
    decision: body.decision as (typeof decisions)[number],
    subjectHash: body.subjectHash,
    note: body.note.trim().slice(0, 2000),
    actor,
  });
  if ('error' in result) return Response.json({ error: result.error }, { status: result.status });
  return Response.json({ approval: result.approval }, { status: 201 });
}
