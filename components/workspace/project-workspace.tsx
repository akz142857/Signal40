'use client';

import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, CircleAlert, FileText, Film, Gauge, Layers3, LoaderCircle, Mic2, PackageCheck, Play, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { PageContainer, PageHeader } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { ScriptEditor, StoryboardEditor } from '@/components/workspace/production-editors';
import { ResearchEditor } from '@/components/workspace/research-editor';
import { MetricsPanel } from '@/components/workspace/metrics-panel';
import { ProductionConfig } from '@/components/workspace/production-config';
import type { ProjectRecord } from '@/lib/control-plane';
import type { ContentState, GateResult, Role } from '@/lib/workflow';
import { stableHash } from '@/lib/workflow';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';

const VideoPreview = lazy(() => import('@/components/workspace/video-preview').then((module) => ({ default: module.VideoPreview })));

type AuditEvent = { id: string; action: string; actor_id: string; actor_role: string; created_at: string; metadata: Record<string, unknown> };

type OrphanedJob = { id: string; kind: string; projectId: string | null; createdAt: string };
type Incident = { id: string; kind: string; severity: string; status: 'open' | 'resolved'; reason: string; resolution: string | null; actor_id: string; created_at: string };

const phases = [
  { label: '研究', states: ['DRAFT', 'RESEARCHING', 'EVIDENCE_READY', 'EDITOR_APPROVED'], icon: ShieldCheck },
  { label: '脚本', states: ['SCRIPT_DRAFT', 'SCRIPT_APPROVED'], icon: FileText },
  { label: '制作', states: ['ASSETS_READY', 'RENDER_QUEUED', 'RENDERING'], icon: Layers3 },
  { label: '质检', states: ['QC_PENDING', 'QC_APPROVED'], icon: Gauge },
  { label: '发布', states: ['PUBLISH_SCHEDULED', 'PUBLISHED', 'MEASURED'], icon: Film },
] as const;

const nextState: Partial<Record<ContentState, ContentState>> = {
  DRAFT: 'RESEARCHING',
  RESEARCHING: 'EVIDENCE_READY',
  EVIDENCE_READY: 'EDITOR_APPROVED',
  EDITOR_APPROVED: 'SCRIPT_DRAFT',
  SCRIPT_DRAFT: 'SCRIPT_APPROVED',
  SCRIPT_APPROVED: 'ASSETS_READY',
  ASSETS_READY: 'RENDER_QUEUED',
  QC_PENDING: 'QC_APPROVED',
  QC_APPROVED: 'PUBLISH_SCHEDULED',
  PUBLISHED: 'MEASURED',
};

const stateLabels: Record<ContentState, string> = {
  DRAFT: '项目草稿', RESEARCHING: '研究中', EVIDENCE_READY: '证据就绪', EDITOR_APPROVED: '研究已批准', SCRIPT_DRAFT: '脚本草稿', SCRIPT_APPROVED: '脚本已批准', ASSETS_READY: '资产就绪', RENDER_QUEUED: '等待渲染', RENDERING: '渲染中', QC_PENDING: '等待质检', QC_APPROVED: '终审通过', PUBLISH_SCHEDULED: '已排期', PUBLISHED: '已发布', MEASURED: '已回流', CHANGES_REQUESTED: '要求修改', REJECTED: '已驳回', FAILED: '失败', CANCELLED: '已取消',
};

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || `请求失败（${response.status}）`;
}

export function ProjectWorkspace({ initialProject }: { initialProject: ProjectRecord }) {
  const [project, setProject] = useState(initialProject);
  const [gates, setGates] = useState<GateResult[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [note, setNote] = useState('已核对当前版本、证据与发布风险。');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [orphaned, setOrphaned] = useState<OrphanedJob[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentKind, setIncidentKind] = useState('correction');
  const [incidentSeverity, setIncidentSeverity] = useState('medium');
  // 挂上会话：devIdentityHeaders 读的是它带回来的部署级开关；身份本身由 AppBar 展示。
  useSession();
  // 生产环境返回空对象，服务端用反向代理注入的真实身份；
  // 只有本机开发且服务端明确允许时，才带上伪造角色头。
  const actorHeaders = useCallback(
    (role: Role, actorId?: string) => devIdentityHeaders({ role, id: actorId }),
    [],
  );

  const refresh = useCallback(async () => {
    const [projectResponse, gateResponse, auditResponse, workerResponse, incidentResponse] = await Promise.all([
      fetch(`/api/v1/projects/${project.id}`, { cache: 'no-store' }),
      fetch(`/api/v1/projects/${project.id}/gates`, { cache: 'no-store' }),
      fetch(`/api/v1/projects/${project.id}/audit`, { cache: 'no-store' }),
      fetch('/api/v1/workers', { cache: 'no-store' }),
      fetch(`/api/v1/projects/${project.id}/incidents`, { cache: 'no-store' }),
    ]);
    if (!projectResponse.ok) throw new Error(await readError(projectResponse));
    const projectPayload = (await projectResponse.json()) as { project: ProjectRecord };
    const gatePayload = (await gateResponse.json()) as { gates: GateResult[] };
    const auditPayload = (await auditResponse.json()) as { events: AuditEvent[] };
    setProject(projectPayload.project);
    setGates(gatePayload.gates);
    setAudit(auditPayload.events);
    if (incidentResponse.ok) setIncidents(((await incidentResponse.json()) as { incidents: Incident[] }).incidents);
    if (workerResponse.ok) {
      const workerPayload = (await workerResponse.json()) as { orphanedJobs: OrphanedJob[] };
      setOrphaned(workerPayload.orphanedJobs.filter((job) => job.projectId === project.id));
    }
  }, [project.id]);

  const refreshWorkers = useCallback(async () => {
    const response = await fetch('/api/v1/workers', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json() as { orphanedJobs: OrphanedJob[] };
    setOrphaned(payload.orphanedJobs.filter((job) => job.projectId === project.id));
  }, [project.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '刷新失败。'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => { void refreshWorkers(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [refreshWorkers]);

  const approve = async (kind: 'research' | 'script' | 'qc' | 'publish') => {
    setBusy(true);
    try {
      const subjectHash = kind === 'research'
        ? project.project.research.approvedHash
        : kind === 'script'
          ? stableHash(project.project.script)
          : project.immutableHash;
      const role = kind === 'publish' ? 'publisher' : kind === 'qc' ? 'producer' : 'editor';
      const actorId = kind === 'publish' ? 'local-publisher' : kind === 'qc' ? 'local-producer' : 'local-editor';
      const response = await fetch(`/api/v1/projects/${project.id}/approvals`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...actorHeaders(role as Role, actorId) },
        body: JSON.stringify({ kind, decision: 'approved', subjectHash, note }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await refresh();
      setMessage(`${kind} 批准已写入不可变审计。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批准失败。');
    } finally { setBusy(false); }
  };

  const transition = async (to: ContentState) => {
    setBusy(true);
    try {
      const role = ['PUBLISH_SCHEDULED', 'PUBLISHED', 'MEASURED'].includes(to) ? 'publisher' : ['ASSETS_READY', 'RENDER_QUEUED', 'RENDERING', 'QC_PENDING'].includes(to) ? 'producer' : 'editor';
      const actorId = role === 'publisher' ? 'local-publisher' : role === 'producer' ? 'local-producer' : 'local-editor';
      const response = await fetch(`/api/v1/projects/${project.id}/transitions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, ...actorHeaders(role as Role, actorId) },
        body: JSON.stringify({ to, note }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await refresh();
      setMessage(`状态已推进到 ${stateLabels[to]}。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '状态推进失败。');
    } finally { setBusy(false); }
  };

  const enqueueRender = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `render:${project.id}:${project.project.render.snapshotHash}`, ...actorHeaders('producer') },
        body: JSON.stringify({ kind: 'render', projectId: project.id, payload: { projectId: project.id, snapshotHash: project.project.render.snapshotHash, compositionId: project.project.render.compositionId } }),
      });
      if (!response.ok) throw new Error(await readError(response));
      if (project.state === 'ASSETS_READY') await transition('RENDER_QUEUED');
      else await refresh();
      setMessage('渲染任务已按快照哈希幂等入队。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '渲染任务创建失败。');
    } finally { setBusy(false); }
  };

  const enqueuePreview = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `preview:${project.id}:${project.project.render.snapshotHash}`, ...actorHeaders('producer') },
        body: JSON.stringify({ kind: 'preview', projectId: project.id, priority: 60, payload: { projectId: project.id, snapshotHash: project.project.render.snapshotHash, compositionId: project.project.render.compositionId } }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage('低码率预览片已按当前不可变快照入队；它不会推进正式成片状态。');
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '预览任务创建失败。');
    } finally { setBusy(false); }
  }, [actorHeaders, project.id, project.project.render.compositionId, project.project.render.snapshotHash, refresh]);

  const enqueueVoice = async () => {
    setBusy(true);
    try {
      const scriptHash = stableHash(project.project.script);
      const response = await fetch('/api/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `voice:${project.id}:${scriptHash}`, ...actorHeaders('producer') },
        body: JSON.stringify({ kind: 'voice', projectId: project.id, payload: { projectId: project.id, scriptVersion: project.project.script.version, scriptHash } }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage('配音任务已入队；Worker 将生成语音、执行转写对齐并写入字幕轨。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '配音任务创建失败。'); }
    finally { setBusy(false); }
  };

  const enqueuePublish = async (channel: 'package' | 'youtube') => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/publish-jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `${channel}:${project.id}:${project.project.render.snapshotHash}`, ...actorHeaders('publisher', 'local-publisher') },
        body: JSON.stringify({ channel, accountId: project.project.distribution.accountId, title: project.project.distribution.title, description: project.project.distribution.description, tags: project.project.distribution.tags, coverAssetId: project.project.distribution.coverAssetId, scheduledAt: project.project.distribution.scheduledAt, privacyStatus: 'private' }),
      });
      if (!response.ok) throw new Error(await readError(response));
      setMessage(channel === 'youtube' ? 'YouTube 私密上传已入队；只有显式开启公开发布开关后才可改变可见性。' : '可下载发布包已入队。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '发布任务创建失败。'); }
    finally { setBusy(false); }
  };

  const setAutomation = async (action: 'pause' | 'resume') => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/automation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...actorHeaders('editor', 'local-editor') },
        body: JSON.stringify({ action, reason: action === 'pause' ? (note.trim().length >= 5 ? note.trim() : '人工接管本项目。') : undefined }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await refresh();
      setMessage(action === 'pause' ? '本项目已转人工，编排引擎不会再推进它。' : '本项目已恢复自动推进。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '自动化状态更新失败。'); }
    finally { setBusy(false); }
  };

  const createIncident = async () => {
    if (note.trim().length < 10) { setMessage('登记内容事件需要至少 10 个字的原因。'); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/incidents`, { method: 'POST', headers: { 'content-type': 'application/json', ...actorHeaders('editor', 'local-editor') }, body: JSON.stringify({ kind: incidentKind, severity: incidentSeverity, reason: note.trim() }) });
      if (!response.ok) throw new Error(await readError(response));
      await refresh();
      setMessage('内容事件已登记，本项目自动化已暂停。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '内容事件登记失败。'); }
    finally { setBusy(false); }
  };

  const resolveIncident = async (incident: Incident) => {
    if (note.trim().length < 10) { setMessage('关闭内容事件需要至少 10 个字的处置结果。'); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/incidents/${incident.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...actorHeaders('editor', 'local-editor') }, body: JSON.stringify({ resolution: note.trim() }) });
      if (!response.ok) throw new Error(await readError(response));
      await refresh();
      setMessage('内容事件已关闭；自动化仍保持人工模式，需显式恢复。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '内容事件关闭失败。'); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = async () => {
      await context.registerTool({
        name: 'inspect_signal40_project',
        title: '查看 Signal 40 项目状态',
        description: '读取当前项目版本、生产状态、不可变快照、模板与 G0-G8 门禁结果。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: () => ({ projectId: project.id, version: project.version, state: project.state, templateId: project.project.render.templateId, templateVersion: project.project.render.templateVersion, snapshotHash: project.project.render.snapshotHash, gates }),
      }, { signal: lifecycle.signal });
      await context.registerTool({
        name: 'set_signal40_project_template',
        title: '切换 Signal 40 视频模板',
        description: '按当前 ETag 切换视觉模板并重新冻结渲染快照；服务端会执行制作人权限和状态检查。',
        inputSchema: { type: 'object', additionalProperties: false, required: ['templateId'], properties: { templateId: { enum: ['signal40-editorial', 'signal40-terminal', 'signal40-brief'] } } },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async (input) => {
          const templateId = input && typeof input === 'object' && 'templateId' in input ? String((input as { templateId: unknown }).templateId) : '';
          const response = await fetch(`/api/v1/projects/${project.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, ...actorHeaders('producer', 'webmcp-producer') }, body: JSON.stringify({ templateId }) });
          if (!response.ok) throw new Error(await readError(response));
          const payload = await response.json() as { project: ProjectRecord };
          await refresh();
          return { projectId: project.id, version: payload.project.version, templateId: payload.project.project.render.templateId, snapshotHash: payload.project.project.render.snapshotHash };
        },
      }, { signal: lifecycle.signal });
      await context.registerTool({
        name: 'request_signal40_preview',
        title: '请求 Signal 40 低码率预览',
        description: '为当前已冻结快照创建低码率预览任务；不会推进正式成片状态。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute: async () => { await enqueuePreview(); return { projectId: project.id, snapshotHash: project.project.render.snapshotHash, requested: true }; },
      }, { signal: lifecycle.signal });
      await context.registerTool({
        name: 'advance_signal40_project',
        title: '推进 Signal 40 项目',
        description: '只推进到状态机允许的下一阶段；服务端会重新计算门禁并检查角色与 ETag。',
        inputSchema: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: { type: 'string', minLength: 10, maxLength: 1000 } } },
        annotations: { readOnlyHint: false, untrustedContentHint: true },
        execute: async (input) => {
          const next = nextState[project.state];
          const nextNote = input && typeof input === 'object' && 'note' in input ? String((input as { note: unknown }).note) : '';
          if (!next) throw new Error(`项目处于 ${project.state}，没有可由人工直接推进的下一状态。`);
          if (nextNote.trim().length < 10) throw new Error('推进原因至少需要 10 个字符。');
          const role = ['PUBLISH_SCHEDULED', 'PUBLISHED', 'MEASURED'].includes(next) ? 'publisher' : ['ASSETS_READY', 'RENDER_QUEUED'].includes(next) ? 'producer' : 'editor';
          const response = await fetch(`/api/v1/projects/${project.id}/transitions`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, ...actorHeaders(role as Role, `webmcp-${role}`) }, body: JSON.stringify({ to: next, note: nextNote }) });
          if (!response.ok) throw new Error(await readError(response));
          await refresh();
          return { projectId: project.id, from: project.state, to: next };
        },
      }, { signal: lifecycle.signal });
    };
    void register().catch(() => undefined);
    return () => lifecycle.abort();
  }, [actorHeaders, enqueuePreview, gates, project, refresh]);

  const activePhase = Math.max(0, phases.findIndex((phase) => (phase.states as readonly string[]).includes(project.state)));
  const currentNext = nextState[project.state];
  const canRequestChanges = ['EVIDENCE_READY', 'EDITOR_APPROVED', 'SCRIPT_DRAFT', 'SCRIPT_APPROVED', 'ASSETS_READY', 'QC_PENDING', 'QC_APPROVED', 'PUBLISHED'].includes(project.state);
  const requiredApproval = project.state === 'EVIDENCE_READY' ? 'research' : project.state === 'SCRIPT_DRAFT' ? 'script' : project.state === 'QC_PENDING' ? 'qc' : project.state === 'QC_APPROVED' ? 'publish' : null;
  const gateSummary = useMemo(() => ({ passed: gates.filter((gate) => gate.passed).length, total: gates.length }), [gates]);

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PageHeader
        icon={<Layers3 className="size-5" />}
        title={project.title}
        subtitle={<><Link href="/" className="hover:text-foreground hover:underline">雷达</Link><span> / 项目工作台 · v{project.version}</span></>}
        actions={
          <>
            <span className="rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold">{stateLabels[project.state]}</span>
            <span className="font-mono text-xs text-muted-foreground">Gates {gateSummary.passed}/{gateSummary.total}</span>
          </>
        }
      />

      <PageContainer className="grid gap-5 py-6 xl:grid-cols-[210px_minmax(0,1fr)_330px]">
        <nav className="space-y-2" aria-label="生产阶段">
          {phases.map((phase, index) => { const Icon = phase.icon; const complete = index < activePhase; const active = index === activePhase; return <div key={phase.label} className={`flex items-center gap-3 rounded-xl border p-3 ${active ? 'border-chart-1 bg-chart-1/10' : 'border-transparent'}`}><span className={`grid size-9 place-items-center rounded-lg ${complete ? 'bg-chart-1 text-primary' : 'bg-secondary'}`}>{complete ? <CheckCircle2 className="size-4" /> : <Icon className="size-4" />}</span><div><p className="text-sm font-semibold">{phase.label}</p><p className="text-xs text-muted-foreground">{complete ? '已通过' : active ? '当前阶段' : '待开始'}</p></div></div>; })}
        </nav>

        <div className="space-y-5">
          {message && <output className="block rounded-xl border border-chart-3/30 bg-chart-3/10 px-4 py-3 text-sm">{message}</output>}
          {orphaned.length > 0 && <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <p className="font-semibold">入队的作业没有人会执行</p>
            <p className="mt-1 leading-6">{orphaned.map((job) => job.kind).join('、')} 作业已排队超过 60 秒，但没有任何在线 Worker 声明能处理这些类型。请确认 render-worker 服务是否在运行（<span className="font-mono">docker compose up -d render-worker</span>），或到 <Link className="underline" href="/settings/diagnostics">系统自检</Link> 查看原因。</p>
          </div>}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
            <div>
              <p className="font-medium">自动化：{project.automationMode === 'auto' ? '自动推进中' : '已转人工'}</p>
              <p className="mt-1 text-xs text-muted-foreground">{project.automationMode === 'auto' ? '门禁通过且在策略范围内的步骤会由编排引擎推进；任何人工编辑都会立刻转人工。' : project.automationPausedReason || '需要显式恢复后才会继续自动推进。'}</p>
            </div>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void setAutomation(project.automationMode === 'auto' ? 'pause' : 'resume')}>{project.automationMode === 'auto' ? '暂停自动化' : '恢复自动'}</Button>
          </div>
          <section className="grid items-center gap-5 rounded-2xl border border-border bg-card p-5 md:grid-cols-[minmax(0,1fr)_300px]">
            <div><p className="font-mono text-xs uppercase tracking-[0.15em] text-chart-1">Remotion player</p><h2 className="mt-2 text-lg font-semibold tracking-tight">实时成片预览</h2><p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">预览和正式渲染使用同一个 React Composition 与同一份不可变快照。当前模板为竖屏 1080 × 1920、30fps、45 秒。</p><div className="mt-5 grid grid-cols-2 gap-3 text-sm"><div className="rounded-xl bg-secondary/60 p-3"><p className="text-xs text-muted-foreground">Composition</p><p className="mt-1 font-mono">{project.project.render.compositionId}</p></div><div className="rounded-xl bg-secondary/60 p-3"><p className="text-xs text-muted-foreground">Snapshot</p><p className="mt-1 font-mono">{project.project.render.snapshotHash}</p></div></div></div>
            <Suspense fallback={<div className="mx-auto grid aspect-[9/16] w-full max-w-[300px] place-items-center rounded-2xl bg-black text-xs text-white/60">加载成片预览…</div>}><VideoPreview project={project.project} /></Suspense>
          </section>
          <ResearchEditor key={`research-${project.version}`} project={project} onSaved={refresh} onMessage={setMessage} />

          <section className="grid gap-5 lg:grid-cols-2">
            <ScriptEditor key={`script-${project.version}`} project={project} onSaved={refresh} onMessage={setMessage} />
            <StoryboardEditor key={`storyboard-${project.version}`} project={project} onSaved={refresh} onMessage={setMessage} />
          </section>

          <section className="grid gap-3 sm:grid-cols-3">
            <Metric icon={PackageCheck} label="版权已清资产" value={`${project.project.assets.filter((asset) => asset.rightsStatus === 'cleared').length}/${project.project.assets.length}`} />
            <Metric icon={Mic2} label="配音" value={project.project.audio.objectKey ? '已生成' : '未生成'} />
            <Metric icon={Film} label="渲染快照" value={project.project.render.templateVersion} />
          </section>
          <ProductionConfig key={`production-${project.version}`} project={project} onSaved={refresh} onMessage={setMessage} />
          <MetricsPanel project={project} onSaved={refresh} onMessage={setMessage} />
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-semibold">内容事件</h2>
            <p className="mt-1 text-xs text-muted-foreground">勘误、事实更新或投诉会立即让自动化转人工；关闭事件后仍需显式恢复。</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <NativeSelect value={incidentKind} onChange={(event) => setIncidentKind(event.target.value)}><NativeSelectOption value="correction">勘误</NativeSelectOption><NativeSelectOption value="fact_update">事实更新</NativeSelectOption><NativeSelectOption value="complaint">投诉</NativeSelectOption></NativeSelect>
              <NativeSelect value={incidentSeverity} onChange={(event) => setIncidentSeverity(event.target.value)}><NativeSelectOption value="low">低</NativeSelectOption><NativeSelectOption value="medium">中</NativeSelectOption><NativeSelectOption value="high">高</NativeSelectOption><NativeSelectOption value="critical">严重</NativeSelectOption></NativeSelect>
              <Button variant="outline" disabled={busy || note.trim().length < 10} onClick={() => void createIncident()}><CircleAlert />用“当前操作”说明登记事件</Button>
            </div>
            <div className="mt-4 grid gap-2">{incidents.map((incident) => <article className="rounded-xl bg-secondary/50 p-3 text-sm" key={incident.id}><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{incident.kind} · {incident.severity}</span><span className={incident.status === 'open' ? 'text-destructive' : 'text-chart-1'}>{incident.status === 'open' ? '处理中' : '已关闭'}</span><span className="text-xs text-muted-foreground">{new Date(incident.created_at).toLocaleString('zh-CN')} · {incident.actor_id}</span></div><p className="mt-1 leading-6">{incident.reason}</p>{incident.resolution && <p className="mt-1 text-muted-foreground">处置：{incident.resolution}</p>}{incident.status === 'open' && <Button className="mt-2" size="sm" variant="outline" disabled={busy || note.trim().length < 10} onClick={() => void resolveIncident(incident)}>用“当前操作”说明关闭</Button>}</article>)}{!incidents.length && <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">当前没有内容事件。</p>}</div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-border bg-card p-4"><h2 className="font-semibold">G0–G8 门禁</h2><div className="mt-3 space-y-2">{gates.map((gate) => <div key={gate.code} className="flex items-start gap-2 rounded-lg bg-secondary/50 p-2.5">{gate.passed ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-chart-1" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-chart-2" />}<div><p className="font-mono text-xs font-semibold">{gate.code}</p>{!gate.passed && <p className="mt-1 text-xs leading-5 text-muted-foreground">{gate.reasons.join('；')}</p>}</div></div>)}</div></section>
          <section className="rounded-2xl border border-border bg-card p-4"><h2 className="font-semibold">当前操作</h2><Textarea className="mt-3 min-h-24 text-sm" value={note} onChange={(event) => setNote(event.target.value)} /><div className="mt-3 grid gap-2">{requiredApproval && <Button variant="outline" disabled={busy || note.trim().length < 10} onClick={() => void approve(requiredApproval)}><ShieldCheck />批准当前 {requiredApproval}</Button>}{project.state === 'SCRIPT_APPROVED' && !project.project.audio.objectKey && <Button variant="outline" disabled={busy} onClick={() => void enqueueVoice()}><Mic2 />生成配音与字幕</Button>}{project.state === 'PUBLISH_SCHEDULED' && <><Button variant="outline" disabled={busy} onClick={() => void enqueuePublish('package')}><PackageCheck />生成发布包</Button><Button disabled={busy} onClick={() => void enqueuePublish('youtube')}><Film />YouTube 私密上传</Button></>}{project.state === 'ASSETS_READY' ? <><Button variant="outline" disabled={busy} onClick={() => void enqueuePreview()}>{busy ? <LoaderCircle className="animate-spin" /> : <Play />}生成低码率预览片</Button><Button disabled={busy} onClick={() => void enqueueRender()}>{busy ? <LoaderCircle className="animate-spin" /> : <Film />}创建正式渲染任务</Button></> : project.state !== 'PUBLISH_SCHEDULED' && currentNext && <Button disabled={busy} onClick={() => void transition(currentNext)}>{busy ? <LoaderCircle className="animate-spin" /> : <Play />}推进到 {stateLabels[currentNext]}</Button>}{canRequestChanges && <Button variant="destructive" disabled={busy || note.trim().length < 10} onClick={() => void transition('CHANGES_REQUESTED')}><CircleAlert />要求修改</Button>}</div><p className="mt-3 text-xs leading-5 text-muted-foreground">若对应门禁未通过，服务端会拒绝推进并返回具体原因。</p></section>
          <section className="rounded-2xl border border-border bg-card p-4"><h2 className="font-semibold">审计流</h2><div className="mt-3 space-y-3">{audit.slice(0, 8).map((event) => { const trigger = event.metadata?.trigger === 'automation' ? '自动化' : event.metadata?.trigger === 'human' ? '人工' : '历史记录'; const policyId = typeof event.metadata?.policyId === 'string' ? event.metadata.policyId : null; return <div key={event.id} className="border-l-2 border-border pl-3"><p className="text-sm font-medium">{event.action}</p><p className="mt-1 text-xs text-muted-foreground">{trigger} · {event.actor_id} · {event.actor_role} · {new Date(event.created_at).toLocaleString('zh-CN')}</p>{policyId ? <p className="mt-1 font-mono text-[11px] text-muted-foreground">Policy: {policyId}</p> : null}</div>; })}{!audit.length && <p className="text-sm text-muted-foreground">正在读取审计记录…</p>}</div></section>
        </aside>
      </PageContainer>
    </main>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Circle; label: string; value: string }) {
  return <div className="rounded-2xl border border-border bg-card p-4"><Icon className="size-4 text-muted-foreground" /><p className="mt-3 text-xs text-muted-foreground">{label}</p><p className="mt-1 font-semibold">{value}</p></div>;
}
