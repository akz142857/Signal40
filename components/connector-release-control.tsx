'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, LoaderCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';
import { responseErrorText } from '@/lib/response-error';
import { cn } from '@/lib/utils';
import type { ConnectorReleaseMode } from '@/lib/source-lifecycle-status';

export type ConnectorRelease = {
  id: string;
  version: string;
  platform: string;
  adapter: 'rss' | 'http' | 'web' | 'social';
  label: string;
  availability: 'available' | 'blocked';
  rolloutMode: ConnectorReleaseMode;
  rolloutReason: string;
  rolloutVersion: number;
  canaryEnabled: boolean;
  canaryPercent: number;
  canaryFailureRateBps: number;
  canaryMinRuns: number;
  canaryStartedAt: string | null;
  canaryStoppedAt: string | null;
  effectiveAvailability: 'available' | 'blocked';
};

export const CONNECTOR_ROLLOUT_LABELS: Record<ConnectorReleaseMode, string> = {
  disabled: '停用',
  shadow: '影子运行',
  enabled: '启用',
};

/**
 * 连接器发布状态一行摘要。
 *
 * 发布控制管的是连接器版本，不是某一条来源，日常几乎不动，所以它的正文搬去了
 * 运维页。来源页只留这行：全部正常时是一句静默的计数，一旦有 shadow、停用或
 * 灰度在跑就点名是哪几个——「不常用」和「出事要立刻看见」这两件事不冲突。
 */
export function ConnectorReleaseSummary({
  connectors,
  className,
}: {
  connectors: ConnectorRelease[];
  className?: string;
}) {
  if (!connectors.length) return null;
  const shadow = connectors.filter(
    (connector) => connector.rolloutMode === 'shadow',
  );
  const disabled = connectors.filter(
    (connector) => connector.rolloutMode === 'disabled',
  );
  const canary = connectors.filter((connector) => connector.canaryEnabled);
  const attention = [...shadow, ...disabled, ...canary];
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3',
        attention.length
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-border bg-card',
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-sm font-medium">连接器发布</span>
        <span className="text-xs text-muted-foreground">
          {connectors.length - shadow.length - disabled.length} 启用 ·{' '}
          {shadow.length} shadow · {disabled.length} 停用 · {canary.length} 灰度
        </span>
        {attention.length > 0 && (
          <span className="min-w-0 truncate text-xs text-amber-700 dark:text-amber-300">
            {attention
              .map(
                (connector) =>
                  `${connector.label} ${connector.canaryEnabled ? `灰度 ${connector.canaryPercent}%` : CONNECTOR_ROLLOUT_LABELS[connector.rolloutMode]}`,
              )
              .join(' · ')}
          </span>
        )}
      </div>
      <Link
        href="/operations"
        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-chart-1 hover:underline"
      >
        前往运维调整
        <ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}

/**
 * 连接器版本的发布控制：disabled / shadow / 稳定分桶灰度。
 *
 * 只有管理员能改，服务端也会再判一次角色；这里的隐藏只是不给非管理员一堆
 * 注定 403 的按钮，不是权限本身。
 */
export function ConnectorReleaseControl() {
  const session = useSession();
  const actor = session.actor;
  const [connectors, setConnectors] = useState<ConnectorRelease[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const adminHeaders = useCallback(
    () =>
      actor
        ? devIdentityHeaders({
            role: 'admin',
            id: actor.id,
            email: actor.email,
          })
        : {},
    [actor],
  );

  const refresh = useCallback(async () => {
    const response = await fetch('/api/v1/source-connectors', {
      cache: 'no-store',
      headers: adminHeaders(),
    });
    if (!response.ok) throw new Error(await responseErrorText(response));
    setConnectors(
      ((await response.json()) as { connectors: ConnectorRelease[] })
        .connectors,
    );
  }, [adminHeaders]);

  // 首次拉取推到 effect 之后，避免在 effect 体里同步 setState 引起级联渲染。
  useEffect(() => {
    if (!actor) return;
    const timer = window.setTimeout(() => {
      void refresh().catch((error: unknown) =>
        setMessage(
          error instanceof Error ? error.message : '连接器读取失败。',
        ),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [actor, refresh]);

  const setConnectorMode = async (
    connector: ConnectorRelease,
    rolloutMode: ConnectorRelease['rolloutMode'],
    canary?: {
      enabled: boolean;
      percent: number;
      failureRateBps: number;
      minRuns: number;
    },
  ) => {
    const reason = window
      .prompt(
        `${connector.label} ${connector.id}@${connector.version} 将切换为 ${rolloutMode}。\n请输入变更原因：`,
        rolloutMode === 'disabled'
          ? '紧急停用连接器版本'
          : rolloutMode === 'shadow'
            ? '进入 shadow 观察'
            : '完成检查后恢复正式运行',
      )
      ?.trim();
    if (!reason) return;
    if (
      rolloutMode === 'disabled' &&
      !window.confirm(
        '停用会取消未领取作业并暂停使用该连接器的来源；恢复后需重新测试并启用。确认继续？',
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-connectors/${encodeURIComponent(connector.id)}/versions/${encodeURIComponent(connector.version)}/control`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({
            rolloutMode,
            expectedVersion: connector.rolloutVersion,
            reason,
            ...(canary ? { canary } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await responseErrorText(response));
      await refresh();
      setMessage(
        canary?.enabled
          ? `${connector.label} 已开始 ${canary.percent}% 稳定分桶灰度；失败率达到 ${(canary.failureRateBps / 100).toFixed(2)}% 且至少 ${canary.minRuns} 次运行时自动停用。`
          : `${connector.label} 已切换为 ${rolloutMode}。`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : '连接器发布控制更新失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const startConnectorCanary = (connector: ConnectorRelease) => {
    const percent = Number(window.prompt('灰度来源比例（1–100）：', String(connector.canaryPercent || 10)));
    const failurePercent = Number(window.prompt('自动停止失败率（0.01–100%）：', String((connector.canaryFailureRateBps || 2000) / 100)));
    const minRuns = Number(window.prompt('达到阈值前的最小运行数（1–10000）：', String(connector.canaryMinRuns || 20)));
    const failureRateBps = Math.round(failurePercent * 100);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100 || !Number.isInteger(failureRateBps) || failureRateBps < 1 || failureRateBps > 10_000 || !Number.isInteger(minRuns) || minRuns < 1 || minRuns > 10_000) {
      setMessage('灰度参数无效：比例 1–100，失败率 0.01–100%，最小运行数 1–10000。');
      return;
    }
    void setConnectorMode(connector, 'enabled', { enabled: true, percent, failureRateBps, minRuns });
  };

  if (session.loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        读取身份…
      </p>
    );
  }
  if (actor?.role !== 'admin') {
    return (
      <p className="text-sm text-muted-foreground">
        连接器发布控制只对管理员开放。
      </p>
    );
  }
  return (
    <div className="rounded-2xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          disabled 会停止并暂停来源；shadow 只记录脱敏统计，不写正式文章或
          checkpoint；灰度按来源 ID
          稳定分桶，未命中的来源自动走 shadow，越过失败阈值会停用整个版本。
        </p>
        <Badge variant="outline">管理员</Badge>
      </div>
      <output className="mt-2 block text-sm text-muted-foreground">
        {message}
      </output>
      <div className="mt-3 grid gap-2">
        {connectors.map((connector) => (
          <div
            key={`${connector.id}@${connector.version}`}
            className="flex flex-col justify-between gap-3 rounded-xl border p-3 sm:flex-row sm:items-center"
          >
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{connector.label}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {connector.id}@{connector.version}
                </span>
                <Badge
                  variant={
                    connector.rolloutMode === 'enabled'
                      ? 'default'
                      : connector.rolloutMode === 'shadow'
                        ? 'secondary'
                        : 'destructive'
                  }
                >
                  {CONNECTOR_ROLLOUT_LABELS[connector.rolloutMode]}
                </Badge>
                {connector.canaryEnabled && (
                  <Badge variant="secondary">
                    灰度 {connector.canaryPercent}% · 自动停用 ≥
                    {(connector.canaryFailureRateBps / 100).toFixed(2)}% /
                    {connector.canaryMinRuns} 次
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {connector.rolloutReason}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy || connector.availability !== 'available' || connector.canaryEnabled}
                onClick={() => startConnectorCanary(connector)}
              >
                灰度
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  connector.availability !== 'available' ||
                  connector.rolloutMode === 'shadow'
                }
                onClick={() => void setConnectorMode(connector, 'shadow')}
              >
                Shadow
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  connector.availability !== 'available' ||
                  (connector.rolloutMode === 'enabled' &&
                    !connector.canaryEnabled)
                }
                onClick={() =>
                  void setConnectorMode(connector, 'enabled', {
                    enabled: false,
                    percent: connector.canaryPercent,
                    failureRateBps: connector.canaryFailureRateBps,
                    minRuns: connector.canaryMinRuns,
                  })
                }
              >
                启用
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || connector.rolloutMode === 'disabled'}
                onClick={() => void setConnectorMode(connector, 'disabled')}
              >
                停用
              </Button>
            </div>
          </div>
        ))}
        {!connectors.length && (
          <p className="text-sm text-muted-foreground">尚无连接器版本。</p>
        )}
      </div>
    </div>
  );
}
