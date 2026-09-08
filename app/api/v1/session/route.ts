import { config, resolveRequestActor } from '@/lib/runtime';

/**
 * 当前登录身份。界面据此显示真人身份并决定按钮可用性——
 * 角色不再由前端硬编码，也就不能由前端说了算。
 */
export async function GET(request: Request) {
  const actor = await resolveRequestActor(request);
  if (!actor) {
    return Response.json({
      actor: null,
      error: '当前请求没有可识别的身份。非本机访问需要认证反向代理注入身份头。',
      identityHeaders: config.identityHeaders,
    }, { status: 401 });
  }
  return Response.json({ actor, localRoleHeadersAllowed: config.allowLocalRoleHeaders });
}
