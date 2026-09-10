'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bot, LoaderCircle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { AUTOMATION_STAGES, STAGE_MODES, type AutomationPolicy, type AutomationStage, type StageMode } from '@/lib/automation';
import { PageContainer, PageHeader } from '@/components/page-shell';

type Member = { user_id: string; email: string; role: string; status: string };
type PolicyCost = { projectCount: number; costMicros: number };
type GlobalControl = { paused: boolean; reason: string; updatedBy: string | null; updatedAt: string | null };
type ActivityRatio = { automated: number; human: number; since: string };
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

const approvalLabels = { research: 'G3 研究', script: 'G4 脚本', qc: 'G6 终审', publish: 'G7 发布' } as const;

function splitList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

async function readError(response: Response) {
  try { return ((await response.json()) as { error?: string; issues?: string[] }).issues?.join('；') || ((await response.clone().json()) as { error?: string }).error || `请求失败（${response.status}）`; }
  catch { return `请求失败（${response.status}）`; }
}

export function AutomationConsole() {
  const [policies, setPolicies] = useState<AutomationPolicy[]>([]);
  const [costs, setCosts] = useState<Record<string, PolicyCost>>({});
  const [runs, setRuns] = useState<Run[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [name, setName] = useState('');
  const [control, setControl] = useState<GlobalControl>({ paused: false, reason: '', updatedBy: null, updatedAt: null });
  const [globalReason, setGlobalReason] = useState('运营人工暂停全部自动化');
  const [activity, setActivity] = useState<ActivityRatio>({ automated: 0, human: 0, since: '' });
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

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
      setActivity(policyPayload.activity ?? { automated: 0, human: 0, since: '' });
      if (runResponse.ok) setRuns(((await runResponse.json()) as { runs: Run[] }).runs);
      if (memberResponse.ok) setMembers(((await memberResponse.json()) as { members: Member[] }).members.filter((member) => member.status === 'active'));
      if (controlResponse.ok) setControl(((await controlResponse.json()) as { control: GlobalControl }).control);
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

  const update = async (policy: AutomationPolicy, patch: Partial<AutomationPolicy>) => {
    const response = await fetch(`/api/v1/automation/policies/${policy.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    if (!response.ok) { setMessage(await readError(response)); return; }
    setMessage('');
    await refresh();
  };

  const remove = async (policy: AutomationPolicy) => {
    const response = await fetch(`/api/v1/automation/policies/${policy.id}`, { method: 'DELETE' });
    if (!response.ok) { setMessage(await readError(response)); return; }
    await refresh();
  };

  const setGlobalPause = async (paused: boolean) => {
    const response = await fetch('/api/v1/automation/control', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused, reason: paused ? globalReason : '' }) });
    if (!response.ok) { setMessage(await readError(response)); return; }
    await refresh();
  };

  const automatedActions = runs.flatMap((run) => run.actions).length;
  const openBreakers = Object.entries(runs[0]?.breakers ?? {}).filter(([, state]) => state.failures >= 3);
  const researchCandidates = members.filter((member) => ['editor', 'admin'].includes(member.role));
  const publishCandidates = members.filter((member) => ['publisher', 'admin'].includes(member.role));

  return <main className="min-h-screen bg-background text-foreground">
    <PageHeader icon={<Bot className="size-5" />} title="自动化控制台" subtitle="策略、预先授权、近期自动动作与熔断状态" />

    <PageContainer className="py-6">
      {message && <p className="mb-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{message}</p>}
      {loading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />读取中…</p>}

      {openBreakers.length > 0 && <div className="mb-5 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"><p className="flex items-center gap-2 font-semibold"><ShieldAlert className="size-4" />已熔断的阶段</p><ul className="mt-2 space-y-1">{openBreakers.map(([stage, state]) => <li key={stage}>{stageLabels[stage as AutomationStage] ?? stage}：连续失败 {state.failures} 次，最近错误「{state.lastError}」</li>)}</ul></div>}

      <section className={`mb-5 rounded-2xl border p-5 ${control.paused ? 'border-destructive/50 bg-destructive/5' : 'bg-card'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">全局自动化：{control.paused ? '已暂停' : '运行中'}</h2><p className="mt-1 text-xs text-muted-foreground">{control.paused ? control.reason : '调度器可按启用策略执行各阶段。'}{control.updatedAt ? ` · ${new Date(control.updatedAt).toLocaleString('zh-CN')} · ${control.updatedBy ?? '未知操作者'}` : ''}</p></div><div className="flex flex-wrap gap-2"><Input className="w-72" aria-label="全局暂停原因" value={globalReason} onChange={(event) => setGlobalReason(event.target.value)} /><Button variant={control.paused ? 'default' : 'destructive'} disabled={!control.paused && !globalReason.trim()} onClick={() => void setGlobalPause(!control.paused)}>{control.paused ? '恢复全部自动化' : '暂停全部自动化'}</Button></div></div>
        <p className="mt-3 text-sm">近 30 天审计动作：自动化 {activity.automated} / 人工 {activity.human}，自动化占比 {activity.automated + activity.human ? Math.round(activity.automated / (activity.automated + activity.human) * 100) : 0}%</p>
      </section>

      <section className="rounded-2xl border bg-card p-5">
        <h2 className="font-semibold">新建策略</h2>
        <p className="mt-1 text-xs text-muted-foreground">新策略默认：机械步骤自动、四道审批人工、自动建项目关闭、策略本身停用。建好后再逐项打开。</p>
        <div className="mt-3 flex flex-wrap gap-2"><Input className="max-w-sm" placeholder="策略名称" value={name} onChange={(event) => setName(event.target.value)} /><Button variant="outline" disabled={!name.trim()} onClick={() => void create()}>创建</Button></div>
      </section>

      <div className="mt-5 grid gap-5">
        {policies.map((policy) => <section className="rounded-2xl border bg-card p-5" key={policy.id}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">{policy.name}</h2>
              <p className="mt-1 font-mono text-[11px] text-muted-foreground">{policy.id} · v{policy.version}</p>
              <p className="mt-1 text-xs text-muted-foreground">近 30 天：{costs[policy.id]?.projectCount ?? 0} 个项目、成本 {((costs[policy.id]?.costMicros ?? 0) / 1_000_000).toFixed(2)} 单位</p>
            </div>
            <div className="flex gap-2">
              <Button variant={policy.enabled ? 'default' : 'outline'} onClick={() => void update(policy, { enabled: !policy.enabled })}>{policy.enabled ? '已启用' : '已停用'}</Button>
              <Button variant="destructive" onClick={() => void remove(policy)}>删除</Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {AUTOMATION_STAGES.map((stage) => <div key={stage}>
              <Label className="text-xs text-muted-foreground">{stageLabels[stage]}</Label>
              <NativeSelect className="mt-1 w-full" value={policy.stages[stage]} onChange={(event) => void update(policy, { stages: { ...policy.stages, [stage]: event.target.value as StageMode } })}>
                {STAGE_MODES.map((mode) => <NativeSelectOption key={mode} value={mode}>{mode === 'auto' ? '自动' : mode === 'manual' ? '人工' : '关闭'}</NativeSelectOption>)}
              </NativeSelect>
            </div>)}
          </div>

          <div className="mt-5 rounded-xl border border-dashed p-4">
            <p className="text-sm font-medium">预先授权的自动放行</p>
            <p className="mt-1 text-xs text-muted-foreground">自动放行写入的是下面这个真人的批准记录，note 里注明依据哪条策略。研究类与发布类授权人必须是不同的成员，否则 G7 的职责分离不成立；有效期一过自动转人工。</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(['research', 'script', 'qc', 'publish'] as const).map((kind) => <label className="flex items-center gap-2 text-sm" key={kind}>
                <input type="checkbox" checked={policy.autoApprovals[kind].enabled} onChange={(event) => void update(policy, { autoApprovals: { ...policy.autoApprovals, [kind]: { enabled: event.target.checked } } })} />
                {approvalLabels[kind]}
              </label>)}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div><Label className="text-xs text-muted-foreground">研究/脚本/终审授权人</Label>
                <NativeSelect className="mt-1 w-full" value={policy.researchAuthorizedBy ?? ''} onChange={(event) => void update(policy, { researchAuthorizedBy: event.target.value || null })}>
                  <NativeSelectOption value="">未指定</NativeSelectOption>
                  {researchCandidates.map((member) => <NativeSelectOption key={member.user_id} value={member.user_id}>{member.email}（{member.role}）</NativeSelectOption>)}
                </NativeSelect>
              </div>
              <div><Label className="text-xs text-muted-foreground">发布授权人（必须不同人）</Label>
                <NativeSelect className="mt-1 w-full" value={policy.publishAuthorizedBy ?? ''} onChange={(event) => void update(policy, { publishAuthorizedBy: event.target.value || null })}>
                  <NativeSelectOption value="">未指定</NativeSelectOption>
                  {publishCandidates.map((member) => <NativeSelectOption key={member.user_id} value={member.user_id}>{member.email}（{member.role}）</NativeSelectOption>)}
                </NativeSelect>
              </div>
              <div><Label className="text-xs text-muted-foreground">预先授权有效期</Label>
                <Input className="mt-1" type="datetime-local" value={policy.expiresAt ? policy.expiresAt.slice(0, 16) : ''} onChange={(event) => void update(policy, { expiresAt: event.target.value ? new Date(event.target.value).toISOString() : null })} />
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div><Label className="text-xs text-muted-foreground">每日自动建项目上限</Label><Input className="mt-1" type="number" min="0" value={policy.guardrails.dailyProjectLimit} onChange={(event) => void update(policy, { guardrails: { ...policy.guardrails, dailyProjectLimit: Number(event.target.value) } })} /></div>
            <div><Label className="text-xs text-muted-foreground">每日自动发布上限</Label><Input className="mt-1" type="number" min="0" value={policy.guardrails.dailyPublishLimit} onChange={(event) => void update(policy, { guardrails: { ...policy.guardrails, dailyPublishLimit: Number(event.target.value) } })} /></div>
            <div><Label className="text-xs text-muted-foreground">最低独立来源数</Label><Input className="mt-1" type="number" min="2" value={policy.guardrails.minIndependentSources} onChange={(event) => void update(policy, { guardrails: { ...policy.guardrails, minIndependentSources: Number(event.target.value) } })} /></div>
            <div><Label className="text-xs text-muted-foreground">单条成本上限（micros，0 表示不限）</Label><Input className="mt-1" type="number" min="0" value={policy.guardrails.maxCostMicrosPerProject} onChange={(event) => void update(policy, { guardrails: { ...policy.guardrails, maxCostMicrosPerProject: Number(event.target.value) } })} /></div>
            <div><Label className="text-xs text-muted-foreground">静默时段起（UTC 小时）</Label><Input className="mt-1" type="number" min="0" max="23" value={policy.guardrails.quietHoursUtc.start} onChange={(event) => void update(policy, { guardrails: { ...policy.guardrails, quietHoursUtc: { ...policy.guardrails.quietHoursUtc, start: Number(event.target.value) } } })} /></div>
            <div><Label className="text-xs text-muted-foreground">静默时段止（UTC 小时）</Label><Input className="mt-1" type="number" min="0" max="23" value={policy.guardrails.quietHoursUtc.end} onChange={(event) => void update(policy, { guardrails: { ...policy.guardrails, quietHoursUtc: { ...policy.guardrails.quietHoursUtc, end: Number(event.target.value) } } })} /></div>
            <div><Label className="text-xs text-muted-foreground">选题分数下限</Label><Input className="mt-1" type="number" min="0" max="100" value={policy.scope.minTopicScore} onChange={(event) => void update(policy, { scope: { ...policy.scope, minTopicScore: Number(event.target.value) } })} /></div>
            <div><Label className="text-xs text-muted-foreground">选题质量分下限</Label><Input className="mt-1" type="number" min="0" max="100" value={policy.scope.minQualityScore} onChange={(event) => void update(policy, { scope: { ...policy.scope, minQualityScore: Number(event.target.value) } })} /></div>
            <label className="flex items-center gap-2 self-end text-sm"><input type="checkbox" checked={policy.scope.requireTopicQuality} onChange={(event) => void update(policy, { scope: { ...policy.scope, requireTopicQuality: event.target.checked } })} />要求选题质量指标达标</label>
            <div><Label className="text-xs text-muted-foreground">品牌范围（逗号分隔，空为不限）</Label><Input className="mt-1" defaultValue={policy.scope.brands.join(',')} onBlur={(event) => void update(policy, { scope: { ...policy.scope, brands: splitList(event.target.value) } })} /></div>
            <div><Label className="text-xs text-muted-foreground">语言范围（逗号分隔，空为不限）</Label><Input className="mt-1" defaultValue={policy.scope.locales.join(',')} onBlur={(event) => void update(policy, { scope: { ...policy.scope, locales: splitList(event.target.value) } })} /></div>
            <div><Label className="text-xs text-muted-foreground">来源类型（social/media/market/filing/company）</Label><Input className="mt-1" defaultValue={policy.scope.sourceTypes.join(',')} onBlur={(event) => void update(policy, { scope: { ...policy.scope, sourceTypes: splitList(event.target.value) } })} /></div>
          </div>
        </section>)}
        {!loading && !policies.length && <p className="rounded-xl border border-dashed p-7 text-center text-sm text-muted-foreground">还没有自动化策略。没有启用中的策略时，引擎只做采集、选题质量评估与指标提醒，不会推进任何项目。</p>}
      </div>

      <section className="mt-7">
        <h2 className="text-lg font-semibold tracking-tight">近期自动动作</h2>
        <p className="mt-1 text-sm text-muted-foreground">最近 {runs.length} 轮 tick 共 {automatedActions} 个自动动作。每个动作在审计流里都带 trigger=automation 与策略 ID。</p>
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
  </main>;
}
