'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, ChevronRight, LoaderCircle, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  AUTOMATION_STAGES,
  BREAKER_COOLDOWN_MS,
  GLOBAL_AUTOMATION_STAGES,
  SELECTABLE_STAGE_MODES,
  breakerStatus,
  isGlobalStage,
  type AutomationPolicy,
  type AutomationStage,
  type StageMode,
} from '@/lib/automation';
import { useSession } from '@/hooks/use-session';
import { PageContainer, PageHeader } from '@/components/page-shell';

type Member = { user_id: string; email: string; role: string; status: string };
type PolicyCost = { projectCount: number; costMicros: number };
type GlobalControl = { paused: boolean; reason: string; updatedBy: string | null; updatedAt: string | null };
type ActivityRatio = { automated: number; other: number; since: string };
type EngineStatus = {
  actorConfigured: boolean;
  actorId: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunNote: string | null;
};
type Run = {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  projectCount: number;
  actions: Array<{ stage: string; action: string; projectId?: string | null }>;
  breakers: Record<string, { failures: number; openedAt: string | null; lastError: string }>;
  errors: Array<{ stage: string; message: string }>;
};

const stageLabels: Record<AutomationStage, string> = {
  ingestion: '采集',
  topic_quality: '选题质量评估',
  project_creation: '自动建项目',
  advance: '状态推进',
  jobs: '作业编排（配音/渲染）',
  publish: '发布任务',
  metrics: '指标回流',
};

const APPROVAL_KINDS = ['research', 'script', 'qc', 'publish'] as const;
const approvalLabels = { research: 'G3 研究', script: 'G4 脚本', qc: 'G6 终审', publish: 'G7 发布' } as const;

type PolicyDetailTab = 'stages' | 'approvals' | 'guardrails' | 'scope';

function splitList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/*
  body 只能读一次，而 clone() 必须在读之前调用。原来的写法先 response.json()
  再 response.clone()，后者必然抛「Body has already been consumed」被 catch 吞掉，
  于是所有只带 error、不带 issues 的响应（403/404/400/409）都退化成
  「请求失败（4xx）」，服务端写好的中文提示一句也到不了界面。
*/
async function readError(response: Response) {
  const fallback = `请求失败（${response.status}）`;
  let payload: { error?: string; issues?: string[] };
  try { payload = (await response.json()) as typeof payload; }
  catch { return fallback; }
  return payload.issues?.join('；') || payload.error || fallback;
}

/**
 * `expiresAt` 存的是 UTC ISO，而 datetime-local 读写的都是本地时间。
 * 以前显示时直接 slice(0,16) 把 UTC 当本地显示、写回时又按本地解析成 UTC，
 * 同一个值每被选一次就平移一个时区偏移——它是预先授权的失效时刻，不能漂。
 */
function toLocalInputValue(iso: string) {
  const at = new Date(iso);
  if (Number.isNaN(at.valueOf())) return '';
  return new Date(at.valueOf() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** 超过这么久没有新一轮，就提示去确认 scheduler 进程还在。默认间隔 30s，这里留 20 倍余量。 */
const STALE_TICK_MS = 10 * 60_000;

/**
 * 「全局自动化：运行中」以前只反映 automation_control.paused 这一个配置位，
 * 于是页面可以一边写着「运行中」，一边在下面写着「调度器还没有跑过」。
 *
 * 总开关没关只是必要条件。引擎真要干活还需要：解析得到服务账号
 * （见 orchestrator 的 resolveAutomationActor，缺了就整轮不写任何东西），
 * 以及确实有进程在按轮调用它。三件事任何一件不成立，这里都要说出来。
 */
function automationHealth(
  control: GlobalControl,
  engine: EngineStatus | null,
  loadedAt: number,
): { title: string; detail: string; tone: 'ok' | 'warn' | 'bad' } {
  if (control.paused) {
    return { title: '已暂停', detail: control.reason || '未填写原因', tone: 'bad' };
  }
  if (engine && !engine.actorConfigured) {
    return {
      title: '开关已开，但引擎不会写入任何东西',
      detail: '未配置有效的自动化服务账号：SIGNAL40_AUTOMATION_ACTOR_ID 必须指向 team_members 里一个 active 的 admin 成员。在此之前每一轮都会空转。',
      tone: 'bad',
    };
  }
  if (engine && !engine.lastRunAt) {
    return {
      title: '开关已开，但调度器从未跑过',
      detail: '没有任何一轮 tick 的记录。常规运行由独立的 scheduler 进程负责（npm run scheduler 或 compose 里的 scheduler 服务）；手动触发接口用的是调度器令牌，不对浏览器开放。',
      tone: 'warn',
    };
  }
  if (engine?.lastRunAt) {
    const ageMs = loadedAt ? loadedAt - new Date(engine.lastRunAt).valueOf() : 0;
    const ageText = `最近一轮 ${new Date(engine.lastRunAt).toLocaleString('zh-CN')}（${Math.max(0, Math.round(ageMs / 60_000))} 分钟前）· ${engine.lastRunStatus}${engine.lastRunNote ? ` · ${engine.lastRunNote}` : ''}`;
    if (ageMs > STALE_TICK_MS) {
      return { title: '开关已开，但已经很久没有新一轮', detail: `${ageText}。确认 scheduler 进程还活着。`, tone: 'warn' };
    }
    return { title: '运行中', detail: ageText, tone: 'ok' };
  }
  return { title: '运行中', detail: '调度器可按启用策略执行各阶段。', tone: 'ok' };
}

/**
 * 一条策略在抽屉里的编辑副本。
 *
 * `enabled` 刻意不在里面：启用/停用是一次独立动作，点一下就该生效，不该被
 * 抽屉里未保存的草稿裹挟；反过来，草稿保存时也不该顺手改掉启用状态。
 */
type PolicyDraft = Omit<AutomationPolicy, 'id' | 'version' | 'enabled' | 'authorizedAt'>;

function toDraft(policy: AutomationPolicy): PolicyDraft {
  return {
    name: policy.name,
    scope: { ...policy.scope, brands: [...policy.scope.brands], locales: [...policy.scope.locales], sourceTypes: [...policy.scope.sourceTypes] },
    stages: { ...policy.stages },
    autoApprovals: {
      research: { ...policy.autoApprovals.research },
      script: { ...policy.autoApprovals.script },
      qc: { ...policy.autoApprovals.qc },
      publish: { ...policy.autoApprovals.publish },
    },
    researchAuthorizedBy: policy.researchAuthorizedBy,
    publishAuthorizedBy: policy.publishAuthorizedBy,
    guardrails: { ...policy.guardrails, quietHoursUtc: { ...policy.guardrails.quietHoursUtc } },
    expiresAt: policy.expiresAt,
  };
}

/** 摘要行上的一句话：七个阶段里哪些是自动的。 */
function stageSummary(policy: AutomationPolicy) {
  const auto = AUTOMATION_STAGES.filter((stage) => policy.stages[stage] === 'auto');
  if (!auto.length) return '所有阶段都不自动';
  if (auto.length === AUTOMATION_STAGES.length) return '全部阶段自动';
  return `自动：${auto.map((stage) => stageLabels[stage]).join('、')}`;
}

function approvalSummary(policy: AutomationPolicy) {
  const on = APPROVAL_KINDS.filter((kind) => policy.autoApprovals[kind].enabled);
  return on.length ? `预先授权：${on.map((kind) => approvalLabels[kind]).join('、')}` : '四道审批全部人工';
}

export function AutomationConsole() {
  const session = useSession();
  const [policies, setPolicies] = useState<AutomationPolicy[]>([]);
  const [costs, setCosts] = useState<Record<string, PolicyCost>>({});
  const [runs, setRuns] = useState<Run[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState('');
  const [control, setControl] = useState<GlobalControl>({ paused: false, reason: '', updatedBy: null, updatedAt: null });
  const [globalReason, setGlobalReason] = useState('运营人工暂停全部自动化');
  const [activity, setActivity] = useState<ActivityRatio>({ automated: 0, other: 0, since: '' });
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  // 「最近一轮多久以前」要有一个参照时刻。渲染期读时钟既不纯、也会让同一份
  // 数据每次重渲染都不一样，所以在刷新时记一次，界面显示的就是「截至上次刷新」。
  const [loadedAt, setLoadedAt] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<PolicyDetailTab>('stages');
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const canEdit = session.actor?.role === 'admin';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [policyResponse, runResponse, memberResponse, controlResponse] = await Promise.all([
        fetch('/api/v1/automation/policies', { cache: 'no-store' }),
        fetch('/api/v1/automation/runs?limit=20', { cache: 'no-store' }),
        fetch('/api/v1/team-members', { cache: 'no-store' }),
        fetch('/api/v1/automation/control', { cache: 'no-store' }),
      ]);
      if (!policyResponse.ok) throw new Error(await readError(policyResponse));
      const policyPayload = (await policyResponse.json()) as { policies: AutomationPolicy[]; costs?: Record<string, PolicyCost>; activity?: ActivityRatio };
      setPolicies(policyPayload.policies);
      setCosts(policyPayload.costs ?? {});
      setActivity(policyPayload.activity ?? { automated: 0, other: 0, since: '' });
      if (runResponse.ok) setRuns(((await runResponse.json()) as { runs: Run[] }).runs);
      if (memberResponse.ok) setMembers(((await memberResponse.json()) as { members: Member[] }).members.filter((member) => member.status === 'active'));
      if (controlResponse.ok) {
        const controlPayload = (await controlResponse.json()) as { control: GlobalControl; engine?: EngineStatus };
        setControl(controlPayload.control);
        setEngine(controlPayload.engine ?? null);
      }
      setLoadedAt(Date.now());
      setMessage('');
    } catch (error) { setMessage(error instanceof Error ? error.message : '读取自动化配置失败。'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const create = async () => {
    const response = await fetch('/api/v1/automation/policies', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    if (!response.ok) { setMessage(await readError(response)); return; }
    setName('');
    await refresh();
  };

  /** 启用/停用是独立的一次动作，不走草稿。 */
  const toggleEnabled = async (policy: AutomationPolicy) => {
    const response = await fetch(`/api/v1/automation/policies/${policy.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !policy.enabled }) });
    if (!response.ok) { setMessage(await readError(response)); return; }
    setMessage('');
    await refresh();
  };

  const saveDraft = async (policy: AutomationPolicy) => {
    if (!draft) return;
    setSaving(true);
    setNotice('');
    try {
      const response = await fetch(`/api/v1/automation/policies/${policy.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
      if (!response.ok) { setMessage(await readError(response)); return; }
      // refresh() 成功时会把 message 清空，成功提示必须放在它之后，
      // 而且要走自己的通道——message 只有报错那一种样式。
      await refresh();
      setNotice(`${policy.name} 已保存，版本已推进。`);
    } finally { setSaving(false); }
  };

  const remove = async (policy: AutomationPolicy) => {
    const owned = costs[policy.id]?.projectCount ?? 0;
    if (!window.confirm(
      `删除策略「${policy.name}」。\n\n挂在它名下的项目会全部退回人工（automation_mode = manual），近 30 天有 ${owned} 个。\n删除不可撤销，确认继续？`,
    )) return;
    const response = await fetch(`/api/v1/automation/policies/${policy.id}`, { method: 'DELETE' });
    if (!response.ok) { setMessage(await readError(response)); return; }
    if (detailId === policy.id) { setDetailId(null); setDraft(null); }
    await refresh();
  };

  const setGlobalPause = async (paused: boolean) => {
    const response = await fetch('/api/v1/automation/control', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused, reason: paused ? globalReason : '' }) });
    if (!response.ok) { setMessage(await readError(response)); return; }
    await refresh();
  };

  const openDetail = (policy: AutomationPolicy) => {
    setNotice('');
    setDetailId(policy.id);
    setDetailTab('stages');
    setDraft(toDraft(policy));
  };

  const closeDetail = (dirty: boolean) => {
    if (dirty && !window.confirm('有未保存的修改，关闭后会丢失。确认关闭？')) return;
    setDetailId(null);
    setDraft(null);
  };

  const detailPolicy = policies.find((policy) => policy.id === detailId) ?? null;
  const dirty = Boolean(detailPolicy && draft && JSON.stringify(draft) !== JSON.stringify(toDraft(detailPolicy)));
  const health = automationHealth(control, engine, loadedAt);
  const automatedActions = runs.flatMap((run) => run.actions).length;
  // 熔断状态是逐轮累积带下来的，最近一轮的快照就是当前状态。
  const breakerRows = AUTOMATION_STAGES
    .map((stage) => ({ stage, state: runs[0]?.breakers?.[stage], status: breakerStatus(runs[0]?.breakers ?? {}, stage, new Date(loadedAt || 0)) }))
    .filter((row) => row.state && row.status !== 'closed');
  const researchCandidates = members.filter((member) => ['editor', 'admin'].includes(member.role));
  const publishCandidates = members.filter((member) => ['publisher', 'admin'].includes(member.role));

  if (session.loading) return <main className="grid min-h-screen place-items-center"><LoaderCircle className="animate-spin" /></main>;
  if (!session.actor) return <main className="grid min-h-screen place-items-center p-6 text-center">{session.error || '无法识别当前身份。'}</main>;

  const patchDraft = (patch: Partial<PolicyDraft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  return <main className="min-h-screen bg-background text-foreground">
    <PageHeader icon={<Bot className="size-5" />} title="自动化控制台" subtitle="策略、预先授权、近期自动动作与熔断状态" />

    <PageContainer className="py-6">
      {message && <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{message}</p>}
      {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />读取中…</p>}
      {!canEdit && <p className="mb-4 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">当前角色（{session.actor.role}）只能查看自动化配置；策略与总开关的修改需要管理员。</p>}

      {breakerRows.length > 0 && <div className="mb-5 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <p className="flex items-center gap-2 font-semibold"><ShieldAlert className="size-4" />熔断中的阶段</p>
        <ul className="mt-2 space-y-1">{breakerRows.map((row) => <li key={row.stage}>
          {stageLabels[row.stage]}：连续失败 {row.state?.failures} 次
          {row.status === 'open' ? '，冷却中，本阶段暂停执行' : `，冷却已结束（${BREAKER_COOLDOWN_MS / 60_000} 分钟），下一轮会重试一次，成功即复位`}
          ，最近错误「{row.state?.lastError}」
        </li>)}</ul>
      </div>}

      <section className={`mb-5 rounded-2xl border p-5 ${health.tone === 'bad' ? 'border-destructive/50 bg-destructive/5' : health.tone === 'warn' ? 'border-amber-500/50 bg-amber-500/5' : 'bg-card'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-semibold">全局自动化：{health.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{health.detail}{control.updatedAt ? ` · ${new Date(control.updatedAt).toLocaleString('zh-CN')} · ${control.updatedBy ?? '未知操作者'}` : ' · 总开关从未被改动过'}</p>
          </div>
          {canEdit && <div className="flex flex-wrap gap-2">
            <Input className="w-72" aria-label="全局暂停原因" value={globalReason} onChange={(event) => setGlobalReason(event.target.value)} />
            <Button variant={control.paused ? 'default' : 'destructive'} disabled={!control.paused && !globalReason.trim()} onClick={() => void setGlobalPause(!control.paused)}>{control.paused ? '恢复全部自动化' : '暂停全部自动化'}</Button>
          </div>}
        </div>
        <p className="mt-3 text-sm">近 30 天审计写入：自动化 {activity.automated} / 其余 {activity.other}，自动化占比 {activity.automated + activity.other ? Math.round(activity.automated / (activity.automated + activity.other) * 100) : 0}%</p>
        <p className="mt-1 text-xs text-muted-foreground">「其余」是人工操作加上 Worker 写入的机器事件；只有显式标注 trigger 的记录才分得清，所以这里不把未标注的一律算成人工。</p>
      </section>

      <details className="mb-5 rounded-2xl border bg-card p-5">
        <summary className="cursor-pointer font-semibold">这套自动化是怎么工作的</summary>
        <div className="mt-3 grid gap-2 text-sm leading-6 text-muted-foreground">
          <p>调度器每轮按启用中的策略执行七个阶段。阶段分两类：<strong className="text-foreground">全局阶段</strong>（{GLOBAL_AUTOMATION_STAGES.map((stage) => stageLabels[stage]).join('、')}）不挂在某个项目上，只要有任意一条启用中的策略把它设为自动就会执行；<strong className="text-foreground">按项目阶段</strong>（{AUTOMATION_STAGES.filter((stage) => !isGlobalStage(stage)).map((stage) => stageLabels[stage]).join('、')}）按项目所属的那条策略逐个判定。</p>
          <p>阶段只控制「机械步骤」。G3/G4/G6/G7 四道问责门禁默认全部人工，要自动放行必须在策略里显式开启，并指定一个真人作为授权人——自动放行写入的是那个人的批准记录。研究类与发布类授权人必须是不同的成员，否则 G7 的职责分离不成立。</p>
          <p>所以最常见的配置（阶段全自动、四道审批全人工）的实际行为是：项目会被一路推进到 G3 然后停下来等人。想让它继续走，要开对应的预先授权，而不是再多开一个阶段。</p>
          <p>预先授权是有有效期的，过期自动转人工，不需要人记得去关。任何一次人工编辑、审批或事故都会把项目翻回 <code>automation_mode = manual</code>。</p>
          <p>成本相关的数字统一用 micros（货币最小单位的百万分之一），具体币种由部署方约定。</p>
        </div>
      </details>

      {canEdit && <section className="rounded-2xl border bg-card p-5">
        <h2 className="font-semibold">新建策略</h2>
        <p className="mt-1 text-xs text-muted-foreground">新策略默认：机械步骤自动、四道审批人工、自动建项目关闭、策略本身停用。建好后再逐项打开。</p>
        <div className="mt-3 flex flex-wrap gap-2"><Input className="max-w-sm" placeholder="策略名称" value={name} onChange={(event) => setName(event.target.value)} /><Button variant="outline" disabled={!name.trim()} onClick={() => void create()}>创建</Button></div>
      </section>}

      <div className="mt-5 grid gap-2">
        {policies.map((policy) => <article className="flex flex-col gap-3 rounded-2xl border bg-card px-4 py-3 sm:flex-row sm:items-center" key={policy.id}>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-semibold">{policy.name}</h2>
              <Badge variant={policy.enabled ? 'default' : 'outline'}>{policy.enabled ? '启用中' : '已停用'}</Badge>
              {policy.expiresAt && <Badge variant="secondary">预先授权至 {new Date(policy.expiresAt).toLocaleString('zh-CN')}</Badge>}
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">{policy.id} · v{policy.version}</p>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>{stageSummary(policy)}</span>
              <span>{approvalSummary(policy)}</span>
              <span>近 30 天 {costs[policy.id]?.projectCount ?? 0} 个项目 · {(costs[policy.id]?.costMicros ?? 0).toLocaleString('zh-CN')} micros</span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {canEdit && <Button size="sm" variant="outline" onClick={() => void toggleEnabled(policy)}>{policy.enabled ? '停用' : '启用'}</Button>}
            <Button size="sm" variant="ghost" onClick={() => openDetail(policy)}>{canEdit ? '编辑' : '查看'}<ChevronRight /></Button>
          </div>
        </article>)}
        {!loading && !policies.length && <p className="rounded-xl border border-dashed p-7 text-center text-sm text-muted-foreground">还没有自动化策略。没有启用中的策略时，引擎只做采集、选题质量评估与指标提醒，不会推进任何项目。</p>}
      </div>

      <section className="mt-7">
        <h2 className="text-lg font-semibold tracking-tight">近期自动动作</h2>
        <p className="mt-1 text-sm text-muted-foreground">最近 {runs.length} 轮 tick 共 {automatedActions} 个自动动作。每个动作在审计流里都带 trigger=automation 与策略 ID。</p>
        <p className="mt-1 text-xs text-muted-foreground">这里没有「立即跑一轮」：手动触发接口 <code>POST /api/v1/scheduler/run</code> 用的是调度器令牌，不对浏览器开放，否则等于把它暴露给前端。常规运行由独立的 scheduler 进程负责。</p>
        <div className="mt-3 grid gap-2">
          {runs.map((run) => <article className="rounded-xl border bg-card p-4 text-sm" key={run.id}>
            <p className="flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{new Date(run.startedAt).toLocaleString('zh-CN')}</span><span>{run.trigger === 'manual' ? '手动触发' : '调度器'}</span><span className={run.status === 'succeeded' ? 'text-chart-1' : run.status === 'skipped' ? 'text-muted-foreground' : 'text-destructive'}>{run.status}</span><span className="text-muted-foreground">处理项目 {run.projectCount} · 动作 {run.actions.length} · {run.durationMs ?? 0} ms</span></p>
            {run.actions.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{run.actions.slice(0, 8).map((action) => `${action.action}${action.projectId ? `（${action.projectId}）` : ''}`).join('，')}{run.actions.length > 8 ? ' …' : ''}</p>}
            {run.errors.length > 0 && <p className="mt-2 text-xs text-destructive">{run.errors.map((error) => `${error.stage}：${error.message}`).join('；')}</p>}
          </article>)}
          {!runs.length && <p className="rounded-xl border border-dashed p-7 text-center text-sm text-muted-foreground">调度器还没有跑过。启动 scheduler 服务后这里会出现每轮记录。</p>}
        </div>
      </section>
    </PageContainer>

    {/*
      策略详情沿用证据抽屉的半屏宽。变体链必须和 ui/sheet 的默认值逐字一致，
      否则默认的 data-[side=right]:sm:max-w-sm 留在类名里会把宽度压回 384px。
    */}
    <Sheet open={Boolean(detailPolicy && draft)} onOpenChange={(open) => !open && closeDetail(dirty)}>
      <SheetContent className="w-full overflow-y-auto data-[side=right]:sm:max-w-[50vw]" side="right">
        {detailPolicy && draft && <>
          <SheetHeader className="border-b border-border p-6 pr-14">
            <p className="font-mono text-xs uppercase tracking-[0.15em] text-chart-1">Automation policy</p>
            <SheetTitle className="mt-2 text-2xl leading-tight">{detailPolicy.name}</SheetTitle>
            <SheetDescription>{detailPolicy.id} · v{detailPolicy.version} · {detailPolicy.enabled ? '启用中' : '已停用'}</SheetDescription>
          </SheetHeader>
          <div className="p-6">
            {/*
              以前每个输入框的 onChange 直接发一次 PATCH：改个上限要写三次库、留三条
              审计、版本 +3，而且每次写完都 refresh 回填，输入框会跟正在打字的人抢。
              现在抽屉里编辑的是一份本地草稿，保存时一次 PATCH。
            */}
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <Button disabled={!canEdit || !dirty || saving} onClick={() => void saveDraft(detailPolicy)}>{saving ? <LoaderCircle className="animate-spin" /> : null}保存修改</Button>
              <Button variant="outline" disabled={!dirty || saving} onClick={() => setDraft(toDraft(detailPolicy))}>放弃修改</Button>
              {canEdit && <Button variant="destructive" disabled={saving} onClick={() => void remove(detailPolicy)}>删除策略</Button>}
              <span className={`text-xs ${notice && !dirty ? 'text-chart-1' : 'text-muted-foreground'}`}>{dirty ? '有未保存的修改' : notice || '与服务端一致'}</span>
            </div>

            <Tabs value={detailTab} onValueChange={(value) => setDetailTab(value as PolicyDetailTab)}>
              <TabsList variant="line" className="w-full">
                <TabsTrigger value="stages">阶段</TabsTrigger>
                <TabsTrigger value="approvals">预先授权</TabsTrigger>
                <TabsTrigger value="guardrails">护栏</TabsTrigger>
                <TabsTrigger value="scope">范围</TabsTrigger>
              </TabsList>

              <TabsContent value="stages" className="mt-5 grid gap-5">
                {(['global', 'project'] as const).map((group) => <section key={group}>
                  <h3 className="text-sm font-medium">{group === 'global' ? '全局阶段' : '按项目阶段'}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{group === 'global'
                    ? '不挂在某个项目上。引擎对所有启用中的策略取「或」：只要有一条策略把它设为自动就会执行，在这条策略上关掉不会阻止别的策略开启它。'
                    : '按项目所属的那条策略逐个判定，改这里只影响归属本策略的项目。'}</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {AUTOMATION_STAGES.filter((stage) => isGlobalStage(stage) === (group === 'global')).map((stage) => <div key={stage}>
                      <Label className="text-xs text-muted-foreground">{stageLabels[stage]}</Label>
                      <NativeSelect className="mt-1 w-full" disabled={!canEdit} value={draft.stages[stage] === 'auto' ? 'auto' : 'off'} onChange={(event) => patchDraft({ stages: { ...draft.stages, [stage]: event.target.value as StageMode } })}>
                        {SELECTABLE_STAGE_MODES.map((mode) => <NativeSelectOption key={mode} value={mode}>{mode === 'auto' ? '自动' : '不自动（人工处理）'}</NativeSelectOption>)}
                      </NativeSelect>
                    </div>)}
                  </div>
                </section>)}
                <p className="text-xs text-muted-foreground">阶段只有「自动」和「不自动」两种。历史数据里可能存着 <code>manual</code>，引擎从来就把它和「不自动」同等对待，这里按「不自动」显示，保存后归一。</p>
              </TabsContent>

              <TabsContent value="approvals" className="mt-5 grid gap-4">
                <p className="text-xs text-muted-foreground">自动放行写入的是下面这个真人的批准记录，note 里注明依据哪条策略。研究类与发布类授权人必须是不同的成员，否则 G7 的职责分离不成立；有效期一过自动转人工。</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {APPROVAL_KINDS.map((kind) => <div className="flex items-center gap-2 text-sm" key={kind}>
                    <Checkbox id={`auto-approval-${kind}`} disabled={!canEdit} checked={draft.autoApprovals[kind].enabled} onCheckedChange={(checked) => patchDraft({ autoApprovals: { ...draft.autoApprovals, [kind]: { enabled: checked === true } } })} />
                    <Label htmlFor={`auto-approval-${kind}`}>{approvalLabels[kind]}</Label>
                  </div>)}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><Label className="text-xs text-muted-foreground">研究/脚本/终审授权人</Label>
                    <NativeSelect className="mt-1 w-full" disabled={!canEdit} value={draft.researchAuthorizedBy ?? ''} onChange={(event) => patchDraft({ researchAuthorizedBy: event.target.value || null })}>
                      <NativeSelectOption value="">未指定</NativeSelectOption>
                      {researchCandidates.map((member) => <NativeSelectOption key={member.user_id} value={member.user_id}>{member.email}（{member.role}）</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                  <div><Label className="text-xs text-muted-foreground">发布授权人（必须不同人）</Label>
                    <NativeSelect className="mt-1 w-full" disabled={!canEdit} value={draft.publishAuthorizedBy ?? ''} onChange={(event) => patchDraft({ publishAuthorizedBy: event.target.value || null })}>
                      <NativeSelectOption value="">未指定</NativeSelectOption>
                      {publishCandidates.map((member) => <NativeSelectOption key={member.user_id} value={member.user_id}>{member.email}（{member.role}）</NativeSelectOption>)}
                    </NativeSelect>
                  </div>
                  <div><Label className="text-xs text-muted-foreground">预先授权有效期（本地时间）</Label>
                    <Input className="mt-1" type="datetime-local" disabled={!canEdit} value={draft.expiresAt ? toLocalInputValue(draft.expiresAt) : ''} onChange={(event) => patchDraft({ expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="guardrails" className="mt-5 grid gap-3 sm:grid-cols-2">
                <div><Label className="text-xs text-muted-foreground">每日自动建项目上限</Label><Input className="mt-1" type="number" min="0" disabled={!canEdit} value={draft.guardrails.dailyProjectLimit} onChange={(event) => patchDraft({ guardrails: { ...draft.guardrails, dailyProjectLimit: Number(event.target.value) } })} /></div>
                <div><Label className="text-xs text-muted-foreground">每日自动发布上限</Label><Input className="mt-1" type="number" min="0" disabled={!canEdit} value={draft.guardrails.dailyPublishLimit} onChange={(event) => patchDraft({ guardrails: { ...draft.guardrails, dailyPublishLimit: Number(event.target.value) } })} /></div>
                <div><Label className="text-xs text-muted-foreground">最低独立来源数（不得低于 2）</Label><Input className="mt-1" type="number" min="2" disabled={!canEdit} value={draft.guardrails.minIndependentSources} onChange={(event) => patchDraft({ guardrails: { ...draft.guardrails, minIndependentSources: Number(event.target.value) } })} /></div>
                <div><Label className="text-xs text-muted-foreground">单条成本上限（micros，0 表示不限）</Label><Input className="mt-1" type="number" min="0" disabled={!canEdit} value={draft.guardrails.maxCostMicrosPerProject} onChange={(event) => patchDraft({ guardrails: { ...draft.guardrails, maxCostMicrosPerProject: Number(event.target.value) } })} /></div>
                <div><Label className="text-xs text-muted-foreground">静默时段起（UTC 小时）</Label><Input className="mt-1" type="number" min="0" max="23" disabled={!canEdit} value={draft.guardrails.quietHoursUtc.start} onChange={(event) => patchDraft({ guardrails: { ...draft.guardrails, quietHoursUtc: { ...draft.guardrails.quietHoursUtc, start: Number(event.target.value) } } })} /></div>
                <div><Label className="text-xs text-muted-foreground">静默时段止（UTC 小时）</Label><Input className="mt-1" type="number" min="0" max="23" disabled={!canEdit} value={draft.guardrails.quietHoursUtc.end} onChange={(event) => patchDraft({ guardrails: { ...draft.guardrails, quietHoursUtc: { ...draft.guardrails.quietHoursUtc, end: Number(event.target.value) } } })} /></div>
                <p className="text-xs text-muted-foreground sm:col-span-2">静默时段是 UTC 的 [起, 止) 区间，落在区间内不做发布类自动动作；两端相同表示不设静默（当前 {draft.guardrails.quietHoursUtc.start === draft.guardrails.quietHoursUtc.end ? '不设静默' : `${draft.guardrails.quietHoursUtc.start}:00–${draft.guardrails.quietHoursUtc.end}:00 UTC`}）。</p>
              </TabsContent>

              <TabsContent value="scope" className="mt-5 grid gap-3 sm:grid-cols-2">
                <div><Label className="text-xs text-muted-foreground">选题分数下限</Label><Input className="mt-1" type="number" min="0" max="100" disabled={!canEdit} value={draft.scope.minTopicScore} onChange={(event) => patchDraft({ scope: { ...draft.scope, minTopicScore: Number(event.target.value) } })} /></div>
                <div><Label className="text-xs text-muted-foreground">选题质量分下限</Label><Input className="mt-1" type="number" min="0" max="100" disabled={!canEdit} value={draft.scope.minQualityScore} onChange={(event) => patchDraft({ scope: { ...draft.scope, minQualityScore: Number(event.target.value) } })} /></div>
                <div className="flex items-center gap-2 self-end text-sm sm:col-span-2"><Checkbox id="scope-require-topic-quality" disabled={!canEdit} checked={draft.scope.requireTopicQuality} onCheckedChange={(checked) => patchDraft({ scope: { ...draft.scope, requireTopicQuality: checked === true } })} /><Label htmlFor="scope-require-topic-quality">要求选题质量指标达标</Label></div>
                <div><Label className="text-xs text-muted-foreground">品牌范围（逗号分隔，空为不限）</Label><Input className="mt-1" disabled={!canEdit} value={draft.scope.brands.join(',')} onChange={(event) => patchDraft({ scope: { ...draft.scope, brands: splitList(event.target.value) } })} /></div>
                <div><Label className="text-xs text-muted-foreground">语言范围（逗号分隔，空为不限）</Label><Input className="mt-1" disabled={!canEdit} value={draft.scope.locales.join(',')} onChange={(event) => patchDraft({ scope: { ...draft.scope, locales: splitList(event.target.value) } })} /></div>
                <div className="sm:col-span-2"><Label className="text-xs text-muted-foreground">来源类型（social/media/market/filing/company，逗号分隔，空为不限）</Label><Input className="mt-1" disabled={!canEdit} value={draft.scope.sourceTypes.join(',')} onChange={(event) => patchDraft({ scope: { ...draft.scope, sourceTypes: splitList(event.target.value) } })} /></div>
              </TabsContent>
            </Tabs>
          </div>
        </>}
      </SheetContent>
    </Sheet>
  </main>;
}
