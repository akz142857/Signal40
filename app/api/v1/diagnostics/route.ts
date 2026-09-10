import { config, db, resolveRequestActor, storage } from '@/lib/runtime';
import { runDiagnostics } from '@/lib/diagnostics';

/**
 * 系统自检。只有管理员和审计员能看：结论里包含哪些凭据没配、队列积压多少，
 * 属于运维信息。任何情况下都不回显密钥本身。
 */
export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor || !['admin', 'auditor'].includes(actor.role)) return Response.json({ error: '当前角色无权查看系统自检。' }, { status: 403 });
  const result = await runDiagnostics({
    db,
    storage,
    env: config.diagnosticsEnvironment,
  });
  return Response.json(result);
}
