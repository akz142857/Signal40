'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  ExternalLink,
  FileUp,
  Film,
  LoaderCircle,
  Radar,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';
import { Label } from '@/components/ui/label';
import { PageContainer, PageHeader } from '@/components/page-shell';
import type {
  ArticleInput,
  TopicCandidate,
  VerificationStatus,
} from '@/lib/domain';
import { parseArticleImport } from '@/lib/import';

type Filter = 'all' | 'high' | 'ready';

const breakdownLabels: Record<keyof TopicCandidate['scoreBreakdown'], string> =
  {
    resonance: '跨来源共振',
    velocity: '增长速度',
    numericImpact: '数字冲击力',
    sourceQuality: '来源质量',
    freshness: '时效性',
    explainability: '视频可解释性',
  };

function scoreAccent(score: number) {
  if (score >= 85) return 'lime';
  if (score >= 75) return 'orange';
  return 'blue';
}

function candidateState(topic: TopicCandidate) {
  if (topic.verificationStatus === 'verified')
    return {
      label: '编辑已批准',
      className: 'text-chart-1',
      icon: CheckCircle2,
    };
  if (topic.verificationStatus === 'rejected')
    return {
      label: '编辑已驳回',
      className: 'text-destructive',
      icon: XCircle,
    };
  if (topic.gate.passed)
    return {
      label: '待人工核验',
      className: 'text-chart-3',
      icon: ShieldCheck,
    };
  return {
    label:
      topic.status === 'needs_primary_source' ? '缺少原始来源' : '缺少交叉证据',
    className: 'text-muted-foreground',
    icon: CircleAlert,
  };
}

async function readError(response: Response) {
  try {
    const payload = (await response.json()) as {
      error?: string;
      issues?: Array<{ row: number; message: string }>;
    };
    const issues = payload.issues
      ?.map((item) => `第 ${item.row} 条：${item.message}`)
      .join('；');
    return issues || payload.error || `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export function RadarDashboard({
  initialTopics,
}: {
  initialTopics: TopicCandidate[];
}) {
  // 挂上会话：devIdentityHeaders 读的是它带回来的部署级开关。
  useSession();
  const [topics, setTopics] = useState(initialTopics);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<TopicCandidate | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('正在读取最新数据…');
  const [sourceLabel, setSourceLabel] = useState('预览数据');
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importRightsConfirmed, setImportRightsConfirmed] = useState(false);
  const [verificationNote, setVerificationNote] = useState('');

  const refreshTopics = useCallback(async () => {
    const response = await fetch('/api/topics', { cache: 'no-store' });
    if (!response.ok) throw new Error(await readError(response));
    const payload = (await response.json()) as {
      topics: TopicCandidate[];
      source: string;
      runAt: string | null;
    };
    setTopics(payload.topics);
    setSelected((current) =>
      current
        ? (payload.topics.find((topic) => topic.id === current.id) ?? null)
        : null,
    );
    setSourceLabel(
      payload.source === 'empty' ? '暂无数据' : '已导入数据',
    );
    setMessage(
      payload.runAt
        ? `最近运行：${new Date(payload.runAt).toLocaleString('zh-CN')}`
        : '尚无已保存运行，请登记授权来源或导入文章。',
    );
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshTopics().catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : '读取失败。'),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshTopics]);

  useEffect(() => {
    const topicId = new URLSearchParams(window.location.search).get('topic');
    const timer = window.setTimeout(() => {
      if (topicId) setSelected(topics.find((topic) => topic.id === topicId) ?? null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [topics]);

  const runPipeline = useCallback(
    async (body: { articles: ArticleInput[]; rightsConfirmed: true }) => {
      setRunning(true);
      try {
        const response = await fetch('/api/topics', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `pipeline:${crypto.randomUUID()}`,
            ...devIdentityHeaders({ role: 'researcher', id: 'local-researcher' }),
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(await readError(response));
        const payload = (await response.json()) as {
          topics: TopicCandidate[];
          source: 'import';
          runAt: string;
        };
        setTopics(payload.topics);
        setSelected((current) =>
          current
            ? (payload.topics.find((topic) => topic.id === current.id) ?? null)
            : null,
        );
        setSourceLabel('已导入数据');
        setMessage(`已分析并保存 ${payload.topics.length} 个候选主题。`);
        return {
          topicCount: payload.topics.length,
          topScore: payload.topics[0]?.score ?? 0,
        };
      } finally {
        setRunning(false);
      }
    },
    [],
  );


  const importArticles = useCallback(
    async (articles: ArticleInput[], rightsConfirmed: boolean) => {
      if (!rightsConfirmed)
        throw new Error('请先确认这些文章元数据已获得使用授权。');
      const result = await runPipeline({ articles, rightsConfirmed: true });
      setImportOpen(false);
      setImportText('');
      setImportRightsConfirmed(false);
      return result;
    },
    [runPipeline],
  );

  const submitImport = async () => {
    try {
      const articles = parseArticleImport(importText);
      await importArticles(articles, importRightsConfirmed);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '导入失败。');
    }
  };

  const reviewTopic = useCallback(
    async (topicId: string, status: VerificationStatus, note = '') => {
      const response = await fetch(
        `/api/topics/${encodeURIComponent(topicId)}/verification`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `verification:${topicId}:${crypto.randomUUID()}`,
            ...devIdentityHeaders({ role: 'editor', id: 'local-editor' }),
          },
          body: JSON.stringify({ status, note }),
        },
      );
      if (!response.ok) throw new Error(await readError(response));
      const payload = (await response.json()) as { topic: TopicCandidate };
      setTopics((current) =>
        current.map((topic) => (topic.id === topicId ? payload.topic : topic)),
      );
      setSelected(payload.topic);
      setVerificationNote(payload.topic.verificationNote);
      setMessage(
        status === 'verified'
          ? '选题已批准，可以导出视频协议。'
          : status === 'rejected'
            ? '选题已驳回。'
            : '选题已恢复待核验状态。',
      );
      return { id: topicId, verificationStatus: status };
    },
    [],
  );

  const downloadVideoProject = async (topic: TopicCandidate) => {
    const response = await fetch(
      `/api/topics/${encodeURIComponent(topic.id)}/video-project`,
    );
    if (!response.ok) {
      setMessage(await readError(response));
      return;
    }
    const project = await response.json();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(project, null, 2)], {
        type: 'application/json',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${topic.id}.project.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage('2.0 视频项目协议已导出，可进入全流程工作台。');
  };

  const startProduction = async (topic: TopicCandidate) => {
    const response = await fetch('/api/v1/projects', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `project:${topic.id}`,
      },
      body: JSON.stringify({ topicId: topic.id }),
    });
    if (!response.ok) {
      setMessage(await readError(response));
      return;
    }
    const payload = (await response.json()) as { project: { id: string } };
    window.location.href = `/projects/${encodeURIComponent(payload.project.id)}`;
  };

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool(
        {
          name: 'list_topic_candidates',
          title: '读取选题候选',
          description: '读取当前工作台中达到指定最低分数的财经选题候选。',
          inputSchema: {
            type: 'object',
            properties: {
              minScore: {
                type: 'integer',
                minimum: 0,
                maximum: 100,
                default: 0,
              },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute(input) {
            const value =
              input && typeof input === 'object' && 'minScore' in input
                ? Number((input as { minScore: unknown }).minScore)
                : 0;
            if (!Number.isInteger(value) || value < 0 || value > 100)
              throw new Error('minScore 必须是 0–100 的整数。');
            return topics
              .filter((topic) => topic.score >= value)
              .map((topic) => ({
                id: topic.id,
                title: topic.title,
                score: topic.score,
                evidenceGate: topic.gate.passed,
                verificationStatus: topic.verificationStatus,
              }));
          },
        },
        { signal: lifecycle.signal },
      );
      await context.registerTool(
        {
          name: 'import_topic_articles',
          title: '导入文章并分析',
          description:
            '导入已经获得授权的财经文章元数据，运行聚类评分并保存结果。',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['articles', 'rightsConfirmed'],
            properties: {
              articles: {
                type: 'array',
                minItems: 1,
                maxItems: 100,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'source',
                    'sourceType',
                    'title',
                    'url',
                    'publishedAt',
                  ],
                  properties: {
                    source: { type: 'string', minLength: 1, maxLength: 160 },
                    sourceType: {
                      enum: ['social', 'media', 'market', 'filing', 'company'],
                    },
                    author: { type: 'string', maxLength: 160 },
                    title: { type: 'string', minLength: 1, maxLength: 500 },
                    summary: { type: 'string', maxLength: 4000 },
                    url: { type: 'string', maxLength: 2000 },
                    publishedAt: { type: 'string' },
                    metrics: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        views: { type: 'integer', minimum: 0 },
                        likes: { type: 'integer', minimum: 0 },
                        recommends: { type: 'integer', minimum: 0 },
                      },
                    },
                  },
                },
              },
              rightsConfirmed: {
                type: 'boolean',
                description:
                  '必须为 true，表示操作者已确认文章元数据具备使用授权。',
              },
            },
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (
              !input ||
              typeof input !== 'object' ||
              !('articles' in input) ||
              !Array.isArray((input as { articles: unknown }).articles) ||
              (input as { rightsConfirmed?: unknown }).rightsConfirmed !== true
            )
              throw new Error('articles 必须是数组，且 rightsConfirmed 必须为 true。');
            const articles = parseArticleImport(
              JSON.stringify({
                articles: (input as { articles: unknown[] }).articles,
              }),
            );
            return importArticles(articles, true);
          },
        },
        { signal: lifecycle.signal },
      );
      await context.registerTool(
        {
          name: 'review_topic_candidate',
          title: '核验选题候选',
          description:
            '将选题标记为已批准、已驳回或待核验；批准前必须通过自动证据门禁。',
          inputSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['topicId', 'status'],
            properties: {
              topicId: { type: 'string' },
              status: { enum: ['unreviewed', 'verified', 'rejected'] },
              note: { type: 'string', maxLength: 1000, default: '' },
            },
          },
          annotations: { readOnlyHint: false, untrustedContentHint: true },
          execute: async (input) => {
            if (!input || typeof input !== 'object')
              throw new Error('输入必须是对象。');
            const body = input as {
              topicId?: unknown;
              status?: unknown;
              note?: unknown;
            };
            if (
              typeof body.topicId !== 'string' ||
              !['unreviewed', 'verified', 'rejected'].includes(
                String(body.status),
              )
            )
              throw new Error('topicId 或 status 无效。');
            if (
              body.status !== 'unreviewed' &&
              (typeof body.note !== 'string' || body.note.trim().length < 10)
            )
              throw new Error('批准或驳回时，note 至少需要 10 个字符。');
            return reviewTopic(
              body.topicId,
              body.status as VerificationStatus,
              typeof body.note === 'string' ? body.note : '',
            );
          },
        },
        { signal: lifecycle.signal },
      );
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [importArticles, reviewTopic, topics]);

  const filteredTopics = useMemo(
    () =>
      topics.filter((topic) => {
        if (filter === 'high') return topic.score >= 80;
        if (filter === 'ready')
          return topic.gate.passed && topic.verificationStatus === 'verified';
        return true;
      }),
    [filter, topics],
  );
  const highCount = topics.filter((topic) => topic.score >= 80).length;
  const readyCount = topics.filter(
    (topic) => topic.gate.passed && topic.verificationStatus === 'verified',
  ).length;
  const lead = topics[0];
  const heat = lead
    ? [34, 42, 38, 51, 58, 66, Math.max(72, lead.score - 8), lead.score]
    : [];

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PageHeader
        icon={<Radar className="size-5" />}
        title="选题雷达"
        subtitle="今天值得拍的财经题：高分表示值得研究，只有通过自动证据门禁并经人工批准才能导出视频协议。"
        actions={<>
          <span className="hidden items-center gap-2 text-sm text-muted-foreground xl:flex">
            <span className="size-2 rounded-full bg-chart-1 shadow-[0_0_0_4px_var(--color-signal-glow)]" />
            {sourceLabel}
          </span>
          <Button variant="outline" onClick={() => setImportOpen(true)}><FileUp />导入文章</Button>
        </>}
      />

      <PageContainer className="grid gap-5 py-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <div className="mb-5 flex flex-col justify-between gap-4 border-b border-border pb-5 sm:flex-row sm:items-end">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-chart-1">
                Daily radar / {sourceLabel}
              </p>
              {message && (
                <output className="mt-2 block text-sm font-medium">
                  {message}
                </output>
              )}
            </div>
            <div className="flex flex-wrap gap-2" aria-label="候选筛选">
              <FilterButton
                active={filter === 'all'}
                onClick={() => setFilter('all')}
              >
                全部 {topics.length}
              </FilterButton>
              <FilterButton
                active={filter === 'high'}
                onClick={() => setFilter('high')}
              >
                80 分以上 {highCount}
              </FilterButton>
              <FilterButton
                active={filter === 'ready'}
                onClick={() => setFilter('ready')}
              >
                可生成 {readyCount}
              </FilterButton>
            </div>
          </div>

          <div className="grid gap-3">
            {filteredTopics.map((topic, index) => {
              const state = candidateState(topic);
              const StateIcon = state.icon;
              return (
                <article
                  key={topic.id}
                  className="group grid gap-4 rounded-2xl border border-border bg-card p-4 transition hover:border-foreground/25 sm:grid-cols-[70px_minmax(0,1fr)_auto] sm:p-5"
                >
                  <div className="flex items-start justify-between sm:block">
                    <span className="font-mono text-xs text-muted-foreground">
                      #{String(index + 1).padStart(2, '0')}
                    </span>
                    <div
                      className={`score-ring score-ring--${scoreAccent(topic.score)} sm:mt-3`}
                      aria-label={`选题得分 ${topic.score}`}
                    >
                      <span>{topic.score}</span>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-md bg-secondary px-2 py-1 font-mono text-xs font-semibold">
                        热度 +{topic.heatChange}
                      </span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock3 className="size-3.5" />
                        {topic.sourceCount} 个独立来源
                      </span>
                      {topic.quality && <span className={`rounded-md px-2 py-1 text-xs font-medium ${topic.quality.automatable ? 'bg-chart-1/10 text-chart-1' : 'bg-chart-2/10 text-chart-2'}`}>
                        {topic.quality.automatable ? '可自动化' : '需人工处理'}
                      </span>}
                    </div>
                    <h2 className="text-xl font-semibold leading-snug tracking-[-0.025em]">
                      {topic.title}
                    </h2>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {topic.gate.reason}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {topic.sources.map((source) => (
                        <span
                          key={source}
                          className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
                        >
                          {source}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-end justify-between gap-3 border-t border-border pt-3 sm:w-44 sm:flex-col sm:items-end sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
                    <span
                      className={`flex items-center gap-1.5 text-xs ${state.className}`}
                    >
                      <StateIcon className="size-4" />
                      {state.label}
                    </span>
                    <Button
                      variant="ghost"
                      className="font-semibold group-hover:text-chart-1"
                      onClick={() => {
                        setSelected(topic);
                        setVerificationNote(topic.verificationNote);
                      }}
                    >
                      查看证据 <ArrowUpRight />
                    </Button>
                  </div>
                </article>
              );
            })}
            {!filteredTopics.length && (
              <div className="rounded-2xl border border-dashed border-border p-10 text-center text-muted-foreground">
                当前筛选条件下没有候选题。
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border p-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">
                  Topic heat
                </p>
                <h2 className="mt-1 font-semibold">
                  {lead?.keywords[0]?.toUpperCase() || '主题'} 升温
                </h2>
              </div>
              <span className="font-mono text-2xl font-semibold text-chart-1">
                {lead?.score ?? '—'}
              </span>
            </div>
            <div className="p-4">
              <div
                className="flex h-28 items-end gap-2"
                aria-label="头部选题热度走势"
              >
                {heat.map((value, index) => (
                  <span
                    key={`${value}-${index}`}
                    className="flex-1 rounded-t bg-chart-1/20"
                    style={{ height: `${value}%` }}
                  >
                    <span
                      className={`block w-full rounded-t bg-chart-1 ${index === heat.length - 1 ? 'h-full' : 'h-[7px]'}`}
                    />
                  </span>
                ))}
              </div>
              <div className="mt-2 flex justify-between font-mono text-[11px] text-muted-foreground">
                <span>8 小时前</span>
                <span>现在</span>
              </div>
            </div>
          </section>
          {lead && (
            <section className="rounded-2xl border border-border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <BarChart3 className="size-4 text-chart-2" />
                <h2 className="font-semibold">头部选题评分拆解</h2>
              </div>
              <dl className="space-y-3 text-sm">
                {Object.entries(lead.scoreBreakdown).map(([key, score]) => (
                  <div key={key}>
                    <div className="mb-1 flex justify-between">
                      <dt className="text-muted-foreground">
                        {
                          breakdownLabels[
                            key as keyof TopicCandidate['scoreBreakdown']
                          ]
                        }
                      </dt>
                      <dd className="font-mono">{score}</dd>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-chart-2"
                        style={{ width: `${score}%` }}
                      />
                    </div>
                  </div>
                ))}
              </dl>
            </section>
          )}
          <section className="rounded-2xl border border-chart-3/40 bg-chart-3/10 p-4">
            <div className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-chart-3" />
              <div>
                <h2 className="font-semibold">双重生产门禁</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  原始来源与独立证据先自动检查，再由编辑核验批准。两项缺一不可。
                </p>
              </div>
            </div>
          </section>
        </aside>
      </PageContainer>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl">导入文章并分析</DialogTitle>
            <DialogDescription>
              粘贴 JSON 数组、包含 articles 的 JSON 对象，或 CSV。每次最多 100
              篇；仅导入已获授权的文章元数据。
            </DialogDescription>
          </DialogHeader>
          <Textarea
            className="min-h-64 font-mono text-xs"
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            placeholder={
              'source,sourceType,title,url,publishedAt,summary\n财经来源,media,标题,https://example.com/a,2026-09-08T02:00:00Z,摘要'
            }
          />
          <p className="text-xs text-muted-foreground">
            sourceType：social / media / market / filing / company
          </p>
          <Label className="items-start rounded-xl border border-border p-4 leading-5">
            <Checkbox
              className="mt-0.5"
              checked={importRightsConfirmed}
              onCheckedChange={(checked) =>
                setImportRightsConfirmed(checked === true)
              }
            />
            <span>
              我确认这些文章元数据已获得使用授权，并理解原文内容不会被自动视为可再发布素材。
            </span>
          </Label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setImportOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void submitImport()}
              disabled={
                running || !importText.trim() || !importRightsConfirmed
              }
            >
              {running ? <LoaderCircle className="animate-spin" /> : <FileUp />}{' '}
              导入并分析
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        {/*
          证据抽屉要能和列表并排读，宽度取半屏，窄屏仍是整屏。
          变体链必须和 ui/sheet 的默认值一模一样，否则 twMerge 去不掉默认的
          sm:max-w-sm，那个带属性选择器的类权重更高，会把这里的宽度压回去。
        */}
        <SheetContent
          className="w-full overflow-y-auto data-[side=right]:sm:max-w-[50vw]"
          side="right"
        >
          {selected && (
            <>
              <SheetHeader className="border-b border-border p-6 pr-14">
                <p className="font-mono text-xs uppercase tracking-[0.15em] text-chart-1">
                  Evidence trail
                </p>
                <SheetTitle className="mt-2 text-2xl leading-tight">
                  {selected.title}
                </SheetTitle>
                <SheetDescription>{selected.gate.reason}</SheetDescription>
              </SheetHeader>
              <div className="space-y-6 p-6">
                <section>
                  <h3 className="mb-3 font-semibold">自动化质量指标</h3>
                  {selected.quality ? <>
                    <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                      {[
                        ['簇内一致性', selected.quality.coherence],
                        ['一致性下限', selected.quality.coherenceFloor],
                        ['证据区分度', selected.quality.evidenceDistinctness],
                        ['财经词表覆盖', selected.quality.lexiconCoverage],
                      ].map(([label, value]) => <div className="rounded-xl bg-secondary/70 p-3" key={String(label)}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-mono text-xl font-semibold">{Math.round(Number(value) * 100)}%</p></div>)}
                    </div>
                    <p className="mt-3 text-sm">综合质量分：{selected.quality.score}/100 · 语言：{selected.quality.language} · {selected.quality.automatable ? '允许自动建项目' : '禁止自动建项目'}</p>
                    {selected.quality.reasons.length > 0 && <ul className="mt-2 space-y-1 text-sm leading-6 text-chart-2">{selected.quality.reasons.map((reason) => <li key={reason}>• {reason}</li>)}</ul>}
                  </> : <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">尚未评估；下一轮调度器会计算质量指标。</p>}
                </section>
                <section>
                  <h3 className="mb-3 font-semibold">评分拆解</h3>
                  <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                    {Object.entries(selected.scoreBreakdown).map(
                      ([key, score]) => (
                        <div
                          key={key}
                          className="rounded-xl bg-secondary/70 p-3"
                        >
                          <p className="text-xs text-muted-foreground">
                            {
                              breakdownLabels[
                                key as keyof TopicCandidate['scoreBreakdown']
                              ]
                            }
                          </p>
                          <p className="mt-1 font-mono text-xl font-semibold">
                            {score}
                          </p>
                        </div>
                      ),
                    )}
                  </div>
                </section>
                <section>
                  <h3 className="mb-3 font-semibold">
                    来源证据 · {selected.articles.length}
                  </h3>
                  <div className="space-y-2">
                    {selected.articles.map((article) => (
                      <article
                        key={article.id}
                        className="rounded-xl border border-border p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs font-medium text-muted-foreground">
                              {article.source} · {article.sourceType}
                            </p>
                            <h4 className="mt-1 font-semibold leading-snug">
                              {article.title}
                            </h4>
                          </div>
                          <a
                            href={article.url}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded-lg border border-border p-2 text-muted-foreground hover:text-foreground"
                            aria-label={`打开来源：${article.title}`}
                          >
                            <ExternalLink className="size-4" />
                          </a>
                        </div>
                        {article.summary && (
                          <p className="mt-2 text-sm leading-6 text-muted-foreground">
                            {article.summary}
                          </p>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
                <section className="rounded-xl border border-border p-4">
                  <h3 className="font-semibold">编辑核验</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    批准前请打开原始来源，核对关键数字、时间范围与口径。批准或驳回需填写至少
                    10 个字符，备注会随核验事件保存。
                  </p>
                  <Textarea
                    className="mt-3 min-h-24"
                    value={verificationNote}
                    onChange={(event) =>
                      setVerificationNote(event.target.value)
                    }
                    maxLength={1000}
                    placeholder="记录核验结论、数字口径或驳回原因"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      onClick={() =>
                        void reviewTopic(
                          selected.id,
                          'verified',
                          verificationNote,
                        ).catch((error: unknown) =>
                          setMessage(
                            error instanceof Error
                              ? error.message
                              : '批准失败。',
                          ),
                        )
                      }
                      disabled={
                        !selected.gate.passed ||
                        verificationNote.trim().length < 10
                      }
                    >
                      批准进入生产
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        void reviewTopic(
                          selected.id,
                          'rejected',
                          verificationNote,
                        ).catch((error: unknown) =>
                          setMessage(
                            error instanceof Error
                              ? error.message
                              : '驳回失败。',
                          ),
                        )
                      }
                      disabled={verificationNote.trim().length < 10}
                    >
                      驳回
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        void reviewTopic(
                          selected.id,
                          'unreviewed',
                          verificationNote,
                        ).catch((error: unknown) =>
                          setMessage(
                            error instanceof Error
                              ? error.message
                              : '更新失败。',
                          ),
                        )
                      }
                    >
                      恢复待核验
                    </Button>
                  </div>
                </section>
                <section
                  className={`rounded-xl border p-4 ${selected.verificationStatus === 'verified' ? 'border-chart-1/50 bg-chart-1/10' : 'border-chart-2/50 bg-chart-2/10'}`}
                >
                  <div className="flex gap-3">
                    <ShieldCheck className="size-5" />
                    <div className="flex-1">
                      <h3 className="font-semibold">
                        {selected.verificationStatus === 'verified'
                          ? '可以生成视频协议'
                          : '视频协议已锁定'}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        自动门禁：{selected.gate.passed ? '通过' : '未通过'}
                        ；编辑状态：{candidateState(selected).label}。
                      </p>
                      {selected.verificationStatus === 'verified' && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button onClick={() => void startProduction(selected)}>
                            <Film /> 进入制作工作台
                          </Button>
                          <Button variant="outline" onClick={() => void downloadVideoProject(selected)}>
                            <Download /> 导出 project.json
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </main>
  );
}

function FilterButton({
  active,
  ...props
}: React.ComponentProps<typeof Button> & { active: boolean }) {
  return (
    <Button
      variant={active ? 'default' : 'outline'}
      className="rounded-full"
      {...props}
    />
  );
}
