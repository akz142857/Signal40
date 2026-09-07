'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight, BarChart3, CheckCircle2, CircleAlert, Clock3, ExternalLink,
  LoaderCircle, Radar, RotateCw, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { TopicCandidate } from '@/lib/domain';

type Filter = 'all' | 'high' | 'ready';

const statusLabel: Record<TopicCandidate['status'], string> = {
  ready: '证据门禁已通过',
  needs_primary_source: '待核验原始数据',
  needs_corroboration: '待交叉核验',
};

const breakdownLabels: Record<keyof TopicCandidate['scoreBreakdown'], string> = {
  resonance: '跨来源共振', velocity: '增长速度', numericImpact: '数字冲击力',
  sourceQuality: '来源质量', freshness: '时效性', explainability: '视频可解释性',
};

function scoreAccent(score: number) {
  if (score >= 85) return 'lime';
  if (score >= 75) return 'orange';
  return 'blue';
}

export function RadarDashboard({ initialTopics }: { initialTopics: TopicCandidate[] }) {
  const [topics, setTopics] = useState(initialTopics);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<TopicCandidate | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('');

  const filteredTopics = useMemo(() => topics.filter((topic) => {
    if (filter === 'high') return topic.score >= 80;
    if (filter === 'ready') return topic.gate.passed;
    return true;
  }), [filter, topics]);

  const runSamplePipeline = useCallback(async () => {
    setRunning(true);
    setMessage('');
    try {
      const response = await fetch('/api/topics', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ articles: [] }),
      });
      const payload = await response.json() as { topics?: TopicCandidate[]; storageMessage?: string; error?: string };
      if (!response.ok || !payload.topics) throw new Error(payload.error || '管道运行失败');
      setTopics(payload.topics);
      setMessage(payload.storageMessage || `已生成 ${payload.topics.length} 个候选主题。`);
      return { topicCount: payload.topics.length, topScore: payload.topics[0]?.score ?? 0 };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      setMessage(`运行失败：${detail}`);
      throw error;
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool({
        name: 'list_topic_candidates', title: '读取选题候选',
        description: '读取当前工作台中达到指定最低分数的财经选题候选。只读取，不修改状态。',
        inputSchema: { type: 'object', properties: { minScore: { type: 'integer', minimum: 0, maximum: 100, default: 0 } }, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: false },
        execute(input) {
          const value = input && typeof input === 'object' && 'minScore' in input ? Number((input as { minScore: unknown }).minScore) : 0;
          if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('minScore 必须是 0–100 的整数。');
          return topics.filter((topic) => topic.score >= value).map((topic) => ({ id: topic.id, title: topic.title, score: topic.score, status: topic.status, sourceCount: topic.sourceCount }));
        },
      }, { signal: lifecycle.signal });
      await context.registerTool({
        name: 'run_sample_topic_pipeline', title: '运行示例选题管道',
        description: '使用内置示例文章运行聚类、评分和证据门禁，并更新当前工作台。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async () => runSamplePipeline(),
      }, { signal: lifecycle.signal });
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [runSamplePipeline, topics]);

  const highCount = topics.filter((topic) => topic.score >= 80).length;
  const readyCount = topics.filter((topic) => topic.gate.passed).length;
  const lead = topics[0];
  const heat = lead ? [34, 42, 38, 51, 58, 66, Math.max(72, lead.score - 8), lead.score] : [];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-background/95">
        <div className="mx-auto flex max-w-[1480px] items-center justify-between px-4 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Radar className="size-5" aria-hidden="true" /></div>
            <div><p className="text-lg font-semibold tracking-[-0.03em]">Signal 40</p><p className="text-xs text-muted-foreground">财经选题雷达</p></div>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="hidden items-center gap-2 text-muted-foreground sm:flex"><span className="size-2 rounded-full bg-chart-1 shadow-[0_0_0_4px_var(--color-signal-glow)]" />管道就绪</span>
            <Button variant="outline" size="lg" onClick={() => void runSamplePipeline()} disabled={running}>
              {running ? <LoaderCircle className="animate-spin" /> : <RotateCw />} {running ? '运行中' : '运行采集'}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1480px] gap-5 px-4 py-5 sm:px-7 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <div className="mb-5 flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-end">
            <div>
              <p className="mb-2 font-mono text-xs uppercase tracking-[0.18em] text-chart-1">Daily radar / live sample</p>
              <h1 className="text-3xl font-semibold tracking-[-0.045em] sm:text-4xl">今天值得拍的财经题</h1>
              <p className="mt-2 max-w-2xl text-base text-muted-foreground">先发现跨来源共振，再回到财报、公告和市场数据核验。高分只代表值得研究，不代表事实已确认。</p>
              {message && <output className="mt-3 block text-sm font-medium">{message}</output>}
            </div>
            <div className="flex flex-wrap gap-2" aria-label="候选筛选">
              <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>全部 {topics.length}</FilterButton>
              <FilterButton active={filter === 'high'} onClick={() => setFilter('high')}>80 分以上 {highCount}</FilterButton>
              <FilterButton active={filter === 'ready'} onClick={() => setFilter('ready')}>可进入生产 {readyCount}</FilterButton>
            </div>
          </div>

          <div className="grid gap-3">
            {filteredTopics.map((topic, index) => (
              <article key={topic.id} className="group grid gap-4 rounded-2xl border border-border bg-card p-4 transition hover:border-foreground/25 sm:grid-cols-[70px_minmax(0,1fr)_auto] sm:p-5">
                <div className="flex items-start justify-between sm:block">
                  <span className="font-mono text-xs text-muted-foreground">#{String(index + 1).padStart(2, '0')}</span>
                  <div className={`score-ring score-ring--${scoreAccent(topic.score)} mt-0 sm:mt-3`} aria-label={`选题得分 ${topic.score}`}><span>{topic.score}</span></div>
                </div>
                <div className="min-w-0">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-secondary px-2 py-1 font-mono text-xs font-semibold text-secondary-foreground">热度 +{topic.heatChange}</span>
                    <span className="flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="size-3.5" />{topic.sourceCount} 个独立来源</span>
                  </div>
                  <h2 className="text-xl font-semibold leading-snug tracking-[-0.025em]">{topic.title}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">{topic.gate.reason}</p>
                  <div className="mt-4 flex flex-wrap gap-2">{topic.sources.map((source) => <span key={source} className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">{source}</span>)}</div>
                </div>
                <div className="flex items-end justify-between gap-3 border-t border-border pt-3 sm:w-44 sm:flex-col sm:items-end sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
                  <span className={`flex items-center gap-1.5 text-xs ${topic.gate.passed ? 'text-chart-1' : 'text-muted-foreground'}`}>
                    {topic.gate.passed ? <CheckCircle2 className="size-4" /> : <CircleAlert className="size-4" />}{statusLabel[topic.status]}
                  </span>
                  <Button variant="ghost" className="font-semibold group-hover:text-chart-1" onClick={() => setSelected(topic)}>查看证据 <ArrowUpRight /></Button>
                </div>
              </article>
            ))}
            {!filteredTopics.length && <div className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">当前筛选条件下没有候选题。</div>}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border p-4">
              <div><p className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Topic heat</p><h2 className="mt-1 font-semibold">{lead?.keywords[0]?.toUpperCase() || '主题'} 升温</h2></div>
              <span className="font-mono text-2xl font-semibold text-chart-1">{lead?.score ?? '—'}</span>
            </div>
            <div className="p-4"><div className="flex h-28 items-end gap-2" aria-label="头部选题热度走势">{heat.map((value, index) => <span key={`${value}-${index}`} className="flex-1 rounded-t bg-chart-1/20" style={{ height: `${value}%` }}><span className={`block w-full rounded-t bg-chart-1 ${index === heat.length - 1 ? 'h-full' : 'h-[7px]'}`} /></span>)}</div><div className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground"><span>8 小时前</span><span>现在</span></div></div>
          </section>

          {lead && <section className="rounded-2xl border border-border bg-card p-4">
            <div className="mb-4 flex items-center gap-2"><BarChart3 className="size-4 text-chart-2" /><h2 className="font-semibold">头部选题评分拆解</h2></div>
            <dl className="space-y-3 text-sm">{Object.entries(lead.scoreBreakdown).map(([key, score]) => <div key={key}><div className="mb-1 flex justify-between"><dt className="text-muted-foreground">{breakdownLabels[key as keyof TopicCandidate['scoreBreakdown']]}</dt><dd className="font-mono">{score}</dd></div><div className="h-1.5 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-chart-2" style={{ width: `${score}%` }} /></div></div>)}</dl>
          </section>}

          <section className="rounded-2xl border border-chart-3/40 bg-chart-3/10 p-4"><div className="flex gap-3"><ShieldCheck className="mt-0.5 size-5 shrink-0 text-chart-3" /><div><h2 className="font-semibold">脚本前核验门禁</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">至少找到 1 个原始来源，并有独立证据交叉支持，才可生成视频协议。</p></div></div></section>
        </aside>
      </div>

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl" side="right">
          {selected && <>
            <SheetHeader className="border-b border-border p-6 pr-14"><p className="font-mono text-xs uppercase tracking-[0.15em] text-chart-1">Evidence trail</p><SheetTitle className="mt-2 text-2xl leading-tight">{selected.title}</SheetTitle><SheetDescription>{selected.gate.reason}</SheetDescription></SheetHeader>
            <div className="space-y-6 p-6">
              <section><h3 className="mb-3 font-semibold">评分拆解</h3><div className="grid grid-cols-2 gap-2">{Object.entries(selected.scoreBreakdown).map(([key, score]) => <div key={key} className="rounded-xl bg-secondary/70 p-3"><p className="text-xs text-muted-foreground">{breakdownLabels[key as keyof TopicCandidate['scoreBreakdown']]}</p><p className="mt-1 font-mono text-xl font-semibold">{score}</p></div>)}</div></section>
              <section><h3 className="mb-3 font-semibold">来源证据 · {selected.articles.length}</h3><div className="space-y-2">{selected.articles.map((article) => <article key={article.id} className="rounded-xl border border-border p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-medium text-muted-foreground">{article.source} · {article.sourceType}</p><h4 className="mt-1 font-semibold leading-snug">{article.title}</h4></div><a href={article.url} target="_blank" rel="noreferrer" className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground" aria-label={`打开来源：${article.title}`}><ExternalLink className="size-4" /></a></div>{article.summary && <p className="mt-2 text-sm leading-6 text-muted-foreground">{article.summary}</p>}</article>)}</div></section>
              <section className={`rounded-xl border p-4 ${selected.gate.passed ? 'border-chart-1/50 bg-chart-1/10' : 'border-chart-2/50 bg-chart-2/10'}`}><div className="flex gap-3">{selected.gate.passed ? <CheckCircle2 className="size-5 text-chart-1" /> : <CircleAlert className="size-5 text-chart-2" />}<div><h3 className="font-semibold">{selected.gate.passed ? '可以进入脚本生产' : '暂不可进入脚本生产'}</h3><p className="mt-1 text-sm text-muted-foreground">原始来源：{selected.gate.hasPrimarySource ? '已找到' : '未找到'}；独立来源：{selected.gate.independentSourceCount} 个。</p></div></div></section>
            </div>
          </>}
        </SheetContent>
      </Sheet>
    </main>
  );
}

function FilterButton({ active, ...props }: React.ComponentProps<typeof Button> & { active: boolean }) {
  return <Button variant={active ? 'default' : 'outline'} className="rounded-full" {...props} />;
}
