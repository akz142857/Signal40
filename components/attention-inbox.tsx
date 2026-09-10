'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, Inbox, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageContainer, PageHeader } from '@/components/page-shell';

type AttentionItem = {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  project_id: string | null;
  topic_id: string | null;
  policy_id: string | null;
  source_config_id: string | null;
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
  source_rights: '来源权利异常',
  source_connector: '来源连接器异常',
  source_slo: '来源 SLO 告警',
  source_budget: '来源预算告警',
  source_ownership: '来源负责人异常',
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
    <PageHeader icon={<Inbox className="size-5" />} title="待办箱" subtitle="自动化处理不了、需要人判断的每一件事" actions={<><Button variant={status === 'open' ? 'default' : 'outline'} onClick={() => setStatus('open')}>未处理</Button><Button variant={status === 'resolved' ? 'default' : 'outline'} onClick={() => setStatus('resolved')}>已处理</Button></>} />

    <PageContainer className="py-6">
      {error && <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}
      {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />读取待办…</p>}
      <div className="grid gap-3">
        {items.map((item) => {
          const handlerRole = typeof item.detail?.handlerRole === 'string' ? item.detail.handlerRole : null;
          const owner = item.detail?.businessOwner && typeof item.detail.businessOwner === 'object' ? item.detail.businessOwner as Record<string, unknown> : null;
          const ownerLabel = typeof owner?.email === 'string' ? owner.email : typeof owner?.id === 'string' ? owner.id : null;
          return <article className={`rounded-xl border p-4 ${severityClass[item.severity]}`} key={item.id}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <CircleAlert className="size-4" />
            <span className="font-semibold">{kindLabels[item.kind] ?? item.kind}</span>
            <span className="text-xs text-muted-foreground">{new Date(item.created_at).toLocaleString('zh-CN')}</span>
            {item.project_id && <Link className="text-xs underline" href={`/projects/${item.project_id}`}>打开项目</Link>}
            {item.topic_id && <Link className="text-xs underline" href={`/?topic=${encodeURIComponent(item.topic_id)}`}>打开选题雷达（{item.topic_id}）</Link>}
            {item.source_config_id && <Link className="text-xs underline" href={`/sources?source=${encodeURIComponent(item.source_config_id)}`}>打开来源（{item.source_config_id}）</Link>}
            {item.notified_at ? <span className="text-xs text-chart-1">已推送通知 · {new Date(item.notified_at).toLocaleString('zh-CN')}</span> : item.notify_error ? <span className="text-xs text-destructive">通知推送失败：{item.notify_error}</span> : <span className="text-xs text-muted-foreground">尚未推送外部通知</span>}
          </div>
          <p className="mt-2 text-sm leading-6">{item.reason}</p>
          {(handlerRole || ownerLabel) && <p className="mt-2 text-xs text-muted-foreground">处理角色：{handlerRole ?? '未指定'} · 业务负责人：{ownerLabel ?? '未分配'}</p>}
          {Object.keys(item.detail ?? {}).length > 0 && <details className="mt-2 rounded-lg bg-secondary/50 p-3 text-xs"><summary className="cursor-pointer font-medium">查看机器详情</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono">{JSON.stringify(item.detail, null, 2)}</pre></details>}
          {status === 'open' && <div className="mt-3 flex flex-wrap gap-2">
            <Input className="max-w-md" placeholder="处置说明（至少 5 个字）" value={notes[item.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} />
            <Button variant="outline" onClick={() => void resolve(item)}>标记已处理</Button>
          </div>}
        </article>;})}
        {!loading && !items.length && <p className="rounded-xl border border-dashed p-7 text-center text-sm text-muted-foreground">{status === 'open' ? '没有待处理事项。' : '还没有已处理的记录。'}</p>}
      </div>
    </PageContainer>
  </main>;
}
