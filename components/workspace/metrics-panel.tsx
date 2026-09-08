'use client';

import { useEffect, useState } from 'react';
import { BarChart3, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ProjectRecord } from '@/lib/control-plane';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';

type Snapshot = { id: string; capturedAt: string; metrics: { views?: number; averageViewDurationSeconds?: number; completionRate?: number; likes?: number; comments?: number; shares?: number } };
type PublishJob = { id: string; channel: string; status: string };

export function MetricsPanel({ project, onSaved, onMessage }: { project: ProjectRecord; onSaved: () => Promise<void>; onMessage: (message: string) => void }) {
  // 挂上会话：devIdentityHeaders 读的是它带回来的部署级开关。
  useSession();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [publishJobs, setPublishJobs] = useState<PublishJob[]>([]);
  const [views, setViews] = useState('');
  const [completionRate, setCompletionRate] = useState('');
  const [averageViewDuration, setAverageViewDuration] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = ['PUBLISHED', 'MEASURED'].includes(project.state);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([
        fetch(`/api/v1/projects/${project.id}/metrics`, { cache: 'no-store' }).then((response) => response.json()) as Promise<{ snapshots: Snapshot[] }>,
        fetch(`/api/v1/projects/${project.id}/publish-jobs`, { cache: 'no-store' }).then((response) => response.json()) as Promise<{ publishJobs: PublishJob[] }>,
      ]).then(([metricPayload, publishPayload]) => { setSnapshots(metricPayload.snapshots ?? []); setPublishJobs(publishPayload.publishJobs ?? []); });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [project.id]);

  const save = async () => {
    const publishJob = publishJobs.find((job) => job.status === 'published');
    if (!publishJob) { onMessage('没有已完成的发布任务，不能写入指标。'); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `manual:${publishJob.id}:${snapshots.length + 1}`, ...devIdentityHeaders({ role: 'auditor', id: 'local-auditor' }) },
        body: JSON.stringify({ publishJobId: publishJob.id, metrics: { views: Number(views), completionRate: Number(completionRate) / 100, averageViewDurationSeconds: Number(averageViewDuration) }, attribution: { source: 'manual', window: snapshots.length === 0 ? '2h' : snapshots.length === 1 ? '24h' : '7d' } }),
      });
      const payload = (await response.json()) as { error?: string; snapshot?: Snapshot };
      if (!response.ok) throw new Error(payload.error ?? '指标保存失败。');
      if (payload.snapshot) setSnapshots((current) => [...current, payload.snapshot!]);
      await onSaved();
      onMessage('指标快照已回流并写入审计。');
    } catch (error) { onMessage(error instanceof Error ? error.message : '指标保存失败。'); }
    finally { setBusy(false); }
  };

  const latest = snapshots.at(-1);
  return <section className="rounded-2xl border border-border bg-card p-5">
    <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-secondary"><BarChart3 className="size-5" /></span><div><p className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Post-publish learning</p><h2 className="text-xl font-semibold">2h / 24h / 7d 指标回流</h2></div></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-xl bg-secondary/60 p-3"><p className="text-xs text-muted-foreground">播放</p><p className="mt-1 text-2xl font-semibold">{latest?.metrics.views?.toLocaleString('zh-CN') ?? '—'}</p></div><div className="rounded-xl bg-secondary/60 p-3"><p className="text-xs text-muted-foreground">完播率</p><p className="mt-1 text-2xl font-semibold">{latest?.metrics.completionRate !== undefined ? `${Math.round(latest.metrics.completionRate * 100)}%` : '—'}</p></div><div className="rounded-xl bg-secondary/60 p-3"><p className="text-xs text-muted-foreground">平均观看</p><p className="mt-1 text-2xl font-semibold">{latest?.metrics.averageViewDurationSeconds !== undefined ? `${latest.metrics.averageViewDurationSeconds}s` : '—'}</p></div></div>
    {enabled && <div className="mt-4 grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr_auto]"><div className="grid gap-2"><Label htmlFor="metric-views">播放数</Label><Input id="metric-views" type="number" min="0" value={views} onChange={(event) => setViews(event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="metric-completion">完播率 %</Label><Input id="metric-completion" type="number" min="0" max="100" value={completionRate} onChange={(event) => setCompletionRate(event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="metric-watch">平均观看秒数</Label><Input id="metric-watch" type="number" min="0" value={averageViewDuration} onChange={(event) => setAverageViewDuration(event.target.value)} /></div><Button disabled={busy || !views || !completionRate || !averageViewDuration} onClick={() => void save()}><Plus />记录快照</Button></div>}
    {!enabled && <p className="mt-4 text-sm text-muted-foreground">确认平台发布后开放指标录入；每个快照保留渠道、窗口和外部视频归因。</p>}
  </section>;
}
