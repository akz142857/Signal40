'use client';

import { useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  CircleAlert,
  Clock3,
  Coins,
  Cpu,
  LoaderCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageContainer, PageHeader } from '@/components/page-shell';

type Metric = {
  total: number;
  succeeded: number;
  failed: number;
  deadLetter: number;
  retries: number;
  p50Ms: number | null;
  p95Ms: number | null;
  costMicros: number;
};
type AttentionJob = {
  id: string;
  kind: string;
  project_id: string | null;
  status: string;
  attempt: number;
  max_attempts: number;
  last_error: string | null;
  updated_at: string;
};
type SourceWindow = {
  days: 7 | 28;
  total: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  burnRate: number | null;
  sampleSufficient: boolean;
  requests: number;
  bytes: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  p95FreshnessMs: number | null;
  estimatedCostMicros: number;
  expectedTriggers: number | null;
  observedTriggers: number | null;
  triggerRate: number | null;
  triggerBurnRate: number | null;
  triggerSampleSufficient: boolean | null;
  outcomes: {
    succeeded: number;
    partial: number;
    failed: number;
    rightsBlocked: number;
    cancelled: number;
    inProgress: number;
    manual: number;
    backfill: number;
    modified: number;
    notModified: number;
    unknownFetchOutcome: number;
    excluded: number;
    budgetThrottled: number;
  };
};
type SourceSlo = {
  sourceId: string;
  name: string;
  platform: string;
  enabled: boolean;
  healthStatus: string;
  status: 'healthy' | 'warning' | 'breaching' | 'insufficient_data';
  target: number;
  windows: { days7: SourceWindow; days28: SourceWindow };
  freshness: {
    p95Ms: number | null;
    targetMs: number | null;
    withinTarget: boolean | null;
  };
  quota: {
    triggerLimitPerMinute: number;
    triggersLastMinute: number;
    remainingTriggers: number;
  };
  budget: {
    mode: 'unpriced' | 'unlimited' | 'tracking' | 'soft_limit' | 'exhausted';
    costMicrosPerRequest: number;
    monthSpentMicros: number;
    monthlyBudgetMicros: number;
    softLimitPercent: number;
    usedPercent: number | null;
    remainingMicros: number | null;
    projectedMonthEndMicros: number | null;
    estimatedExhaustionAt: string | null;
    affectedArticleCount: number;
    affectedTopicCount: number;
    schedulePriority: number;
    autoThrottleEnabled: boolean;
    effectiveScheduleMultiplier: number;
    throttleReason: string | null;
    throttleRecoveryAt: string | null;
  };
  exclusions: Array<{
    kind: 'manual_pause' | 'planned_maintenance';
    startsAt: string;
    endsAt: string | null;
    reason: string;
  }>;
};
type SourceSloDimension = {
  kind: 'connector' | 'connector_version' | 'platform' | 'capability';
  key: string;
  label: string;
  sourceCount: number;
  status: SourceSlo['status'];
  windows: {
    days7: SourceWindow & { worstSourceP95FreshnessMs: number | null };
    days28: SourceWindow & { worstSourceP95FreshnessMs: number | null };
  };
};
type Operations = {
  generatedAt: string;
  jobs: Record<string, Metric>;
  ingestion: { total: number; succeeded: number; failed: number };
  qc: { total: number; passed: number; failed: number };
  openIncidents: number;
  attention: AttentionJob[];
  sourceSlo: {
    policy: {
      version: string;
      eligibleFailureStatuses: readonly string[];
      separatelyReportedStatuses: readonly string[];
      fetchOutcomes: readonly string[];
      alertDestinations: readonly string[];
    };
    dataComplete: boolean;
    snapshots: SourceSlo[];
    dimensions: SourceSloDimension[];
  };
};
type WorkerRow = {
  id: string;
  hostname: string;
  kinds: string[];
  lastHeartbeatAt: string;
  online: boolean;
};
type Backlog = {
  kind: string;
  waiting: number;
  leased: number;
  deadLetter: number;
};
type WorkerView = {
  workers: WorkerRow[];
  backlog: Backlog[];
  orphanedJobs: Array<{ id: string; kind: string; projectId: string | null }>;
};
type AutomationRun = {
  id: string;
  status: string;
  startedAt: string;
  projectCount: number;
  actions: unknown[];
  ageSeconds: number;
};

function duration(value: number | null) {
  if (value === null) return '—';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function rate(value: number | null) {
  return value === null ? '—' : `${(value * 100).toFixed(2)}%`;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

function moneyMicros(value: number) {
  return `$${(value / 1_000_000).toFixed(2)}`;
}

function sourceStatus(status: SourceSlo['status']) {
  if (status === 'healthy') return '达标';
  if (status === 'breaching') return '错误预算告警';
  if (status === 'warning') return '未达目标';
  return '样本不足';
}

function dimensionName(kind: SourceSloDimension['kind']) {
  if (kind === 'connector') return '连接器';
  if (kind === 'connector_version') return '连接器版本';
  if (kind === 'platform') return '平台';
  return 'Worker 能力';
}

function budgetStatus(mode: SourceSlo['budget']['mode']) {
  if (mode === 'unpriced') return '成本未建模';
  if (mode === 'unlimited') return '仅跟踪，不限额';
  if (mode === 'soft_limit') return '已到软阈值';
  if (mode === 'exhausted') return '硬预算耗尽';
  return '预算内';
}

export function OperationsDashboard() {
  const [data, setData] = useState<Operations | null>(null);
  const [workerView, setWorkerView] = useState<WorkerView | null>(null);
  const [lastRun, setLastRun] = useState<AutomationRun | null>(null);
  const [error, setError] = useState('');
  const refresh = async () => {
    const response = await fetch('/api/v1/operations', { cache: 'no-store' });
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { error?: string }).error || '读取失败',
      );
    setData((await response.json()) as Operations);
    const workerResponse = await fetch('/api/v1/workers', {
      cache: 'no-store',
    });
    if (workerResponse.ok)
      setWorkerView((await workerResponse.json()) as WorkerView);
    const runResponse = await fetch('/api/v1/automation/runs?limit=1', {
      cache: 'no-store',
    });
    if (runResponse.ok) {
      const run = ((await runResponse.json()) as { runs: AutomationRun[] })
        .runs[0];
      // 距今多久在这里算好：渲染期间读时钟会让同一份数据每次重渲染都不一样。
      setLastRun(
        run
          ? {
              ...run,
              ageSeconds: Math.round(
                (Date.now() - new Date(run.startedAt).valueOf()) / 1000,
              ),
            }
          : null,
      );
    }
  };
  // 用 setTimeout 把首次拉取推到 effect 之后：在 effect 体里同步触发 setState 会引起级联渲染。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : '读取失败'),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const replay = async (job: AttentionJob) => {
    setError('');
    const response = await fetch(`/api/v1/jobs/${job.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `replay:${job.id}:${job.updated_at}`,
      },
      body: JSON.stringify({
        action: 'replay',
        note: '运营工作台人工确认重放',
      }),
    });
    if (!response.ok) {
      setError(
        ((await response.json()) as { error?: string }).error || '重放失败',
      );
      return;
    }
    await refresh();
  };
  return (
    <main className="min-h-screen bg-background text-foreground">
      <PageHeader icon={<Activity className="size-5" />} title="运行与 SLO" subtitle="近 30 天作业、质量与事件" />
      <PageContainer className="py-6">
        {!data && !error && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            读取运行数据…
          </p>
        )}
        {error && (
          <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {data && (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Summary
                icon={Activity}
                label="采集成功"
                value={`${data.ingestion.succeeded}/${data.ingestion.total}`}
              />
              <Summary
                icon={CircleAlert}
                label="开放事件"
                value={String(data.openIncidents)}
              />
              <Summary
                icon={Coins}
                label="记录成本单位"
                value={(
                  Object.values(data.jobs).reduce(
                    (sum, item) => sum + item.costMicros,
                    0,
                  ) / 1_000_000
                ).toFixed(2)}
              />
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Summary
                icon={Cpu}
                label="在线 Worker"
                value={
                  workerView
                    ? String(
                        workerView.workers.filter((worker) => worker.online)
                          .length,
                      )
                    : '—'
                }
              />
              <Summary
                icon={Activity}
                label="等待中的作业"
                value={
                  workerView
                    ? String(
                        workerView.backlog.reduce(
                          (sum, item) => sum + item.waiting,
                          0,
                        ),
                      )
                    : '—'
                }
              />
              <Summary
                icon={Bot}
                label="调度器上次 tick"
                value={lastRun ? `${lastRun.ageSeconds} 秒前` : '从未运行'}
              />
            </div>
            {workerView && workerView.orphanedJobs.length > 0 && (
              <p className="mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                {workerView.orphanedJobs.length} 个作业已排队超过 60
                秒且没有在线 Worker 能处理（
                {[
                  ...new Set(workerView.orphanedJobs.map((job) => job.kind)),
                ].join('、')}
                ）。启动对应 Worker 后会自动被领取。
              </p>
            )}
            {workerView && (
              <section className="mt-7">
                <h2 className="text-lg font-semibold tracking-tight">
                  按类型积压
                </h2>
                <div className="mt-3 overflow-hidden rounded-2xl border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/60 text-muted-foreground">
                      <tr>
                        {['作业类型', '等待', '执行中', '死信'].map((value) => (
                          <th className="px-4 py-3 font-medium" key={value}>
                            {value}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {workerView.backlog.map((item) => (
                        <tr className="border-t" key={item.kind}>
                          <td className="px-4 py-3 font-mono">{item.kind}</td>
                          <td className="px-4 py-3">{item.waiting}</td>
                          <td className="px-4 py-3">{item.leased}</td>
                          <td className="px-4 py-3">{item.deadLetter}</td>
                        </tr>
                      ))}
                      {!workerView.backlog.length && (
                        <tr>
                          <td
                            className="px-4 py-8 text-center text-muted-foreground"
                            colSpan={4}
                          >
                            当前没有积压作业。
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            {workerView && (
              <section className="mt-7">
                <h2 className="text-lg font-semibold tracking-tight">
                  Worker 与积压
                </h2>
                <div className="mt-3 overflow-hidden rounded-2xl border">
                  <table className="w-full text-left text-sm">
                    <thead className="bg-muted/60 text-muted-foreground">
                      <tr>
                        {[
                          'Worker',
                          '主机',
                          '可处理类型',
                          '最近心跳',
                          '状态',
                        ].map((value) => (
                          <th className="px-4 py-3 font-medium" key={value}>
                            {value}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {workerView.workers.map((worker) => (
                        <tr className="border-t" key={worker.id}>
                          <td className="px-4 py-3 font-mono">{worker.id}</td>
                          <td className="px-4 py-3">
                            {worker.hostname || '—'}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs">
                            {worker.kinds.join('、')}
                          </td>
                          <td className="px-4 py-3">
                            {new Date(worker.lastHeartbeatAt).toLocaleString(
                              'zh-CN',
                            )}
                          </td>
                          <td
                            className={`px-4 py-3 ${worker.online ? 'text-chart-1' : 'text-destructive'}`}
                          >
                            {worker.online ? '在线' : '离线'}
                          </td>
                        </tr>
                      ))}
                      {!workerView.workers.length && (
                        <tr>
                          <td
                            className="px-4 py-8 text-center text-muted-foreground"
                            colSpan={5}
                          >
                            没有 Worker 上报过心跳；入队的作业不会被执行。
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
            <section className="mt-7">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">
                    来源 SLO 与采集用量
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    成功率目标 99%；7 天至少 10 个、28 天至少 30
                    个 eligible 定时终态样本。partial/failed 计入失败，权利阻断与取消单列；样本不足永不显示绿色。策略 {data.sourceSlo.policy.version}。
                  </p>
                </div>
                {!data.sourceSlo.dataComplete && (
                  <Badge variant="destructive">
                    来源或运行记录超出观测上限，窗口不完整
                  </Badge>
                )}
              </div>
              <div className="mt-3 overflow-x-auto rounded-2xl border">
                <table className="min-w-[1100px] w-full text-left text-sm">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      {[
                        '来源',
                        '判定',
                        '7 天',
                        '28 天',
                        'P95 新鲜度',
                        '28 天用量 / 估算成本',
                        '月预算 / 分钟配额',
                      ].map((value) => (
                        <th className="px-4 py-3 font-medium" key={value}>
                          {value}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.sourceSlo.snapshots.map((source) => (
                      <tr className="border-t align-top" key={source.sourceId}>
                        <td className="px-4 py-3">
                          <p className="font-medium">{source.name}</p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {source.platform} · {source.healthStatus}
                          </p>
                          {source.exclusions.slice(0, 2).map((exclusion) => (
                            <p
                              className="mt-1 text-xs text-muted-foreground"
                              key={`${exclusion.kind}:${exclusion.startsAt}`}
                            >
                              SLO 排除 ·{' '}
                              {exclusion.kind === 'manual_pause'
                                ? '主动暂停'
                                : '计划维护'}{' '}
                              · {exclusion.reason}
                            </p>
                          ))}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              source.status === 'healthy'
                                ? 'default'
                                : source.status === 'breaching'
                                  ? 'destructive'
                                  : 'outline'
                            }
                          >
                            {sourceStatus(source.status)}
                          </Badge>
                        </td>
                        {[source.windows.days7, source.windows.days28].map(
                          (window) => (
                            <td className="px-4 py-3" key={window.days}>
                              <p>
                                成功 {rate(window.successRate)} ·{' '}
                                {window.succeeded}/{window.total}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {window.sampleSufficient
                                  ? `burn ${window.burnRate?.toFixed(1) ?? '—'}×`
                                  : '样本不足'}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                partial {window.outcomes.partial} · failed{' '}
                                {window.outcomes.failed} · 权利阻断{' '}
                                {window.outcomes.rightsBlocked} · 取消{' '}
                                {window.outcomes.cancelled}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                内容更新 {window.outcomes.modified} · HTTP 304{' '}
                                {window.outcomes.notModified} · 旧版未标记{' '}
                                {window.outcomes.unknownFetchOutcome} · 排除{' '}
                                {window.outcomes.excluded}
                              </p>
                              {window.expectedTriggers !== null && (
                                <>
                                  <p className="mt-1">
                                    触发 {rate(window.triggerRate)} ·{' '}
                                    {window.observedTriggers}/
                                    {window.expectedTriggers}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {window.triggerSampleSufficient
                                      ? `burn ${window.triggerBurnRate?.toFixed(1) ?? '—'}×`
                                      : '触发样本不足'}
                                  </p>
                                </>
                              )}
                            </td>
                          ),
                        )}
                        <td className="px-4 py-3">
                          <p>{duration(source.freshness.p95Ms)}</p>
                          <p className="text-xs text-muted-foreground">
                            目标 {duration(source.freshness.targetMs)}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p>
                            {source.windows.days28.requests} 次 ·{' '}
                            {bytes(source.windows.days28.bytes)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {source.budget.mode === 'unpriced'
                              ? '成本未建模'
                              : `估算 ${moneyMicros(source.windows.days28.estimatedCostMicros)}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            接纳 {source.windows.days28.accepted} · 拒绝{' '}
                            {source.windows.days28.rejected} · 重复{' '}
                            {source.windows.days28.duplicates}
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <p>
                            {source.budget.mode === 'unpriced'
                              ? '成本未建模'
                              : source.budget.monthlyBudgetMicros > 0
                                ? `${moneyMicros(source.budget.monthSpentMicros)} / ${moneyMicros(source.budget.monthlyBudgetMicros)}`
                                : `${moneyMicros(source.budget.monthSpentMicros)} / 不限`}
                          </p>
                          <p
                            className={
                              source.budget.mode === 'exhausted'
                                ? 'text-xs text-destructive'
                                : 'text-xs text-muted-foreground'
                            }
                          >
                            {budgetStatus(source.budget.mode)}
                            {source.budget.usedPercent !== null
                              ? ` · ${source.budget.usedPercent.toFixed(1)}%`
                              : ''}
                          </p>
                          {source.budget.projectedMonthEndMicros !== null && (
                            <p className="text-xs text-muted-foreground">
                              月底预计{' '}
                              {moneyMicros(
                                source.budget.projectedMonthEndMicros,
                              )}
                              {source.budget.estimatedExhaustionAt
                                ? ` · 预计 ${new Date(source.budget.estimatedExhaustionAt).toLocaleDateString('zh-CN')} 耗尽`
                                : ''}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            影响 {source.budget.affectedArticleCount} 篇文章 ·{' '}
                            {source.budget.affectedTopicCount} 个主题
                          </p>
                          <p className="text-xs text-muted-foreground">
                            分钟触发 {source.quota.triggersLastMinute}/
                            {source.quota.triggerLimitPerMinute} · 剩余{' '}
                            {source.quota.remainingTriggers}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            调度优先级 {source.budget.schedulePriority} · 自动降频
                            {source.budget.autoThrottleEnabled ? '开启' : '关闭'}
                            {source.budget.effectiveScheduleMultiplier > 1
                              ? ` · 当前 ×${source.budget.effectiveScheduleMultiplier}`
                              : ''}
                          </p>
                          {source.windows.days28.outcomes.budgetThrottled > 0 && (
                            <p className="text-xs text-amber-700 dark:text-amber-300">
                              28 天已审计跳过{' '}
                              {source.windows.days28.outcomes.budgetThrottled} 次
                              {source.budget.throttleRecoveryAt
                                ? ` · ${new Date(source.budget.throttleRecoveryAt).toLocaleDateString('zh-CN')} 前重新评估`
                                : ''}
                            </p>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!data.sourceSlo.snapshots.length && (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-muted-foreground"
                          colSpan={7}
                        >
                          尚无可观测来源。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <h3 className="mt-6 font-semibold">聚合切片</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                按当前连接器、版本、平台和 Worker
                能力汇总；成功率按运行总数加权，不对百分比取平均。
              </p>
              <div className="mt-3 overflow-x-auto rounded-2xl border">
                <table className="min-w-[900px] w-full text-left text-sm">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      {[
                        '维度',
                        '值 / 来源数',
                        '判定',
                        '7 天',
                        '28 天',
                        '最差来源 P95 / 28 天用量',
                      ].map((value) => (
                        <th className="px-4 py-3 font-medium" key={value}>
                          {value}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.sourceSlo.dimensions.map((dimension) => (
                      <tr
                        className="border-t align-top"
                        key={`${dimension.kind}:${dimension.key}`}
                      >
                        <td className="px-4 py-3">
                          {dimensionName(dimension.kind)}
                        </td>
                        <td className="px-4 py-3">
                          <p className="font-mono">{dimension.label}</p>
                          <p className="text-xs text-muted-foreground">
                            {dimension.sourceCount} 个来源
                          </p>
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              dimension.status === 'healthy'
                                ? 'default'
                                : dimension.status === 'breaching'
                                  ? 'destructive'
                                  : 'outline'
                            }
                          >
                            {sourceStatus(dimension.status)}
                          </Badge>
                        </td>
                        {[
                          dimension.windows.days7,
                          dimension.windows.days28,
                        ].map((window) => (
                          <td className="px-4 py-3" key={window.days}>
                            <p>
                              成功 {rate(window.successRate)} ·{' '}
                              {window.succeeded}/{window.total}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {window.sampleSufficient
                                ? `burn ${window.burnRate?.toFixed(1) ?? '—'}×`
                                : '样本不足'}
                            </p>
                            {window.expectedTriggers !== null && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                触发 {rate(window.triggerRate)} ·{' '}
                                {window.observedTriggers}/
                                {window.expectedTriggers}
                              </p>
                            )}
                          </td>
                        ))}
                        <td className="px-4 py-3">
                          <p>
                            {duration(
                              dimension.windows.days28
                                .worstSourceP95FreshnessMs,
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {dimension.windows.days28.requests} 次 ·{' '}
                            {bytes(dimension.windows.days28.bytes)} · 估算{' '}
                            {moneyMicros(
                              dimension.windows.days28.estimatedCostMicros,
                            )}
                          </p>
                        </td>
                      </tr>
                    ))}
                    {!data.sourceSlo.dimensions.length && (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-muted-foreground"
                          colSpan={6}
                        >
                          尚无可聚合的来源。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="mt-7">
              <h2 className="text-lg font-semibold tracking-tight">
                作业健康度
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                生成于 {new Date(data.generatedAt).toLocaleString('zh-CN')}
              </p>
              <div className="mt-4 overflow-hidden rounded-2xl border">
                <table className="w-full text-left text-sm">
                  <thead className="bg-muted/60 text-muted-foreground">
                    <tr>
                      {[
                        '类型',
                        '总数',
                        '成功',
                        '失败 / DLQ',
                        '重试',
                        'P50',
                        'P95',
                      ].map((value) => (
                        <th className="px-4 py-3 font-medium" key={value}>
                          {value}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.jobs).map(([kind, metric]) => (
                      <tr className="border-t" key={kind}>
                        <td className="px-4 py-3 font-mono">{kind}</td>
                        <td className="px-4 py-3">{metric.total}</td>
                        <td className="px-4 py-3">{metric.succeeded}</td>
                        <td className="px-4 py-3">
                          {metric.failed} / {metric.deadLetter}
                        </td>
                        <td className="px-4 py-3">{metric.retries}</td>
                        <td className="px-4 py-3">{duration(metric.p50Ms)}</td>
                        <td className="px-4 py-3">{duration(metric.p95Ms)}</td>
                      </tr>
                    ))}
                    {!Object.keys(data.jobs).length && (
                      <tr>
                        <td
                          className="px-4 py-8 text-center text-muted-foreground"
                          colSpan={7}
                        >
                          近 30 天没有后台作业。
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="mt-7">
              <h2 className="text-lg font-semibold tracking-tight">
                需要处置
              </h2>
              <div className="mt-3 grid gap-3">
                {data.attention.map((job) => (
                  <article
                    className="flex flex-col justify-between gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center"
                    key={job.id}
                  >
                    <div>
                      <p className="font-mono text-sm">
                        {job.kind} · {job.status} · {job.attempt}/
                        {job.max_attempts}
                      </p>
                      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
                        {job.last_error || '等待下一次重试'}
                      </p>
                    </div>
                    {['dead_letter', 'failed'].includes(job.status) && (
                      <Button
                        variant="outline"
                        onClick={() => void replay(job)}
                      >
                        确认并重放
                      </Button>
                    )}
                  </article>
                ))}
                {!data.attention.length && (
                  <p className="rounded-xl border border-dashed p-7 text-center text-sm text-muted-foreground">
                    当前没有失败、死信或重试中的作业。
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </PageContainer>
    </main>
  );
}

function Summary({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3;
  label: string;
  value: string;
}) {
  return (
    <article className="rounded-2xl border bg-card p-5">
      <Icon className="size-5 text-chart-1" />
      <p className="mt-4 text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </article>
  );
}
