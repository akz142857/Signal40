'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, CheckCircle2, DatabaseZap, LoaderCircle, Play, Plus, TriangleAlert } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';

type SourceRow = {
  id: string;
  name: string;
  adapter: 'rss' | 'http' | 'opencli' | 'csv';
  rights_status: string;
  enabled: number;
  version: number;
  schedule_cron: string | null;
  checkpoint: string | null;
  last_success_at: string | null;
  last_error: string | null;
  rate_limit_per_minute: number;
  retention_mode: 'metadata' | 'raw';
  retention_days: number;
  config: { sourceType?: string; url?: string };
};

async function errorText(response: Response) {
  try { return ((await response.json()) as { error?: string }).error ?? `请求失败（${response.status}）`; }
  catch { return `请求失败（${response.status}）`; }
}

export function SourceManager() {
  // 挂上会话：devIdentityHeaders 读的是它带回来的部署级开关。
  useSession();
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adapter, setAdapter] = useState<'rss' | 'http'>('rss');
  const [sourceType, setSourceType] = useState('media');
  const [cron, setCron] = useState('0 */2 * * *');
  const [rateLimit, setRateLimit] = useState('30');
  const [retentionMode, setRetentionMode] = useState<'metadata' | 'raw'>('metadata');
  const [retentionDays, setRetentionDays] = useState('30');
  const [message, setMessage] = useState('读取来源配置…');
  const [busy, setBusy] = useState(false);
  const runSequence = useRef(0);

  const refresh = useCallback(async () => {
    const response = await fetch('/api/v1/source-configs', { cache: 'no-store' });
    if (!response.ok) throw new Error(await errorText(response));
    const payload = (await response.json()) as { sources: SourceRow[] };
    setSources(payload.sources);
    setMessage(payload.sources.length ? `已配置 ${payload.sources.length} 个授权来源。` : '尚未配置自动来源。');
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '读取失败。')); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const createSource = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/source-configs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `source:${adapter}:${url}` },
        body: JSON.stringify({ name, adapter, sourceType, url, scheduleCron: cron || null, rightsStatus: 'approved', rateLimitPerMinute: Number(rateLimit), retention: { mode: retentionMode, days: Number(retentionDays) } }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      setName(''); setUrl('');
      await refresh();
      setMessage('来源已创建；定时配置已记录，可立即触发首次采集。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '创建失败。'); }
    finally { setBusy(false); }
  };

  const run = async (source: SourceRow) => {
    setBusy(true);
    try {
      runSequence.current += 1;
      const response = await fetch(`/api/v1/source-configs/${encodeURIComponent(source.id)}/runs`, {
        method: 'POST', headers: { 'idempotency-key': `manual:${source.id}:${runSequence.current}` },
      });
      if (!response.ok) throw new Error(await errorText(response));
      setMessage(`${source.name} 已进入后台采集队列。启动 Worker 后会抓取、校验、去重并刷新雷达。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '触发失败。'); }
    finally { setBusy(false); }
  };

  const toggleSource = async (source: SourceRow) => {
    setBusy(true);
    try {
      const enabled = !source.enabled;
      const response = await fetch(`/api/v1/source-configs/${encodeURIComponent(source.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', ...devIdentityHeaders({ role: 'admin', id: 'local-admin' }) },
        body: JSON.stringify({
          expectedVersion: source.version,
          enabled,
          name: source.name,
          adapter: source.adapter,
          sourceType: source.config.sourceType,
          url: source.config.url,
          scheduleCron: source.schedule_cron,
          rightsStatus: source.rights_status,
          rateLimitPerMinute: source.rate_limit_per_minute,
          retention: { mode: source.retention_mode, days: source.retention_days },
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      await refresh();
      setMessage(`${source.name} 已${enabled ? '启用' : '停用'}；配置版本和审计记录已更新。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '更新来源失败。'); }
    finally { setBusy(false); }
  };

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border/80 bg-background/95">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-7">
        <div className="flex items-center gap-3"><div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><DatabaseZap className="size-5" /></div><div><p className="text-lg font-semibold">来源控制台</p><p className="text-xs text-muted-foreground">授权、调度与采集健康度</p></div></div>
        <div className="flex gap-2"><Link className={buttonVariants({ variant: 'outline' })} href="/operations"><Activity />运行</Link><Link className={buttonVariants({ variant: 'outline' })} href="/"><ArrowLeft />返回雷达</Link></div>
      </div>
    </header>
    <div className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-7 lg:grid-cols-[360px_1fr]">
      <section className="h-fit rounded-2xl border bg-card p-5">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-chart-1">Authorized source</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.04em]">接入自动来源</h1>
        <p className="mt-2 text-sm text-muted-foreground">只允许已取得采集与内容使用授权的公网 RSS/JSON 端点。</p>
        <div className="mt-5 grid gap-4">
          <div className="grid gap-2"><Label htmlFor="source-name">来源名称</Label><Input id="source-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="公司公告 RSS" /></div>
          <div className="grid grid-cols-2 gap-3"><div className="grid gap-2"><Label htmlFor="adapter">适配器</Label><NativeSelect id="adapter" value={adapter} onChange={(event) => setAdapter(event.target.value as 'rss' | 'http')}><NativeSelectOption value="rss">RSS / Atom</NativeSelectOption><NativeSelectOption value="http">HTTP JSON</NativeSelectOption></NativeSelect></div><div className="grid gap-2"><Label htmlFor="source-type">来源类型</Label><NativeSelect id="source-type" value={sourceType} onChange={(event) => setSourceType(event.target.value)}>{['filing','company','market','media','social'].map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></div></div>
          <div className="grid gap-2"><Label htmlFor="source-url">公网 URL</Label><Input id="source-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/feed.xml" /></div>
          <div className="grid gap-2"><Label htmlFor="source-cron">调度（UTC Cron）</Label><Input id="source-cron" value={cron} onChange={(event) => setCron(event.target.value)} /><p className="text-xs text-muted-foreground">五字段格式；调度器每分钟扫描并补跑 7 天内遗漏时间点。</p></div>
          <div className="grid grid-cols-3 gap-3"><div className="grid gap-2"><Label htmlFor="source-rate">每分钟请求</Label><Input id="source-rate" type="number" min="1" max="600" value={rateLimit} onChange={(event) => setRateLimit(event.target.value)} /></div><div className="grid gap-2"><Label htmlFor="retention-mode">载荷保留</Label><NativeSelect id="retention-mode" value={retentionMode} onChange={(event) => setRetentionMode(event.target.value as 'metadata' | 'raw')}><NativeSelectOption value="metadata">仅元数据</NativeSelectOption><NativeSelectOption value="raw">保存原载荷</NativeSelectOption></NativeSelect></div><div className="grid gap-2"><Label htmlFor="retention-days">保留天数</Label><Input id="retention-days" type="number" min="1" max="3650" value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} /></div></div>
          <Button onClick={() => void createSource()} disabled={busy || !name || !url || Number(rateLimit) < 1 || Number(retentionDays) < 1}>{busy ? <LoaderCircle className="animate-spin" /> : <Plus />}保存授权来源</Button>
        </div>
      </section>
      <section>
        <div className="mb-4"><p className="font-mono text-xs uppercase tracking-[0.18em] text-chart-1">Ingestion operations</p><h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em]">采集运行</h2><output className="mt-2 block text-sm text-muted-foreground">{message}</output></div>
        <div className="grid gap-3">{sources.map((source) => <article key={source.id} className="rounded-2xl border bg-card p-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><div className="flex items-center gap-2">{source.last_error ? <TriangleAlert className="size-4 text-destructive" /> : <CheckCircle2 className="size-4 text-chart-1" />}<h3 className="font-semibold">{source.name}</h3><span className="rounded-md bg-secondary px-2 py-1 font-mono text-xs">{source.adapter}</span><span className="rounded-md border px-2 py-1 text-xs">{source.enabled ? '已启用' : '已停用'}</span></div><p className="mt-2 break-all text-sm text-muted-foreground">{source.config.url}</p><div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>类型 {source.config.sourceType}</span><span>调度 {source.schedule_cron || '手动'}</span><span>速率 {source.rate_limit_per_minute}/分钟</span><span>保留 {source.retention_mode} · {source.retention_days} 天</span><span>版本 {source.version}</span><span>最近成功 {source.last_success_at ? new Date(source.last_success_at).toLocaleString('zh-CN') : '尚无'}</span></div>{source.last_error && <p className="mt-2 text-sm text-destructive">{source.last_error}</p>}</div><div className="flex gap-2"><Button onClick={() => void toggleSource(source)} disabled={busy} variant="outline">{source.enabled ? '停用' : '启用'}</Button><Button onClick={() => void run(source)} disabled={busy || !source.enabled} variant="outline"><Play />立即采集</Button></div></div>
        </article>)}{!sources.length && <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">左侧添加第一个已授权来源。</div>}</div>
      </section>
    </div>
  </main>;
}
