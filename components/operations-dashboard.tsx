'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Activity, ArrowLeft, CircleAlert, Clock3, Coins, LoaderCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';

type Metric = { total: number; succeeded: number; failed: number; deadLetter: number; retries: number; p50Ms: number | null; p95Ms: number | null; costMicros: number };
type AttentionJob = { id: string; kind: string; project_id: string | null; status: string; attempt: number; max_attempts: number; last_error: string | null; updated_at: string };
type Operations = { generatedAt: string; jobs: Record<string, Metric>; ingestion: { total: number; succeeded: number; failed: number }; qc: { total: number; passed: number; failed: number }; openIncidents: number; attention: AttentionJob[] };

function duration(value: number | null) {
  if (value === null) return '—';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function OperationsDashboard() {
  const [data, setData] = useState<Operations | null>(null);
  const [error, setError] = useState('');
  const refresh = () => fetch('/api/v1/operations', { cache: 'no-store' }).then(async (response) => { if (!response.ok) throw new Error(((await response.json()) as { error?: string }).error || '读取失败'); return response.json() as Promise<Operations>; }).then(setData);
  useEffect(() => { void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取失败')); }, []);
  const replay = async (job: AttentionJob) => {
    setError('');
    const response = await fetch(`/api/v1/jobs/${job.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': `replay:${job.id}:${job.updated_at}` }, body: JSON.stringify({ action: 'replay', note: '运营工作台人工确认重放' }) });
    if (!response.ok) { setError(((await response.json()) as { error?: string }).error || '重放失败'); return; }
    await refresh();
  };
  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b"><div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-7"><div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Activity className="size-5" /></div><div><p className="text-lg font-semibold">运行与 SLO</p><p className="text-xs text-muted-foreground">近 30 天作业、质量与事件</p></div></div><Link className={buttonVariants({ variant: 'outline' })} href="/"><ArrowLeft />返回雷达</Link></div></header>
    <div className="mx-auto max-w-6xl px-4 py-7 sm:px-7">{!data && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />读取运行数据…</p>}{error && <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</p>}{data && <><div className="grid gap-3 sm:grid-cols-3"><Summary icon={Activity} label="采集成功" value={`${data.ingestion.succeeded}/${data.ingestion.total}`} /><Summary icon={CircleAlert} label="开放事件" value={String(data.openIncidents)} /><Summary icon={Coins} label="记录成本单位" value={(Object.values(data.jobs).reduce((sum, item) => sum + item.costMicros, 0) / 1_000_000).toFixed(2)} /></div><section className="mt-7"><h1 className="text-3xl font-semibold tracking-[-0.04em]">作业健康度</h1><p className="mt-1 text-sm text-muted-foreground">生成于 {new Date(data.generatedAt).toLocaleString('zh-CN')}</p><div className="mt-4 overflow-hidden rounded-2xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/60 text-muted-foreground"><tr>{['类型','总数','成功','失败 / DLQ','重试','P50','P95'].map((value) => <th className="px-4 py-3 font-medium" key={value}>{value}</th>)}</tr></thead><tbody>{Object.entries(data.jobs).map(([kind, metric]) => <tr className="border-t" key={kind}><td className="px-4 py-3 font-mono">{kind}</td><td className="px-4 py-3">{metric.total}</td><td className="px-4 py-3">{metric.succeeded}</td><td className="px-4 py-3">{metric.failed} / {metric.deadLetter}</td><td className="px-4 py-3">{metric.retries}</td><td className="px-4 py-3">{duration(metric.p50Ms)}</td><td className="px-4 py-3">{duration(metric.p95Ms)}</td></tr>)}{!Object.keys(data.jobs).length && <tr><td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>近 30 天没有后台作业。</td></tr>}</tbody></table></div></section><section className="mt-7"><h2 className="text-2xl font-semibold tracking-tight">需要处置</h2><div className="mt-3 grid gap-3">{data.attention.map((job) => <article className="flex flex-col justify-between gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center" key={job.id}><div><p className="font-mono text-sm">{job.kind} · {job.status} · {job.attempt}/{job.max_attempts}</p><p className="mt-1 max-w-3xl text-sm text-muted-foreground">{job.last_error || '等待下一次重试'}</p></div>{['dead_letter','failed'].includes(job.status) && <Button variant="outline" onClick={() => void replay(job)}>确认并重放</Button>}</article>)}{!data.attention.length && <p className="rounded-xl border border-dashed p-7 text-center text-sm text-muted-foreground">当前没有失败、死信或重试中的作业。</p>}</div></section></>}</div>
  </main>;
}

function Summary({ icon: Icon, label, value }: { icon: typeof Clock3; label: string; value: string }) {
  return <article className="rounded-2xl border bg-card p-5"><Icon className="size-5 text-chart-1" /><p className="mt-4 text-sm text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></article>;
}
