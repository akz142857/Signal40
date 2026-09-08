'use client';

import { useEffect, useState } from 'react';
import type { Role } from '@/lib/workflow';

export type SessionActor = { id: string; email: string; role: Role };

export type Session = {
  actor: SessionActor | null;
  /** 本机开发是否仍允许用 `x-signal-role` 伪造角色；生产部署必须是 false。 */
  localRoleHeadersAllowed: boolean;
  loading: boolean;
  error: string;
};

/**
 * 当前登录身份。
 *
 * 界面过去把角色写死成 `local-editor` / `local-publisher`，
 * 于是「谁批准的」由前端说了算，G7 的独立发布人形同虚设。
 * 现在一律读服务端解析出来的真实身份，本机开发要切角色必须显式使用
 * `devIdentityHeaders`，而且只在服务端允许时才生效。
 */
export function useSession(): Session {
  const [session, setSession] = useState<Session>({ actor: null, localRoleHeadersAllowed: false, loading: true, error: '' });
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/v1/session', { cache: 'no-store' })
      .then(async (response) => {
        const payload = (await response.json()) as { actor?: SessionActor | null; localRoleHeadersAllowed?: boolean; error?: string };
        if (cancelled) return;
        localRoleHeadersAllowed = Boolean(payload.localRoleHeadersAllowed);
        setSession({
          actor: payload.actor ?? null,
          localRoleHeadersAllowed: Boolean(payload.localRoleHeadersAllowed),
          loading: false,
          error: response.ok ? '' : payload.error || '身份解析失败。',
        });
      })
      .catch(() => { if (!cancelled) setSession({ actor: null, localRoleHeadersAllowed: false, loading: false, error: '身份解析失败。' }); });
    return () => { cancelled = true; };
  }, []);
  return session;
}

/**
 * 本机开发是否允许伪造角色。这是部署级常量（服务端配置），一次会话内不会变，
 * 所以放在模块作用域而不是组件状态里——它不是响应式数据，
 * 挂进 useCallback 依赖只会让两条 lint 规则互相打架。
 */
let localRoleHeadersAllowed = false;

/**
 * 本机开发用的角色伪造头。服务端不允许时返回空对象——
 * 那边也会忽略这些头，这里不发是为了让界面行为和服务端判定一致。
 */
export function devIdentityHeaders(identity?: { role: Role; id?: string; email?: string }): Record<string, string> {
  if (!localRoleHeadersAllowed || !identity) return {};
  return {
    'x-signal-role': identity.role,
    ...(identity.id ? { 'x-signal-actor-id': identity.id } : {}),
    ...(identity.email ? { 'x-signal-actor-email': identity.email } : {}),
  };
}
