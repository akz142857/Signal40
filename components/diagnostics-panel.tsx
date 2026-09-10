'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, CircleHelp, LoaderCircle, Stethoscope, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageContainer, PageHeader } from '@/components/page-shell';

type Check = { id: string; label: string; status: 'ok' | 'degraded' | 'failed' | 'unconfigured'; detail: string; hint?: string };
type Worker = { id: string; hostname: string; kinds: string[]; version: string; lastHeartbeatAt: string; online: boolean };
type Backlog = { kind: string; waiting: number; leased: number; deadLetter: number };
type Diagnostics = { status: string; checkedAt: string; checks: Check[]; workers: Worker[]; backlog: Backlog[] };

const statusIcon = { ok: CheckCircle2, degraded: TriangleAlert, failed: CircleAlert, unconfigured: CircleHelp } as const;
const statusClass = { ok: 'text-chart-1', degraded: 'text-chart-2', failed: 'text-destructive', unconfigured: 'text-muted-foreground' } as const;
const statusLabel = { ok: '正常', degraded: '降级', failed: '不可用', unconfigured: '未配置' } as const;

export function DiagnosticsPanel() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/v1/diagnostics', { cache: 'no-store' });
      const payload = (await response.json()) as Diagnostics & { error?: string };
      if (!response.ok) throw new Error(payload.error || '自检失败');
      setData(payload);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '自检失败');
    } finally { setLoading(false); }
  }, []);

  // 推到 effect 之后再拉取：在 effect 体里同步 setState 会引起级联渲染。
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  return <main className="min-h-screen bg-background text-foreground">
    <PageHeader icon={<Stethoscope className="size-5" />} title="系统自检" subtitle="数据库、对象存储、凭据、Worker 与调度器" actions={<Button variant="outline" disabled={loading} onClick={() => void refresh()}>{loading ? <LoaderCircle className="animate-spin" /> : null}重新检查</Button>} />

    <PageContainer className="py-7">
      {error && <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
      {!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />正在自检…</p>}
      {data && <>
        <p className="text-sm text-muted-foreground">检查于 {new Date(data.checkedAt).toLocaleString('zh-CN')}；凭据只报可用性与原因，永远不回显密钥本身。</p>
        <div className="mt-4 grid gap-3">
          {data.checks.map((check) => {
            const Icon = statusIcon[check.status];
            return <article className="flex items-start gap-3 rounded-xl border bg-card p-4" key={check.id}>
              <Icon className={`mt-0.5 size-5 shrink-0 ${statusClass[check.status]}`} />
              <div>
                <p className="font-medium">{check.label} · <span className={statusClass[check.status]}>{statusLabel[check.status]}</span></p>
                <p className="mt-1 text-sm text-muted-foreground">{check.detail}</p>
                {check.hint && <p className="mt-1 text-xs text-muted-foreground">下一步：{check.hint}</p>}
              </div>
            </article>;
          })}
        </div>

        <section className="mt-7">
          <h2 className="text-xl font-semibold tracking-tight">Worker</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/60 text-muted-foreground"><tr>{['ID', '主机', '可处理类型', '版本', '最近心跳', '状态'].map((value) => <th className="px-4 py-3 font-medium" key={value}>{value}</th>)}</tr></thead><tbody>
            {data.workers.map((worker) => <tr className="border-t" key={worker.id}><td className="px-4 py-3 font-mono">{worker.id}</td><td className="px-4 py-3">{worker.hostname || '—'}</td><td className="px-4 py-3 font-mono text-xs">{worker.kinds.join('、')}</td><td className="px-4 py-3 font-mono text-xs">{worker.version || '—'}</td><td className="px-4 py-3">{new Date(worker.lastHeartbeatAt).toLocaleString('zh-CN')}</td><td className={`px-4 py-3 ${worker.online ? 'text-chart-1' : 'text-destructive'}`}>{worker.online ? '在线' : '离线'}</td></tr>)}
            {!data.workers.length && <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={6}>还没有 Worker 上报过心跳。</td></tr>}
          </tbody></table></div>
        </section>

        <section className="mt-7">
          <h2 className="text-xl font-semibold tracking-tight">队列积压</h2>
          <div className="mt-3 overflow-hidden rounded-2xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/60 text-muted-foreground"><tr>{['类型', '等待', '执行中', '死信'].map((value) => <th className="px-4 py-3 font-medium" key={value}>{value}</th>)}</tr></thead><tbody>
            {data.backlog.map((row) => <tr className="border-t" key={row.kind}><td className="px-4 py-3 font-mono">{row.kind}</td><td className="px-4 py-3">{row.waiting}</td><td className="px-4 py-3">{row.leased}</td><td className="px-4 py-3">{row.deadLetter}</td></tr>)}
            {!data.backlog.length && <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={4}>队列为空。</td></tr>}
          </tbody></table></div>
        </section>
      </>}
    </PageContainer>
  </main>;
}
