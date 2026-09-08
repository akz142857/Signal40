'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, Inbox, LoaderCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

type AttentionItem = {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  project_id: string | null;
  topic_id: string | null;
  policy_id: string | null;
  reason: string;
  detail: Record<string, unknown>;
  status: 'open' | 'resolved';
  notified_at: string | null;
  notify_error: string | null;
  created_at: string;
};

const kindLabels: Record<string, string> = {
  gate_blocked: '门禁未过',
  qc_failed: '自动 QC 失败',
  dead_letter: '死信作业',
  evidence_conflict: '证据冲突',
  budget_exceeded: '超预算或超限额',
  breaker_open: '阶段已熔断',
  auto_approval_rejected: '自动放行被拒',
  topic_quality: '选题质量不达标',
  no_worker: '没有可执行的 Worker',
  incident_open: '内容事件进行中',
  metrics_due: '指标待回流',
  automation_actor_missing: '自动化服务账号缺失',
};

const severityClass = { info: 'border-border', warning: 'border-chart-2/50 bg-chart-2/5', critical: 'border-destructive/50 bg-destructive/5' } as const;

export function AttentionInbox() {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (next: 'open' | 'resolved') => {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/attention?status=${next}`, { cache: 'no-store' });
      const payload = (await response.json()) as { items?: AttentionItem[]; error?: string };
      if (!response.ok) throw new Error(payload.error || '读取待办失败');
      setItems(payload.items ?? []);
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '读取待办失败'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(status); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh, status]);

  const resolve = async (item: AttentionItem) => {
    const note = notes[item.id] ?? '';
    if (note.trim().length < 5) { setError('处理待办时必须写明处置说明（至少 5 个字）。'); return; }
    const response = await fetch(`/api/v1/attention/${item.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'resolve', note }) });
    if (!response.ok) { setError(((await response.json()) as { error?: string }).error || '处理失败'); return; }
    await refresh(status);
  };

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b"><div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-7"><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Inbox className="size-5" /></div><div><p className="text-lg font-semibold">待办箱</p><p className="text-xs text-muted-foreground">自动化处理不了、需要人判断的每一件事</p></div></div><div className="flex gap-2"><Button variant={status === 'open' ? 'default' : 'outline'} onClick={() => setStatus('open')}>未处理</Button><Button variant={status === 'resolved' ? 'default' : 'outline'} onClick={() => setStatus('resolved')}>已处理</Button><Link className={buttonVariants({ variant: 'outline' })} href="/"><ArrowLeft />返回雷达</Link></div></div></header>

    <div className="mx-auto max-w-5xl px-4 py-7 sm:px-7">
      {error && <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
      {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />读取待办…</p>}
      <div className="grid gap-3">
        {items.map((item) => <article className={`rounded-xl border p-4 ${severityClass[item.severity]}`} key={item.id}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <CircleAlert className="size-4" />
            <span className="font-semibold">{kindLabels[item.kind] ?? item.kind}</span>
            <span className="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleString('zh-CN')}</span>
            {item.project_id && <Link className="text-xs underline" href={`/projects/${item.project_id}`}>打开项目</Link>}
            {item.notify_error && <span className="text-xs text-destructive">通知推送失败：{item.notify_error}</span>}
          </div>
          <p className="mt-2 text-sm leading-6">{item.reason}</p>
          {status === 'open' && <div className="mt-3 flex flex-wrap gap-2">
            <Input className="max-w-md" placeholder="处置说明（至少 5 个字）" value={notes[item.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} />
            <Button variant="outline" onClick={() => void resolve(item)}>标记已处理</Button>
          </div>}
        </article>)}
        {!loading && !items.length && <p className="rounded-xl border border-dashed p-7 text-center text-sm text-muted-foreground">{status === 'open' ? '没有待处理事项。' : '还没有已处理的记录。'}</p>}
      </div>
    </div>
  </main>;
}
