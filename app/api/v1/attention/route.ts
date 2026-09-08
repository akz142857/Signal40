import { db, resolveRequestActor } from '@/lib/runtime';
import { listAttentionItems } from '@/lib/attention';

/** 待办箱。所有团队成员都能看：门禁没过、QC 失败、死信作业都是需要人处理的事。 */
export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) return Response.json({ error: '用户未加入 Signal 40 团队。' }, { status: 403 });
  const params = new URL(request.url).searchParams;
  const status = params.get('status');
  const items = await listAttentionItems(db, {
    status: status === 'resolved' || status === 'all' ? status : 'open',
    projectId: params.get('projectId') ?? undefined,
    limit: Number(params.get('limit') ?? 100),
  });
  return Response.json({ items });
}
