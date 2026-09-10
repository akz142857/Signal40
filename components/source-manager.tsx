'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  CalendarClock,
  CheckCircle2,
  DatabaseZap,
  History,
  ListPlus,
  LoaderCircle,
  Play,
  RefreshCw,
  ShieldAlert,
  TestTube2,
  Trash2,
  TriangleAlert,
  UsersRound,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';
import { PageContainer, PageHeader } from '@/components/page-shell';
import type {
  ConnectorReleaseMode,
  IngestionQuarantineStatus,
  IngestionRunStatus,
  SourceHealthStatus,
  SourceLifecycleStatus,
  SourceRightsStatus,
} from '@/lib/source-lifecycle-status';

type SourceRow = {
  id: string;
  name: string;
  adapter: 'rss' | 'http' | 'web' | 'social';
  platform: 'rss' | 'http_json' | 'web_page' | 'wechat' | 'xiaohongshu';
  lifecycleStatus: Exclude<SourceLifecycleStatus, 'archived'>;
  healthStatus: SourceHealthStatus;
  rightsStatus: SourceRightsStatus;
  enabled: boolean;
  version: number;
  ownerTeamId: string | null;
  businessOwnerId: string | null;
  publisherEntityId: string | null;
  scheduleCron: string | null;
  checkpointVersion: number;
  nextRunAt: string | null;
  lastSuccessAt: string | null;
  lastTestedAt: string | null;
  publicErrorMessage: string | null;
  publicErrorCode: string | null;
  consecutiveFailures: number;
  hasActiveRun: boolean;
  deletionStatus:
    | 'pending'
    | 'blocked'
    | 'deleting'
    | 'awaiting_external'
    | 'failed'
    | null;
  deletionRequestId: string | null;
  pendingRightsRequestId: string | null;
  pendingRightsRequestedBy: string | null;
  rateLimitPerMinute: number;
  costMicrosPerRequest: number;
  estimatedRequestsPerRun: number;
  monthlyBudgetMicros: number;
  budgetSoftLimitPercent: number;
  schedulePriority: number;
  autoThrottleEnabled: boolean;
  effectiveScheduleMultiplier: number;
  scheduleThrottleReason: string | null;
  scheduleThrottleRecoveryAt: string | null;
  retention: { mode: 'metadata' | 'raw'; days: number };
  publicConfig: {
    sourceType?: string;
    url?: string;
    mapping?: Record<string, string>;
    pagination?: {
      mode: 'none' | 'page' | 'cursor' | 'since';
      maxPages?: number;
      pageParameter?: string;
      startPage?: number;
      pageSizeParameter?: string;
      pageSize?: number;
      cursorParameter?: string;
      cursorPath?: string;
      sinceParameter?: string;
      hasMorePath?: string;
    };
    discoveryMode?: 'opencli' | 'rss';
    accountName?: string;
    searchLimit?: number;
  };
};

type PreviewItem = {
  title: string;
  url: string;
  publishedAt: string;
  author?: string;
  summary?: string;
};
type WorkerRow = { online: boolean; capabilities: string[] };
type IngestionRun = {
  id: string;
  status: IngestionRunStatus;
  quarantineStatus: IngestionQuarantineStatus;
  trigger: string;
  acceptedCount: number;
  rejectedCount: number;
  duplicateCount: number;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};
type SourceImportCandidate = {
  row: number;
  name: string;
  adapter: 'rss' | 'http' | 'web';
  platform: 'rss' | 'http_json' | 'web_page' | 'wechat' | 'xiaohongshu';
  sourceType: 'social' | 'media' | 'market' | 'filing' | 'company';
  url: string;
  scheduleCron: string | null;
  confirmed: boolean;
};
type SourceImportIssue = { row: number; message: string };
type SourceBackfillEstimate = {
  basisVersion: string;
  sourceVersion: number;
  from: string;
  to: string;
  maxItems: number;
  itemUpperBound: number;
  estimatedRequests: number;
  estimatedCostMicros: number;
  estimatedDurationSeconds: number;
  lookbackDays: number;
  costMode: 'modeled' | 'unmodeled';
  requiresConfirmation: boolean;
  confirmationHash: string;
};
type ConnectorRelease = {
  id: string;
  version: string;
  platform: string;
  adapter: 'rss' | 'http' | 'web' | 'social';
  label: string;
  availability: 'available' | 'blocked';
  rolloutMode: ConnectorReleaseMode;
  rolloutReason: string;
  rolloutVersion: number;
  canaryEnabled: boolean;
  canaryPercent: number;
  canaryFailureRateBps: number;
  canaryMinRuns: number;
  canaryStartedAt: string | null;
  canaryStoppedAt: string | null;
  effectiveAvailability: 'available' | 'blocked';
};
type TeamMember = {
  user_id: string;
  email: string;
  role: string;
  status: 'active' | 'suspended';
  can_approve_source_rights: number;
  can_manage_source_legal: number;
};
type OwnershipDraft = {
  businessOwnerId: string;
};

type SourceSloExclusion = {
  id: string;
  kind: 'manual_pause' | 'planned_maintenance';
  startsAt: string;
  endsAt: string | null;
  reason: string;
  cancelledAt: string | null;
};

type SourceLegalHold = {
  id: string;
  status: 'active' | 'released';
  reason: string;
  authority_ref: string;
  hold_epoch: number;
  created_by: string;
  released_by: string | null;
  created_at: string;
  released_at: string | null;
};

type MaintenanceDraft = {
  startsAt: string;
  endsAt: string;
  reason: string;
};

type SourceProposal = {
  id: string;
  name: string;
  adapter: 'rss' | 'http' | 'web' | 'social';
  platform: 'rss' | 'http_json' | 'web_page' | 'wechat' | 'xiaohongshu';
  sourceType: 'social' | 'media' | 'market' | 'filing' | 'company';
  url: string | null;
  discoveryMode: 'opencli' | 'rss' | null;
  accountName: string | null;
  searchLimit: number | null;
  scheduleCron: string | null;
  status: 'proposal_pending' | 'proposal_approved' | 'proposal_rejected';
  requestedBy: string;
  requestNote: string;
  decidedBy: string | null;
  decisionNote: string | null;
  sourceConfigId: string | null;
  createdAt: string;
  decidedAt: string | null;
};

async function errorText(response: Response) {
  try {
    return (
      ((await response.json()) as { error?: string }).error ??
      `请求失败（${response.status}）`
    );
  } catch {
    return `请求失败（${response.status}）`;
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const lifecycleLabels: Record<SourceLifecycleStatus, string> = {
  draft: '待配置',
  connecting: '连接中',
  tested: '已测试',
  enabled: '运行中',
  degraded: '运行异常',
  paused: '已暂停',
  archived: '已归档',
};

const healthLabels: Record<SourceHealthStatus, string> = {
  unknown: '未检测',
  healthy: '正常',
  degraded: '异常',
  paused: '已暂停',
  waiting_capacity: '等待执行能力',
};

const rightsLabels: Record<SourceRightsStatus, string> = {
  pending: '待独立审批',
  approved: '已批准',
  revoked: '已撤销',
  expired: '已过期',
};

const runStatusLabels: Record<IngestionRunStatus, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '成功',
  partial: '部分成功',
  failed: '失败',
  cancelled: '已取消',
  rights_blocked: '权利阻断',
};

const quarantineLabels: Record<IngestionQuarantineStatus, string> = {
  none: '未隔离',
  held: '已挂起',
  released: '已释放',
  discarded: '已丢弃',
};

const rolloutLabels: Record<ConnectorReleaseMode, string> = {
  disabled: '停用',
  shadow: '影子运行',
  enabled: '启用',
};

const proposalLabels: Record<SourceProposal['status'], string> = {
  proposal_pending: '待审批',
  proposal_approved: '已批准建立来源',
  proposal_rejected: '已拒绝',
};

function SourcesHeader({ subtitle }: { subtitle: string }) {
  return <PageHeader icon={<DatabaseZap className="size-5" />} title="来源控制台" subtitle={subtitle} />;
}

function ProposalList({
  proposals,
  onDecision,
}: {
  proposals: SourceProposal[];
  onDecision?: (proposal: SourceProposal, decision: 'approve' | 'reject') => void;
}) {
  return (
    <div className="grid gap-3">
      {proposals.length ? proposals.map((proposal) => (
        <article key={proposal.id} className="rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{proposal.name}</h3>
            <Badge variant={proposal.status === 'proposal_rejected' ? 'destructive' : 'secondary'}>
              {proposalLabels[proposal.status]}
            </Badge>
          </div>
          <p className="mt-2 break-all text-sm text-muted-foreground">
            {proposal.discoveryMode === 'opencli'
              ? `OpenCLI 搜索：${proposal.accountName}`
              : proposal.url}
          </p>
          <p className="mt-2 text-sm">{proposal.requestNote}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            发起人 {proposal.requestedBy} · {new Date(proposal.createdAt).toLocaleString('zh-CN')}
          </p>
          {proposal.decisionNote && <p className="mt-2 text-xs">审批说明：{proposal.decisionNote}</p>}
          {proposal.sourceConfigId && <p className="mt-2 font-mono text-xs">已创建 {proposal.sourceConfigId}</p>}
          {onDecision && proposal.status === 'proposal_pending' && (
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => onDecision(proposal, 'approve')}>批准建立 draft</Button>
              <Button size="sm" variant="destructive" onClick={() => onDecision(proposal, 'reject')}>拒绝</Button>
            </div>
          )}
        </article>
      )) : <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">暂无来源提案。</p>}
    </div>
  );
}

function ReadOnlySourceList({ sources }: { sources: SourceRow[] }) {
  return (
    <div className="grid gap-3">
      {sources.length ? sources.map((source) => (
        <article key={source.id} className="rounded-xl border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{source.name}</h3>
            <Badge variant="secondary">{source.platform}</Badge>
            <Badge variant={source.enabled ? 'default' : 'outline'}>{lifecycleLabels[source.lifecycleStatus]}</Badge>
          </div>
          <p className="mt-2 break-all text-sm text-muted-foreground">
            {source.publicConfig.discoveryMode === 'opencli'
              ? `OpenCLI 搜索：${source.publicConfig.accountName}`
              : source.publicConfig.url}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            健康 {healthLabels[source.healthStatus]} · 权利 {rightsLabels[source.rightsStatus]} · 调度 {source.scheduleCron || '手动'}
          </p>
        </article>
      )) : <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">暂无可查看的来源。</p>}
    </div>
  );
}

function SourceProposalWorkspace() {
  const [proposals, setProposals] = useState<SourceProposal[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [discoveryMode, setDiscoveryMode] = useState<'opencli' | 'rss'>('opencli');
  const [accountName, setAccountName] = useState('');
  const [platform, setPlatform] = useState<'rss' | 'http_json' | 'web_page' | 'wechat' | 'xiaohongshu'>('rss');
  const [sourceType, setSourceType] = useState<SourceProposal['sourceType']>('media');
  const [scheduleCron, setScheduleCron] = useState('0 */2 * * *');
  const [requestNote, setRequestNote] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const [proposalResponse, sourceResponse] = await Promise.all([
      fetch('/api/v1/source-proposals', { cache: 'no-store' }),
      fetch('/api/v1/source-configs', { cache: 'no-store' }),
    ]);
    if (!proposalResponse.ok) throw new Error(await errorText(proposalResponse));
    if (!sourceResponse.ok) throw new Error(await errorText(sourceResponse));
    setProposals(((await proposalResponse.json()) as { proposals: SourceProposal[] }).proposals);
    setSources(((await sourceResponse.json()) as { sources: SourceRow[] }).sources);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : '读取失败。'),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  const submit = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/source-proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `proposal:${platform}:${discoveryMode}:${accountName || url}` },
        body: JSON.stringify({
          name,
          url: (platform === 'wechat' || platform === 'xiaohongshu') && discoveryMode === 'opencli' ? undefined : url,
          platform,
          adapter: platform === 'http_json' ? 'http' : platform === 'web_page' ? 'web' : platform === 'wechat' || platform === 'xiaohongshu' ? 'social' : 'rss',
          discoveryMode: platform === 'wechat' || platform === 'xiaohongshu' ? discoveryMode : undefined,
          accountName: platform === 'wechat' || platform === 'xiaohongshu' ? accountName : undefined,
          searchLimit: platform === 'wechat' ? 10 : platform === 'xiaohongshu' ? 20 : undefined,
          sourceType,
          scheduleCron: scheduleCron || null,
          requestNote,
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      setName('');
      setUrl('');
      setAccountName('');
      setRequestNote('');
      await refresh();
      setMessage('提案已提交；需由不同管理员审批后才会建立待配置来源。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提案提交失败。');
    } finally { setBusy(false); }
  };
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SourcesHeader subtitle="提案来源，由管理员独立审批" />
      <PageContainer className="grid gap-6 py-6 lg:grid-cols-[360px_1fr]">
        <section className="h-fit rounded-2xl border bg-card p-5">
          <h2 className="text-lg font-semibold tracking-tight">提案新来源</h2>
          <p className="mt-2 text-sm text-muted-foreground">这里只提交建议，不会自动授权或启用采集。</p>
          <div className="mt-5 grid gap-4">
            <div className="grid gap-2"><Label htmlFor="proposal-name">来源名称</Label><Input id="proposal-name" value={name} onChange={(event) => setName(event.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="proposal-platform">来源类型</Label><NativeSelect id="proposal-platform" value={platform} onChange={(event) => { const value = event.target.value as typeof platform; setPlatform(value); if (value === 'wechat' || value === 'xiaohongshu') setSourceType('social'); }}><NativeSelectOption value="rss">RSS / Atom</NativeSelectOption><NativeSelectOption value="http_json">Public JSON</NativeSelectOption><NativeSelectOption value="web_page">公开网页 / 热榜</NativeSelectOption><NativeSelectOption value="wechat">微信公众号监控</NativeSelectOption><NativeSelectOption value="xiaohongshu">小红书监控</NativeSelectOption></NativeSelect></div>
            {(platform === 'wechat' || platform === 'xiaohongshu') && <div className="grid gap-2"><Label htmlFor="proposal-discovery">发现方式</Label><NativeSelect id="proposal-discovery" value={discoveryMode} onChange={(event) => setDiscoveryMode(event.target.value as 'opencli' | 'rss')}><NativeSelectOption value="opencli">OpenCLI 按账号搜索</NativeSelectOption><NativeSelectOption value="rss">第三方 RSS / RSSHub</NativeSelectOption></NativeSelect></div>}
            {(platform === 'wechat' || platform === 'xiaohongshu') && discoveryMode === 'opencli' ? <div className="grid gap-2"><Label htmlFor="proposal-account">账号名称</Label><Input id="proposal-account" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder={platform === 'wechat' ? '例如：聚大模型前言' : '小红书账号名称'} /></div> : <div className="grid gap-2"><Label htmlFor="proposal-url">公网 URL</Label><Input id="proposal-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={platform === 'wechat' || platform === 'xiaohongshu' ? '第三方 RSSHub / Feed URL' : undefined} /></div>}
            <div className="grid gap-2"><Label htmlFor="proposal-source-type">内容类型</Label><NativeSelect id="proposal-source-type" value={sourceType} onChange={(event) => setSourceType(event.target.value as SourceProposal['sourceType'])}>{['social', 'media', 'market', 'filing', 'company'].map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></div>
            <div className="grid gap-2"><Label htmlFor="proposal-cron">建议频率</Label><Input id="proposal-cron" value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} /></div>
            <div className="grid gap-2"><Label htmlFor="proposal-note">业务理由（至少 10 字）</Label><Textarea id="proposal-note" value={requestNote} onChange={(event) => setRequestNote(event.target.value)} /></div>
            <Button disabled={busy || !name.trim() || ((platform === 'wechat' || platform === 'xiaohongshu') && discoveryMode === 'opencli' ? !accountName.trim() : !url.trim()) || requestNote.trim().length < 10} onClick={() => void submit()}>{busy ? <LoaderCircle className="animate-spin" /> : <ListPlus />}提交提案</Button>
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
          </div>
        </section>
        <div className="grid gap-6">
          <section className="rounded-2xl border bg-card p-5"><h2 className="mb-4 text-lg font-semibold tracking-tight">我的提案</h2><ProposalList proposals={proposals} /></section>
          <section className="rounded-2xl border bg-card p-5"><h2 className="mb-4 text-lg font-semibold tracking-tight">已登记来源（只读）</h2><ReadOnlySourceList sources={sources} /></section>
        </div>
      </PageContainer>
    </main>
  );
}

function SourceReadOnlyWorkspace({ includeProposals }: { includeProposals: boolean }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [proposals, setProposals] = useState<SourceProposal[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([
        fetch('/api/v1/source-configs', { cache: 'no-store' }),
        includeProposals ? fetch('/api/v1/source-proposals', { cache: 'no-store' }) : null,
      ]).then(async ([sourceResponse, proposalResponse]) => {
        if (!sourceResponse.ok) throw new Error(await errorText(sourceResponse));
        setSources(((await sourceResponse.json()) as { sources: SourceRow[] }).sources);
        if (proposalResponse) {
          if (!proposalResponse.ok) throw new Error(await errorText(proposalResponse));
          setProposals(((await proposalResponse.json()) as { proposals: SourceProposal[] }).proposals);
        }
      }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : '读取失败。'));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [includeProposals]);
  return (
    <main className="min-h-screen bg-background text-foreground">
      <SourcesHeader subtitle="只读来源与治理记录" />
      <PageContainer className="grid gap-6 py-6">
        {message && <p className="rounded-xl border border-destructive/30 p-4 text-sm">{message}</p>}
        <section className="rounded-2xl border bg-card p-5"><h2 className="mb-4 text-lg font-semibold tracking-tight">已登记来源</h2><ReadOnlySourceList sources={sources} /></section>
        {includeProposals && <section className="rounded-2xl border bg-card p-5"><h2 className="mb-4 text-lg font-semibold tracking-tight">来源提案审计</h2><ProposalList proposals={proposals} /></section>}
      </PageContainer>
    </main>
  );
}

function SourceProposalInbox() {
  const [proposals, setProposals] = useState<SourceProposal[]>([]);
  const [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    const response = await fetch('/api/v1/source-proposals', { cache: 'no-store' });
    if (!response.ok) throw new Error(await errorText(response));
    setProposals(((await response.json()) as { proposals: SourceProposal[] }).proposals);
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  const decide = async (proposal: SourceProposal, decision: 'approve' | 'reject') => {
    const note = window.prompt(decision === 'approve' ? '请填写独立审批说明（至少 10 字）' : '请填写拒绝理由（至少 10 字）')?.trim();
    if (!note || note.length < 10) return;
    const response = await fetch(`/api/v1/source-proposals/${encodeURIComponent(proposal.id)}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `proposal-decision:${proposal.id}:${decision}` },
      body: JSON.stringify({ decision, note }),
    });
    if (!response.ok) setMessage(await errorText(response));
    else { setMessage(decision === 'approve' ? '已建立 rights=pending 的 draft，仍需独立确认权利并测试。' : '提案已拒绝。'); await refresh(); }
  };
  const pending = proposals.filter((proposal) => proposal.status === 'proposal_pending');
  return (
    <PageContainer className="pt-6">
      <section className="rounded-2xl border bg-card p-5">
        <div className="mb-4"><h2 className="text-lg font-semibold tracking-tight">待审来源提案</h2><p className="text-xs text-muted-foreground">批准只创建待配置 draft，不代表权利已批准。</p></div>
        <ProposalList proposals={pending} onDecision={(proposal, decision) => void decide(proposal, decision)} />
        {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
      </section>
    </PageContainer>
  );
}

export function SourceManager() {
  const session = useSession();
  if (session.loading) return <main className="grid min-h-screen place-items-center"><LoaderCircle className="animate-spin" /></main>;
  if (!session.actor) return <main className="grid min-h-screen place-items-center p-6 text-center">{session.error || '无法识别当前身份。'}</main>;
  if (['researcher', 'editor'].includes(session.actor.role)) return <SourceProposalWorkspace />;
  if (session.actor.role === 'admin') return <AdminSourceManager actor={session.actor} />;
  return <SourceReadOnlyWorkspace includeProposals={session.actor.role === 'auditor'} />;
}

function AdminSourceManager({ actor }: { actor: { id: string; email: string; canManageSourceLegal?: boolean } }) {
  const adminHeaders = useCallback(
    () => devIdentityHeaders({ role: 'admin', id: actor.id, email: actor.email }),
    [actor.email, actor.id],
  );
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [connectors, setConnectors] = useState<ConnectorRelease[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [businessOwnerId, setBusinessOwnerId] = useState('');
  const [ownershipDrafts, setOwnershipDrafts] = useState<
    Record<string, OwnershipDraft>
  >({});
  const [rightsDrafts, setRightsDrafts] = useState<Record<string, {
    principal: string;
    sourceType: 'social' | 'media' | 'market' | 'filing' | 'company';
    territory: string;
    evidenceRef: string;
    evidenceSnapshot: string;
    termsVersion: string;
    termsSnapshot: string;
    expiresAt: string;
  }>>({});
  const [runsBySource, setRunsBySource] = useState<
    Record<string, IngestionRun[]>
  >({});
  const [sloExclusionsBySource, setSloExclusionsBySource] = useState<
    Record<string, SourceSloExclusion[]>
  >({});
  const [legalHoldsBySource, setLegalHoldsBySource] = useState<
    Record<string, SourceLegalHold[]>
  >({});
  const [maintenanceDrafts, setMaintenanceDrafts] = useState<
    Record<string, MaintenanceDraft>
  >({});
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [discoveryMode, setDiscoveryMode] = useState<'opencli' | 'rss'>('opencli');
  const [accountName, setAccountName] = useState('');
  const [searchLimit, setSearchLimit] = useState('20');
  const [platform, setPlatform] = useState<'rss' | 'http_json' | 'web_page' | 'wechat' | 'xiaohongshu'>('rss');
  const [sourceType, setSourceType] = useState('media');
  const [publisherEntityId, setPublisherEntityId] = useState('');
  const [cron, setCron] = useState('0 */2 * * *');
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [itemsPath, setItemsPath] = useState('items');
  const [idPath, setIdPath] = useState('id');
  const [titlePath, setTitlePath] = useState('title');
  const [urlPath, setUrlPath] = useState('url');
  const [publishedAtPath, setPublishedAtPath] = useState('publishedAt');
  const [updatedAtPath, setUpdatedAtPath] = useState('updatedAt');
  const [kindPath, setKindPath] = useState('kind');
  const [deletedAtPath, setDeletedAtPath] = useState('deletedAt');
  const [summaryPath, setSummaryPath] = useState('summary');
  const [authorPath, setAuthorPath] = useState('author');
  const [paginationMode, setPaginationMode] = useState<
    'none' | 'page' | 'cursor' | 'since'
  >('none');
  const [maxPages, setMaxPages] = useState('10');
  const [pageParameter, setPageParameter] = useState('page');
  const [startPage, setStartPage] = useState('1');
  const [pageSizeParameter, setPageSizeParameter] = useState('limit');
  const [pageSize, setPageSize] = useState('100');
  const [cursorParameter, setCursorParameter] = useState('cursor');
  const [cursorPath, setCursorPath] = useState('meta.nextCursor');
  const [sinceParameter, setSinceParameter] = useState('since');
  const [hasMorePath, setHasMorePath] = useState('');
  const [rateLimit, setRateLimit] = useState('30');
  const [costPerRequestUsd, setCostPerRequestUsd] = useState('0');
  const [estimatedRequestsPerRun, setEstimatedRequestsPerRun] = useState('1');
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState('0');
  const [budgetSoftLimitPercent, setBudgetSoftLimitPercent] = useState('80');
  const [schedulePriority, setSchedulePriority] = useState('50');
  const [autoThrottleEnabled, setAutoThrottleEnabled] = useState(true);
  const [retentionMode, setRetentionMode] = useState<'metadata' | 'raw'>(
    'metadata',
  );
  const [retentionDays, setRetentionDays] = useState('30');
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [bulkContent, setBulkContent] = useState('');
  const [bulkCandidates, setBulkCandidates] = useState<SourceImportCandidate[]>(
    [],
  );
  const [bulkIssues, setBulkIssues] = useState<SourceImportIssue[]>([]);
  const [pendingSourceId, setPendingSourceId] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewItem[]>([]);
  const [message, setMessage] = useState('读取来源配置…');
  const [busy, setBusy] = useState(false);
  const runSequence = useRef(0);

  const refresh = useCallback(async () => {
    const [
      sourceResponse,
      workerResponse,
      connectorResponse,
      memberResponse,
    ] = await Promise.all([
      fetch('/api/v1/source-configs', {
        cache: 'no-store',
        headers: adminHeaders(),
      }),
      fetch('/api/v1/workers', { cache: 'no-store', headers: adminHeaders() }),
      fetch('/api/v1/source-connectors', {
        cache: 'no-store',
        headers: adminHeaders(),
      }),
      fetch('/api/v1/team-members', {
        cache: 'no-store',
        headers: adminHeaders(),
      }),
    ]);
    if (!sourceResponse.ok) throw new Error(await errorText(sourceResponse));
    const sourcePayload = (await sourceResponse.json()) as {
      sources: SourceRow[];
    };
    setSources(sourcePayload.sources);
    if (workerResponse.ok)
      setWorkers(
        ((await workerResponse.json()) as { workers: WorkerRow[] }).workers,
      );
    if (connectorResponse.ok)
      setConnectors(
        ((await connectorResponse.json()) as { connectors: ConnectorRelease[] })
          .connectors,
      );
    if (memberResponse.ok) {
      const nextMembers = (
        (await memberResponse.json()) as { members: TeamMember[] }
      ).members;
      setMembers(nextMembers);
      const activeOwners = nextMembers.filter(
        (member) => member.status === 'active' && member.role !== 'auditor',
      );
      setBusinessOwnerId((current) => current || activeOwners[0]?.user_id || '');
    }
    setMessage(
      sourcePayload.sources.length
        ? `已登记 ${sourcePayload.sources.length} 个来源。`
        : '尚未登记自动来源。',
    );
  }, [adminHeaders]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh().catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : '读取失败。'),
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const onlineCapabilities = useMemo(
    () =>
      new Set(
        workers
          .filter((worker) => worker.online)
          .flatMap((worker) => worker.capabilities),
      ),
    [workers],
  );
  const selectedConnector = useMemo(
    () => connectors.find((connector) => connector.platform === platform),
    [connectors, platform],
  );
  const activeOwnerMembers = useMemo(
    () =>
      members.filter(
        (member) => member.status === 'active' && member.role !== 'auditor',
      ),
    [members],
  );
  const activeAdmins = useMemo(
    () =>
      members.filter(
        (member) => member.status === 'active' && member.role === 'admin',
      ),
    [members],
  );
  const canApproveRights = useMemo(
    () => members.some((member) =>
      member.user_id === actor.id && member.role === 'admin' && member.status === 'active' && Boolean(member.can_approve_source_rights),
    ),
    [actor.id, members],
  );
  const pendingSource = useMemo(
    () => sources.find((source) => source.id === pendingSourceId) ?? null,
    [pendingSourceId, sources],
  );
  const memberLabel = useCallback(
    (id: string | null) =>
      members.find((member) => member.user_id === id)?.email ?? id ?? '未分配',
    [members],
  );

  const waitForTest = async (sourceId: string, testId: string) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(sourceId)}/tests/${encodeURIComponent(testId)}`,
        { cache: 'no-store', headers: adminHeaders() },
      );
      if (!response.ok) throw new Error(await errorText(response));
      const payload = (await response.json()) as {
        test: {
          status: string;
          preview: PreviewItem[];
          error_detail_redacted?: string;
        };
      };
      if (payload.test.status === 'succeeded') {
        setPreview(payload.test.preview);
        setStep(3);
        await refresh();
        setMessage('连接测试通过。请核对最近内容；独立权利审批完成后才能启用来源。');
        return;
      }
      if (payload.test.status === 'failed')
        throw new Error(payload.test.error_detail_redacted || '连接测试失败。');
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
    setMessage(
      '测试仍在排队。请确认采集 Worker 在线，稍后可在来源卡片重新测试。',
    );
  };

  const testSource = async (sourceId: string) => {
    setBusy(true);
    setPendingSourceId(sourceId);
    setPreview([]);
    setStep(2);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(sourceId)}/tests`,
        {
          method: 'POST',
          headers: {
            'idempotency-key': `test:${sourceId}:${crypto.randomUUID()}`,
            ...adminHeaders(),
          },
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      const payload = (await response.json()) as { testId: string };
      setMessage('已交给受限采集 Worker 测试，正在等待预览…');
      await waitForTest(sourceId, payload.testId);
    } catch (error) {
      setStep(1);
      setMessage(error instanceof Error ? error.message : '连接测试失败。');
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const createSource = async () => {
    setBusy(true);
    try {
      const adapter = selectedConnector?.adapter;
      if (!adapter) throw new Error('连接器未加载。');
      const mapping =
        platform === 'http_json'
          ? {
              items: itemsPath,
              id: idPath,
              title: titlePath,
              url: urlPath,
              publishedAt: publishedAtPath,
              updatedAt: updatedAtPath,
              kind: kindPath,
              deletedAt: deletedAtPath,
              summary: summaryPath,
              author: authorPath,
            }
          : undefined;
      const pagination =
        platform === 'http_json'
          ? {
              mode: paginationMode,
              maxPages: Number(maxPages),
              pageParameter,
              startPage: Number(startPage),
              pageSizeParameter,
              pageSize: Number(pageSize),
              cursorParameter,
              cursorPath:
                paginationMode === 'cursor' ||
                (paginationMode === 'since' && cursorPath)
                  ? cursorPath
                  : undefined,
              sinceParameter,
              hasMorePath: hasMorePath || undefined,
            }
          : undefined;
      const response = await fetch('/api/v1/source-configs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `source:${platform}:${discoveryMode}:${accountName || url}`,
          ...adminHeaders(),
        },
        body: JSON.stringify({
          name,
          adapter,
          platform,
          sourceType,
          url: (platform === 'wechat' || platform === 'xiaohongshu') && discoveryMode === 'opencli' ? undefined : url,
          discoveryMode: platform === 'wechat' || platform === 'xiaohongshu' ? discoveryMode : undefined,
          accountName: platform === 'wechat' || platform === 'xiaohongshu' ? accountName : undefined,
          searchLimit: platform === 'wechat' || platform === 'xiaohongshu' ? Number(searchLimit) : undefined,
          mapping,
          pagination,
          scheduleCron: cron || null,
          rightsStatus: 'pending',
          publicUseConfirmed: rightsConfirmed,
          rateLimitPerMinute: Number(rateLimit),
          billingPolicy: {
            costMicrosPerRequest: Math.round(
              Number(costPerRequestUsd) * 1_000_000,
            ),
            estimatedRequestsPerRun: Number(estimatedRequestsPerRun),
            monthlyBudgetMicros: Math.round(
              Number(monthlyBudgetUsd) * 1_000_000,
            ),
            softLimitPercent: Number(budgetSoftLimitPercent),
          },
          schedulePolicy: {
            schedulePriority: Number(schedulePriority),
            autoThrottleEnabled,
          },
          businessOwnerId,
          publisherEntityId: publisherEntityId || null,
          retention: { mode: retentionMode, days: Number(retentionDays) },
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const payload = (await response.json()) as {
        source?: { id: string; version?: number };
        sourceId?: string;
      };
      const sourceId = payload.source?.id ?? payload.sourceId;
      if (!sourceId) throw new Error('来源已保存，但响应缺少来源 ID。');
      setPendingSourceId(sourceId);
      await refresh();
      await testSource(sourceId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建失败。');
      setBusy(false);
    }
  };

  const decideRights = async (source: SourceRow, decision: 'approve' | 'reject') => {
    if (!source.pendingRightsRequestId) return;
    let note: string;
    let dossier: Record<string, unknown> | undefined;
    if (decision === 'reject') {
      note = window.prompt('请输入拒绝理由（至少 10 字）：')?.trim() ?? '';
      if (note.length < 10) return;
    } else {
      const draft = rightsDrafts[source.id];
      if (!draft?.principal.trim() || !draft.evidenceRef.trim() || !draft.evidenceSnapshot.trim() ||
          !draft.termsVersion.trim() || !draft.termsSnapshot.trim()) {
        setMessage('批准前请填写权利主体、证据引用、证据快照、条款版本和条款快照。');
        return;
      }
      note = '已由独立权利审批者核对证据、条款快照、允许字段和保留范围。';
      dossier = {
        principal: draft.principal.trim(),
        sourceType: draft.sourceType,
        permittedFields: ['id', 'title', 'summary', 'url', 'publishedAt', 'updatedAt', 'author', 'kind', 'deletedAt'],
        territory: draft.territory.trim() || 'global',
        evidenceRef: draft.evidenceRef.trim(),
        evidenceSha256: await sha256Hex(draft.evidenceSnapshot),
        termsVersion: draft.termsVersion.trim(),
        termsSnapshotSha256: await sha256Hex(draft.termsSnapshot),
        grantedAt: new Date().toISOString(),
        expiresAt: draft.expiresAt ? new Date(`${draft.expiresAt}T23:59:59.000Z`).toISOString() : null,
      };
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/source-configs/${encodeURIComponent(source.id)}/rights`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `source-rights:${source.pendingRightsRequestId}:${decision}`,
          ...adminHeaders(),
        },
        body: JSON.stringify({
          requestId: source.pendingRightsRequestId,
          expectedSourceVersion: source.version,
          decision,
          note,
          dossier,
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      setMessage(decision === 'approve'
        ? `${source.name} 的权利证据已独立批准；连接测试仍有效时可以启用。`
        : `${source.name} 的权利请求已拒绝，来源保持停用。`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '权利决定失败。');
    } finally {
      setBusy(false);
    }
  };

  const resubmitRights = async (source: SourceRow) => {
    const assertionRef = window.prompt(
      '请输入非 HTTP 的证据记录引用，例如 legal-dossier:ticket-123：',
      `legal-dossier:${source.id}`,
    )?.trim();
    if (!assertionRef) return;
    const note = window.prompt('请输入重新提交原因（至少 10 字）：')?.trim() ?? '';
    if (note.length < 10) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/source-configs/${encodeURIComponent(source.id)}/rights`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `source-rights-request:${source.id}:${source.version}:${assertionRef}`,
          ...adminHeaders(),
        },
        body: JSON.stringify({ expectedSourceVersion: source.version, assertionRef, note }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      setMessage(`${source.name} 的新权利声明已提交，等待另一名权利审批者。`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '权利声明提交失败。');
    } finally {
      setBusy(false);
    }
  };

  const previewBulkImport = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/v1/source-configs/imports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...adminHeaders() },
        body: JSON.stringify({
          mode: 'preview',
          content: bulkContent,
          defaultPlatform: platform,
          defaultSourceType: sourceType,
          scheduleCron: cron || null,
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const payload = (await response.json()) as {
        candidates: Omit<SourceImportCandidate, 'confirmed'>[];
        issues: SourceImportIssue[];
        total: number;
      };
      setBulkCandidates(
        payload.candidates.map((candidate) => ({
          ...candidate,
          confirmed: false,
        })),
      );
      setBulkIssues(payload.issues);
      setMessage(
        `已解析 ${payload.total} 项：可接入 ${payload.candidates.length}，需修正 ${payload.issues.length}。请逐项提交 provisional 使用权声明。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批量内容解析失败。');
    } finally {
      setBusy(false);
    }
  };

  const commitBulkImport = async () => {
    const selected = bulkCandidates.filter((candidate) => candidate.confirmed);
    if (!selected.length) {
      setMessage('请至少为一个来源提交 provisional 使用权声明。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/v1/source-configs/imports', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `source-import:${crypto.randomUUID()}`,
          ...adminHeaders(),
        },
        body: JSON.stringify({
          mode: 'commit',
          candidates: selected.map(
            ({ confirmed: _confirmed, ...candidate }) => ({
              ...candidate,
              publicUseConfirmed: true,
            }),
          ),
        }),
      });
      if (!response.ok) throw new Error(await errorText(response));
      const payload = (await response.json()) as {
        created: unknown[];
        skipped: unknown[];
        requiresIndividualTestAndEnable: boolean;
      };
      setBulkContent('');
      setBulkCandidates([]);
      setBulkIssues([]);
      setShowBulkImport(false);
      await refresh();
      setMessage(
        `已创建 ${payload.created.length} 个 draft，跳过 ${payload.skipped.length} 个已存在来源；仍需逐来源测试并启用。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批量来源保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const enableSource = async (sourceId: string) => {
    const source = sources.find((item) => item.id === sourceId);
    if (!source) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/enable`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({ expectedVersion: source.version }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      setName('');
      setUrl('');
      setAccountName('');
      setPublisherEntityId('');
      setRightsConfirmed(false);
      setPreview([]);
      setPendingSourceId(null);
      setStep(1);
      await refresh();
      setMessage(
        `${source.name} 已启用；调度器会在有匹配 Worker 时持续增量采集。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '启用失败。');
    } finally {
      setBusy(false);
    }
  };

  const pauseSource = async (source: SourceRow) => {
    const pauseReason = window.prompt('请输入暂停原因（会进入 SLO 审计记录）：');
    if (pauseReason === null) return;
    if (pauseReason.trim().length < 3 || pauseReason.trim().length > 500) {
      setMessage('暂停原因必须为 3–500 个字符。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({
            expectedVersion: source.version,
            enabled: false,
            pauseReason: pauseReason.trim(),
            name: source.name,
            adapter: source.adapter,
            platform: source.platform,
            sourceType: source.publicConfig.sourceType,
            url: source.publicConfig.url,
            mapping: source.publicConfig.mapping,
            pagination: source.publicConfig.pagination,
            discoveryMode: source.publicConfig.discoveryMode,
            accountName: source.publicConfig.accountName,
            searchLimit: source.publicConfig.searchLimit,
            scheduleCron: source.scheduleCron,
            rightsStatus: source.rightsStatus,
            rateLimitPerMinute: source.rateLimitPerMinute,
            billingPolicy: {
              costMicrosPerRequest: source.costMicrosPerRequest,
              estimatedRequestsPerRun: source.estimatedRequestsPerRun,
              monthlyBudgetMicros: source.monthlyBudgetMicros,
              softLimitPercent: source.budgetSoftLimitPercent,
            },
            schedulePolicy: {
              schedulePriority: source.schedulePriority,
              autoThrottleEnabled: source.autoThrottleEnabled,
            },
            retention: {
              mode: source.retention.mode,
              days: source.retention.days,
            },
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      await refresh();
      setMessage(`${source.name} 已停用，既有数据与审计保留。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '停用来源失败。');
    } finally {
      setBusy(false);
    }
  };

  const transferOwnership = async (source: SourceRow) => {
    const draft = ownershipDrafts[source.id] ?? {
      businessOwnerId: source.businessOwnerId ?? '',
    };
    const reason = window
      .prompt(
        '请输入来源负责人变更原因（至少 5 个字）：',
        '调整来源维护责任人',
      )
      ?.trim();
    if (!reason) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/ownership`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({
            expectedVersion: source.version,
            businessOwnerId: draft.businessOwnerId,
            reason,
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      setOwnershipDrafts((current) => {
        const next = { ...current };
        delete next[source.id];
        return next;
      });
      await refresh();
      setMessage(`${source.name} 的负责人已转移并写入审计。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '负责人转移失败。');
    } finally {
      setBusy(false);
    }
  };

  const run = async (source: SourceRow) => {
    setBusy(true);
    try {
      runSequence.current += 1;
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/runs`,
        {
          method: 'POST',
          headers: {
            'idempotency-key': `manual:${source.id}:${Date.now()}:${runSequence.current}`,
            ...adminHeaders(),
          },
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      setMessage(`${source.name} 已进入后台采集队列。`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '触发失败。');
    } finally {
      setBusy(false);
    }
  };

  const loadRuns = async (sourceId: string) => {
    if (runsBySource[sourceId]) {
      setRunsBySource((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
      return;
    }
    const response = await fetch(
      `/api/v1/source-configs/${encodeURIComponent(sourceId)}/runs`,
      { cache: 'no-store', headers: adminHeaders() },
    );
    if (!response.ok) throw new Error(await errorText(response));
    const payload = (await response.json()) as { runs: IngestionRun[] };
    setRunsBySource((current) => ({
      ...current,
      [sourceId]: payload.runs.slice(0, 5),
    }));
  };

  const loadLegalHolds = async (sourceId: string, force = false) => {
    if (legalHoldsBySource[sourceId] && !force) {
      setLegalHoldsBySource((current) => {
        const next = { ...current };
        delete next[sourceId];
        return next;
      });
      return;
    }
    const response = await fetch(
      `/api/v1/source-configs/${encodeURIComponent(sourceId)}/legal-holds`,
      { cache: 'no-store', headers: adminHeaders() },
    );
    if (!response.ok) throw new Error(await errorText(response));
    const payload = (await response.json()) as { items: SourceLegalHold[] };
    setLegalHoldsBySource((current) => ({
      ...current,
      [sourceId]: payload.items,
    }));
  };

  const createLegalHold = async (source: SourceRow) => {
    const reason = window
      .prompt('请输入保全原因（至少 10 个字）：')
      ?.trim();
    if (!reason || reason.length < 10) {
      setMessage('保全原因至少需要 10 个字。');
      return;
    }
    const authorityRef = window
      .prompt('请输入法律依据、工单或案件引用：')
      ?.trim();
    if (!authorityRef) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/legal-holds`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({ reason, authorityRef }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      await loadLegalHolds(source.id, true);
      setMessage(`${source.name} 已进入法律保全；依法删除和相关发布任务将被阻断。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建法律保全失败。');
    } finally {
      setBusy(false);
    }
  };

  const releaseLegalHold = async (source: SourceRow, hold: SourceLegalHold) => {
    const reason = window
      .prompt('解除保全必须由另一名法律操作人执行。请输入解除原因（至少 10 个字）：')
      ?.trim();
    if (!reason || reason.length < 10) {
      setMessage('解除原因至少需要 10 个字。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/legal-holds/${encodeURIComponent(hold.id)}/release`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({ reason }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      await loadLegalHolds(source.id, true);
      setMessage(`${source.name} 的法律保全已由异人解除。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '解除法律保全失败。');
    } finally {
      setBusy(false);
    }
  };

  const loadSloExclusions = async (sourceId: string) => {
    const response = await fetch(
      `/api/v1/source-configs/${encodeURIComponent(sourceId)}/slo-exclusions`,
      { cache: 'no-store', headers: adminHeaders() },
    );
    if (!response.ok) throw new Error(await errorText(response));
    const payload = (await response.json()) as {
      exclusions: SourceSloExclusion[];
    };
    setSloExclusionsBySource((current) => ({
      ...current,
      [sourceId]: payload.exclusions,
    }));
  };

  const scheduleMaintenance = async (source: SourceRow) => {
    const draft = maintenanceDrafts[source.id];
    const startsAt = draft?.startsAt ? new Date(draft.startsAt) : null;
    const endsAt = draft?.endsAt ? new Date(draft.endsAt) : null;
    if (
      !startsAt || Number.isNaN(startsAt.valueOf()) ||
      !endsAt || Number.isNaN(endsAt.valueOf()) ||
      !draft?.reason.trim()
    ) {
      setMessage('请填写有效的维护开始、结束时间和原因。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/slo-exclusions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            reason: draft.reason.trim(),
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      setMaintenanceDrafts((current) => ({
        ...current,
        [source.id]: { startsAt: '', endsAt: '', reason: '' },
      }));
      await loadSloExclusions(source.id);
      setMessage(`${source.name} 的计划维护窗口已登记并进入 SLO 审计。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '计划维护登记失败。');
    } finally {
      setBusy(false);
    }
  };

  const cancelMaintenance = async (
    source: SourceRow,
    exclusion: SourceSloExclusion,
  ) => {
    const reason = window.prompt('请填写取消计划维护的原因（至少 3 个字）：')?.trim();
    if (!reason) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/slo-exclusions`,
        {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({ exclusionId: exclusion.id, reason }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      await loadSloExclusions(source.id);
      setMessage(`${source.name} 的计划维护已撤销；原记录仍保留供审计。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '计划维护撤销失败。');
    } finally {
      setBusy(false);
    }
  };

  const changeRunQuarantine = async (
    sourceId: string,
    run: IngestionRun,
    action: 'hold' | 'release' | 'discard',
  ) => {
    const note = window
      .prompt(
        `${action === 'hold' ? '挂起' : action === 'release' ? '释放' : '永久丢弃'}批次 ${run.id}\n请输入审计说明：`,
        action === 'hold'
          ? '人工复核该采集批次'
          : action === 'release'
            ? '复核通过，恢复参与主题计算'
            : '确认该批次不可继续使用',
      )
      ?.trim();
    if (!note) return;
    if (
      action === 'discard' &&
      !window.confirm(
        '丢弃不可恢复，并会让 raw payload 立即进入删除队列。确认继续？',
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/ingestion-runs/${encodeURIComponent(run.id)}/quarantine`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `quarantine:${run.id}:${action}:${crypto.randomUUID()}`,
            ...adminHeaders(),
          },
          body: JSON.stringify({ action, note }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      const runsResponse = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(sourceId)}/runs`,
        { cache: 'no-store', headers: adminHeaders() },
      );
      if (runsResponse.ok) {
        const runsPayload = (await runsResponse.json()) as {
          runs: IngestionRun[];
        };
        setRunsBySource((current) => ({
          ...current,
          [sourceId]: runsPayload.runs.slice(0, 5),
        }));
      }
      setMessage(
        `批次 ${run.id} 已${action === 'hold' ? '挂起' : action === 'release' ? '释放' : '丢弃'}；主题重算已入队。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '批次隔离操作失败。');
    } finally {
      setBusy(false);
    }
  };

  const backfill = async (source: SourceRow) => {
    setBusy(true);
    try {
      const to = new Date();
      const from = new Date(to.valueOf() - 7 * 24 * 60 * 60 * 1000);
      const requestBody = {
        from: from.toISOString(),
        to: to.toISOString(),
        maxItems: 100,
      };
      const estimateResponse = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/backfills/estimates`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify(requestBody),
        },
      );
      if (!estimateResponse.ok) throw new Error(await errorText(estimateResponse));
      const { estimate } = (await estimateResponse.json()) as {
        estimate: SourceBackfillEstimate;
      };
      const cost =
        estimate.costMode === 'modeled'
          ? `$${(estimate.estimatedCostMicros / 1_000_000).toFixed(4)}`
          : '成本尚未建模';
      if (
        !window.confirm(
          `确认补采「${source.name}」最近 ${estimate.lookbackDays} 天？\n\n预计最多 ${estimate.itemUpperBound} 条、约 ${estimate.estimatedRequests} 个请求、${cost}、约 ${estimate.estimatedDurationSeconds} 秒。该估算是上界规划值，不保证上游实际有这些内容。`,
        )
      ) {
        setMessage('已取消补采，未创建运行。');
        return;
      }
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/backfills`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `backfill:${source.id}:${from.toISOString()}:${to.toISOString()}`,
            ...adminHeaders(),
          },
          body: JSON.stringify({
            ...requestBody,
            confirmed: true,
            confirmationHash: estimate.confirmationHash,
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      setMessage(
        `${source.name} 已创建近 7 天有界补采，不会覆盖实时 checkpoint。`,
      );
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '补采创建失败。');
    } finally {
      setBusy(false);
    }
  };

  const archive = async (source: SourceRow) => {
    if (
      !window.confirm(
        `确认归档「${source.name}」？它将从日常列表隐藏，但保留审计记录。`,
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/archive`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({
            expectedVersion: source.version,
            reason: '管理员在来源控制台归档',
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      await refresh();
      setMessage(`${source.name} 已归档，未开始的采集作业已取消。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '归档失败。');
    } finally {
      setBusy(false);
    }
  };

  const withdrawContent = async (source: SourceRow) => {
    if (
      !window.confirm(
        `撤回「${source.name}」的权利和已采集内容？\n\n系统会停止采集、取消未开始作业、从活动语料中撤回 origin 并重算主题。再次使用需重新建立权利记录。`,
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/content-withdrawals`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `withdraw:${source.id}:${crypto.randomUUID()}`,
            ...adminHeaders(),
          },
          body: JSON.stringify({
            expectedVersion: source.version,
            reason: '管理员在来源控制台撤回权利与内容',
            mode: 'withdraw',
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      await refresh();
      setMessage(`${source.name} 已停用并撤回活动内容，主题重算已入队。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '内容撤回失败。');
    } finally {
      setBusy(false);
    }
  };

  const legallyDeleteSource = async (source: SourceRow) => {
    const reason = window
      .prompt(
        `依法删除会清除可删除的原始载荷、独占规范化正文和派生项目；已发布内容必须等待平台撤回回执。Legal hold 存在时不会执行。\n\n请输入删除依据或工单号：`,
      )
      ?.trim();
    if (!reason) return;
    const confirmation = window
      .prompt(`这是不可逆操作。请输入来源名称“${source.name}”确认：`)
      ?.trim();
    if (confirmation !== source.name) {
      setMessage('名称不匹配，未创建依法删除请求。');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-configs/${encodeURIComponent(source.id)}/content-withdrawals`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `legal-delete:${source.id}:${crypto.randomUUID()}`,
            ...adminHeaders(),
          },
          body: JSON.stringify({
            expectedVersion: source.version,
            reason,
            mode: 'legal_delete',
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      const result = (await response.json()) as {
        deletionRequestId: string;
        deletionStatus: string;
      };
      await refresh();
      setMessage(
        `依法删除请求 ${result.deletionRequestId} 已创建（${result.deletionStatus}）。这不代表外部内容已删除；完成后才会生成回执哈希。`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '依法删除请求失败。');
    } finally {
      setBusy(false);
    }
  };

  const setConnectorMode = async (
    connector: ConnectorRelease,
    rolloutMode: ConnectorRelease['rolloutMode'],
    canary?: { enabled: boolean; percent: number; failureRateBps: number; minRuns: number },
  ) => {
    const reason = window
      .prompt(
        `${connector.label} ${connector.id}@${connector.version} 将切换为 ${rolloutMode}。\n请输入变更原因：`,
        rolloutMode === 'disabled'
          ? '紧急停用连接器版本'
          : rolloutMode === 'shadow'
            ? '进入 shadow 观察'
            : '完成检查后恢复正式运行',
      )
      ?.trim();
    if (!reason) return;
    if (
      rolloutMode === 'disabled' &&
      !window.confirm(
        '停用会取消未领取作业并暂停使用该连接器的来源；恢复后需重新测试并启用。确认继续？',
      )
    )
      return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/v1/source-connectors/${encodeURIComponent(connector.id)}/versions/${encodeURIComponent(connector.version)}/control`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...adminHeaders() },
          body: JSON.stringify({
            rolloutMode,
            expectedVersion: connector.rolloutVersion,
            reason,
            ...(canary ? { canary } : {}),
          }),
        },
      );
      if (!response.ok) throw new Error(await errorText(response));
      await refresh();
      setMessage(
        canary?.enabled
          ? `${connector.label} 已开始 ${canary.percent}% 稳定分桶灰度；失败率达到 ${(canary.failureRateBps / 100).toFixed(2)}% 且至少 ${canary.minRuns} 次运行时自动停用。`
          : `${connector.label} 已切换为 ${rolloutMode}。`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : '连接器发布控制更新失败。',
      );
    } finally {
      setBusy(false);
    }
  };

  const startConnectorCanary = (connector: ConnectorRelease) => {
    const percent = Number(window.prompt('灰度来源比例（1–100）：', String(connector.canaryPercent || 10)));
    const failurePercent = Number(window.prompt('自动停止失败率（0.01–100%）：', String((connector.canaryFailureRateBps || 2000) / 100)));
    const minRuns = Number(window.prompt('达到阈值前的最小运行数（1–10000）：', String(connector.canaryMinRuns || 20)));
    const failureRateBps = Math.round(failurePercent * 100);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100 || !Number.isInteger(failureRateBps) || failureRateBps < 1 || failureRateBps > 10_000 || !Number.isInteger(minRuns) || minRuns < 1 || minRuns > 10_000) {
      setMessage('灰度参数无效：比例 1–100，失败率 0.01–100%，最小运行数 1–10000。');
      return;
    }
    void setConnectorMode(connector, 'enabled', { enabled: true, percent, failureRateBps, minRuns });
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <PageHeader icon={<DatabaseZap className="size-5" />} title="来源控制台" subtitle="一次接入，持续采集" />
      <SourceProposalInbox />
      <PageContainer className="grid gap-6 py-6 lg:grid-cols-[380px_1fr]">
        <section className="h-fit rounded-2xl border bg-card p-5">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-chart-1">
            Step {step} / 3
          </p>
          <h2 className="mt-2 text-lg font-semibold tracking-tight">
            {step === 1 ? '粘贴来源' : step === 2 ? '识别与测试' : '确认并启用'}
          </h2>
          {step === 1 && (
            <div className="mt-5 grid gap-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowBulkImport((value) => !value);
                  setBulkCandidates([]);
                  setBulkIssues([]);
                }}
              >
                <ListPlus />
                {showBulkImport ? '返回单个接入' : '批量接入来源'}
              </Button>
              {showBulkImport ? (
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="source-bulk-content">
                      OPML、来源 CSV、JSON 或逐行 URL
                    </Label>
                    <Textarea
                      id="source-bulk-content"
                      className="min-h-40 font-mono text-xs"
                      value={bulkContent}
                      onChange={(event) => {
                        setBulkContent(event.target.value);
                        setBulkCandidates([]);
                        setBulkIssues([]);
                      }}
                      placeholder={
                        'https://example.com/feed.xml\n公司公告\thttps://example.com/announcements.xml'
                      }
                    />
                  </div>
                  {!bulkCandidates.length && (
                    <Button
                      onClick={() => void previewBulkImport()}
                      disabled={busy || !bulkContent.trim()}
                    >
                      {busy ? (
                        <LoaderCircle className="animate-spin" />
                      ) : (
                        <TestTube2 />
                      )}
                      解析并预览
                    </Button>
                  )}
                  {bulkIssues.length > 0 && (
                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">
                      <p className="font-medium">需要修正</p>
                      {bulkIssues.map((issue) => (
                        <p
                          key={`${issue.row}:${issue.message}`}
                          className="mt-1"
                        >
                          第 {issue.row} 行：{issue.message}
                        </p>
                      ))}
                    </div>
                  )}
                  {bulkCandidates.length > 0 && (
                    <div className="grid gap-2">
                      <p className="text-xs text-muted-foreground">
                        逐项声明后只创建 rights=pending draft；每个来源仍需独立权利审批、测试和启用。
                      </p>
                      {bulkCandidates.map((candidate) => {
                        const checkboxId = `source-import-rights-${candidate.row}`;
                        return (
                          <label
                            htmlFor={checkboxId}
                            key={`${candidate.row}:${candidate.url}`}
                            className="flex items-start gap-3 rounded-lg border p-3 text-sm"
                          >
                            <Checkbox
                              id={checkboxId}
                              checked={candidate.confirmed}
                              onCheckedChange={(checked) =>
                                setBulkCandidates((current) =>
                                  current.map((item) =>
                                    item.row === candidate.row
                                      ? { ...item, confirmed: checked }
                                      : item,
                                  ),
                                )
                              }
                            />
                            <span className="min-w-0">
                              <span className="block font-medium">
                                {candidate.name} · {candidate.platform}
                              </span>
                              <span className="block break-all text-xs text-muted-foreground">
                                {candidate.url}
                              </span>
                              <span className="mt-1 block text-xs">
                                我提交 provisional 使用权声明（不会自动批准）。
                              </span>
                            </span>
                          </label>
                        );
                      })}
                      <div className="flex gap-2">
                        <Button
                          onClick={() => void commitBulkImport()}
                          disabled={
                            busy ||
                            !bulkCandidates.some(
                              (candidate) => candidate.confirmed,
                            )
                          }
                        >
                          {busy ? (
                            <LoaderCircle className="animate-spin" />
                          ) : (
                            <ListPlus />
                          )}
                          创建待审批 draft
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setBulkCandidates([]);
                            setBulkIssues([]);
                          }}
                        >
                          重新解析
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="platform">来源平台</Label>
                    <NativeSelect
                      id="platform"
                      value={platform}
                      onChange={(event) => {
                        const next = event.target.value as typeof platform;
                        setPlatform(next);
                        if (next === 'wechat' || next === 'xiaohongshu') {
                          setSourceType('social');
                          setSearchLimit(next === 'wechat' ? '10' : '20');
                        }
                      }}
                    >
                      <NativeSelectOption value="rss">
                        RSS / Atom
                      </NativeSelectOption>
                      <NativeSelectOption value="http_json">
                        HTTP JSON API
                      </NativeSelectOption>
                      <NativeSelectOption value="wechat">
                        微信公众号监控
                      </NativeSelectOption>
                      <NativeSelectOption value="xiaohongshu">
                        小红书监控
                      </NativeSelectOption>
                      <NativeSelectOption value="web_page">
                        公开网页 / 热榜
                      </NativeSelectOption>
                    </NativeSelect>
                  </div>
                  {selectedConnector?.rolloutMode === 'disabled' && (
                    <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                      该连接器版本已由发布控制停用：
                      {selectedConnector.rolloutReason}
                    </p>
                  )}
                  {(platform === 'wechat' || platform === 'xiaohongshu') && (
                    <div className="grid gap-2">
                      <Label htmlFor="social-discovery">发现方式</Label>
                      <NativeSelect id="social-discovery" value={discoveryMode} onChange={(event) => setDiscoveryMode(event.target.value as 'opencli' | 'rss')}>
                        <NativeSelectOption value="opencli">OpenCLI 按公众号/账号名称搜索</NativeSelectOption>
                        <NativeSelectOption value="rss">第三方 RSS / RSSHub Feed</NativeSelectOption>
                      </NativeSelect>
                      <p className="text-xs text-muted-foreground">
                        OpenCLI 搜索是候选发现，不保证平台级 canonical 订阅；未返回作者时不会冒充该账号。需要严格账号订阅时请选择可核验的第三方 RSS。
                      </p>
                    </div>
                  )}
                  {(platform === 'wechat' || platform === 'xiaohongshu') && discoveryMode === 'opencli' ? (
                    <div className="grid gap-2">
                      <Label htmlFor="account-name">账号名称</Label>
                      <Input id="account-name" value={accountName} onChange={(event) => setAccountName(event.target.value)} placeholder={platform === 'wechat' ? '例如：聚大模型前言' : '小红书账号名称'} />
                      <Label htmlFor="search-limit">每次搜索条数（1–{platform === 'wechat' ? '10' : '20'}）</Label>
                      <Input id="search-limit" type="number" min="1" max={platform === 'wechat' ? 10 : 20} value={searchLimit} onChange={(event) => setSearchLimit(event.target.value)} />
                    </div>
                  ) : <div className="grid gap-2">
                    <Label htmlFor="source-url">{platform === 'wechat' || platform === 'xiaohongshu' ? '第三方 RSS / RSSHub URL' : 'Feed / API / 网页 URL'}</Label>
                    <Input
                      id="source-url"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      placeholder={
                        ['rss', 'wechat', 'xiaohongshu'].includes(platform)
                          ? 'https://example.com/feed.xml'
                          : platform === 'web_page'
                            ? 'https://example.com/news'
                            : 'https://api.example.com/news'
                      }
                    />
                  </div>}
                  <div className="grid gap-2">
                    <Label htmlFor="source-name">显示名称</Label>
                    <Input
                      id="source-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="公司公告"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="justify-start px-0"
                    onClick={() => setShowAdvanced((value) => !value)}
                  >
                    {showAdvanced ? '收起高级设置' : '高级设置'}
                  </Button>
                  {showAdvanced && (
                    <div className="grid gap-4 rounded-xl border bg-muted/30 p-4">
                      <div className="grid gap-3 rounded-lg border p-3">
                        <p className="text-sm font-medium">维护责任</p>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="grid gap-2">
                            <Label>业务负责人</Label>
                            <NativeSelect
                              value={businessOwnerId}
                              onChange={(event) =>
                                setBusinessOwnerId(event.target.value)
                              }
                            >
                              <NativeSelectOption value="">
                                请选择 active 成员
                              </NativeSelectOption>
                              {activeOwnerMembers.map((member) => (
                                <NativeSelectOption
                                  key={member.user_id}
                                  value={member.user_id}
                                >
                                  {member.email} · {member.role}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </div>
                        </div>
                        {!activeAdmins.length && (
                          <p className="text-xs text-destructive">
                            没有 active admin。请先到治理页登记团队成员，来源不能启用。
                          </p>
                        )}
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="source-type">证据归类（管理员）</Label>
                        <NativeSelect
                          id="source-type"
                          value={sourceType}
                          onChange={(event) =>
                            setSourceType(event.target.value)
                          }
                        >
                          {[
                            'filing',
                            'company',
                            'market',
                            'media',
                            'social',
                          ].map((value) => (
                            <NativeSelectOption key={value} value={value}>
                              {value}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="publisher-entity">发布主体 ID（可选）</Label>
                        <Input
                          id="publisher-entity"
                          value={publisherEntityId}
                          onChange={(event) => setPublisherEntityId(event.target.value)}
                          placeholder="先在治理页登记，用于关系分类"
                        />
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="source-cron">调度（UTC Cron）</Label>
                        <Input
                          id="source-cron"
                          value={cron}
                          onChange={(event) => setCron(event.target.value)}
                        />
                      </div>
                      {platform === 'http_json' && (
                        <div className="grid gap-4">
                          <div className="grid grid-cols-2 gap-3">
                            <div className="grid gap-2">
                              <Label>列表路径</Label>
                              <Input
                                value={itemsPath}
                                onChange={(e) => setItemsPath(e.target.value)}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>条目 ID 路径</Label>
                              <Input
                                value={idPath}
                                onChange={(e) => setIdPath(e.target.value)}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>标题路径</Label>
                              <Input
                                value={titlePath}
                                onChange={(e) => setTitlePath(e.target.value)}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>URL 路径</Label>
                              <Input
                                value={urlPath}
                                onChange={(e) => setUrlPath(e.target.value)}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>发布时间路径</Label>
                              <Input
                                value={publishedAtPath}
                                onChange={(e) =>
                                  setPublishedAtPath(e.target.value)
                                }
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>更新时间路径</Label>
                              <Input
                                value={updatedAtPath}
                                onChange={(e) => setUpdatedAtPath(e.target.value)}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>事件类型路径</Label>
                              <Input
                                value={kindPath}
                                onChange={(e) => setKindPath(e.target.value)}
                                placeholder="kind（upsert / tombstone）"
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>删除时间路径</Label>
                              <Input
                                value={deletedAtPath}
                                onChange={(e) => setDeletedAtPath(e.target.value)}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>摘要路径</Label>
                              <Input
                                value={summaryPath}
                                onChange={(e) => setSummaryPath(e.target.value)}
                              />
                            </div>
                            <div className="grid gap-2">
                              <Label>作者路径</Label>
                              <Input
                                value={authorPath}
                                onChange={(e) => setAuthorPath(e.target.value)}
                              />
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            若事件类型字段为 tombstone，只读取条目 ID 与删除时间；不会要求或保存伪造的标题、URL。只有更新时间晚于删除时间的 upsert 才会恢复该条目。
                          </p>
                          <div className="grid gap-3 rounded-lg border p-3">
                            <div className="grid grid-cols-2 gap-3">
                              <div className="grid gap-2">
                                <Label>分页方式</Label>
                                <NativeSelect
                                  value={paginationMode}
                                  onChange={(e) =>
                                    setPaginationMode(
                                      e.target.value as typeof paginationMode,
                                    )
                                  }
                                >
                                  <NativeSelectOption value="none">
                                    单页
                                  </NativeSelectOption>
                                  <NativeSelectOption value="page">
                                    页码
                                  </NativeSelectOption>
                                  <NativeSelectOption value="cursor">
                                    游标
                                  </NativeSelectOption>
                                  <NativeSelectOption value="since">
                                    时间水位
                                  </NativeSelectOption>
                                </NativeSelect>
                              </div>
                              <div className="grid gap-2">
                                <Label>最多页数</Label>
                                <Input
                                  type="number"
                                  min="1"
                                  max="20"
                                  value={maxPages}
                                  onChange={(e) => setMaxPages(e.target.value)}
                                />
                              </div>
                            </div>
                            {paginationMode === 'page' && (
                              <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-2">
                                  <Label>页码参数</Label>
                                  <Input
                                    value={pageParameter}
                                    onChange={(e) =>
                                      setPageParameter(e.target.value)
                                    }
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label>起始页</Label>
                                  <Input
                                    type="number"
                                    min="0"
                                    value={startPage}
                                    onChange={(e) =>
                                      setStartPage(e.target.value)
                                    }
                                  />
                                </div>
                              </div>
                            )}
                            {(paginationMode === 'cursor' ||
                              paginationMode === 'since') && (
                              <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-2">
                                  <Label>游标参数</Label>
                                  <Input
                                    value={cursorParameter}
                                    onChange={(e) =>
                                      setCursorParameter(e.target.value)
                                    }
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label>下一游标路径</Label>
                                  <Input
                                    value={cursorPath}
                                    onChange={(e) =>
                                      setCursorPath(e.target.value)
                                    }
                                    placeholder="meta.nextCursor"
                                  />
                                </div>
                              </div>
                            )}
                            {paginationMode === 'since' && (
                              <div className="grid gap-2">
                                <Label>时间水位参数</Label>
                                <Input
                                  value={sinceParameter}
                                  onChange={(e) =>
                                    setSinceParameter(e.target.value)
                                  }
                                />
                              </div>
                            )}
                            {paginationMode !== 'none' && (
                              <div className="grid grid-cols-3 gap-3">
                                <div className="grid gap-2">
                                  <Label>每页数量参数</Label>
                                  <Input
                                    value={pageSizeParameter}
                                    onChange={(e) =>
                                      setPageSizeParameter(e.target.value)
                                    }
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label>每页数量</Label>
                                  <Input
                                    type="number"
                                    min="1"
                                    max="100"
                                    value={pageSize}
                                    onChange={(e) =>
                                      setPageSize(e.target.value)
                                    }
                                  />
                                </div>
                                <div className="grid gap-2">
                                  <Label>还有更多路径</Label>
                                  <Input
                                    value={hasMorePath}
                                    onChange={(e) =>
                                      setHasMorePath(e.target.value)
                                    }
                                    placeholder="meta.hasMore"
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="grid gap-2">
                          <Label>每分钟触发上限</Label>
                          <Input
                            type="number"
                            min="1"
                            max="600"
                            value={rateLimit}
                            onChange={(e) => setRateLimit(e.target.value)}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>载荷保留</Label>
                          <NativeSelect
                            value={retentionMode}
                            onChange={(e) =>
                              setRetentionMode(
                                e.target.value as typeof retentionMode,
                              )
                            }
                          >
                            <NativeSelectOption value="metadata">
                              仅元数据
                            </NativeSelectOption>
                            <NativeSelectOption value="raw">
                              原载荷
                            </NativeSelectOption>
                          </NativeSelect>
                        </div>
                        <div className="grid gap-2">
                          <Label>天数</Label>
                          <Input
                            type="number"
                            min="1"
                            max="3650"
                            value={retentionDays}
                            onChange={(e) => setRetentionDays(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-2">
                          <Label>每请求估算成本（USD）</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.000001"
                            value={costPerRequestUsd}
                            onChange={(e) =>
                              setCostPerRequestUsd(e.target.value)
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>每次采集预留请求数</Label>
                          <Input
                            type="number"
                            min="1"
                            max="100"
                            value={estimatedRequestsPerRun}
                            onChange={(e) =>
                              setEstimatedRequestsPerRun(e.target.value)
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>月度硬预算（USD，0 为不限）</Label>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={monthlyBudgetUsd}
                            onChange={(e) =>
                              setMonthlyBudgetUsd(e.target.value)
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>预算软提醒（%）</Label>
                          <Input
                            type="number"
                            min="1"
                            max="99"
                            value={budgetSoftLimitPercent}
                            onChange={(e) =>
                              setBudgetSoftLimitPercent(e.target.value)
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>来源调度优先级（0–100）</Label>
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            value={schedulePriority}
                            onChange={(event) =>
                              setSchedulePriority(event.target.value)
                            }
                          />
                        </div>
                        <label
                          htmlFor="source-auto-throttle"
                          className="flex items-center gap-2 self-end rounded-lg border p-3 text-sm"
                        >
                          <Checkbox
                            id="source-auto-throttle"
                            checked={autoThrottleEnabled}
                            onCheckedChange={setAutoThrottleEnabled}
                          />
                          达到预算软阈值后自动降频
                        </label>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        单价为 0
                        表示免费或尚未建模；系统不会据此伪造货币成本。配置月预算后，超过软阈值产生待办；优先级 80–100 保持原频率、50–79 降为 1/2、0–49 降为 1/4。每个跳过时点都会审计，不会掩盖真正漏调度；超过硬上限的新运行不会入队。
                      </p>
                    </div>
                  )}
                  <label
                    htmlFor="source-rights-confirmed"
                    className="flex items-start gap-3 rounded-xl border p-3 text-sm"
                  >
                    <Checkbox
                      id="source-rights-confirmed"
                      checked={rightsConfirmed}
                      onCheckedChange={setRightsConfirmed}
                    />
                    <span>
                      我提交对此公开来源的 provisional 使用权声明；这不会自动批准，仍需另一名权利审批者核验。
                    </span>
                  </label>
                  <Button
                    onClick={() => void createSource()}
                    disabled={
                      busy ||
                      !name ||
                      ((platform === 'wechat' || platform === 'xiaohongshu') && discoveryMode === 'opencli' ? !accountName.trim() : !url.trim()) ||
                      !rightsConfirmed ||
                      !businessOwnerId ||
                      selectedConnector?.rolloutMode === 'disabled'
                    }
                  >
                    {busy ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <TestTube2 />
                    )}
                    保存并测试
                  </Button>
                </>
              )}
            </div>
          )}
          {step === 2 && (
            <div className="mt-6 rounded-xl border border-dashed p-8 text-center">
              <LoaderCircle className="mx-auto size-7 animate-spin" />
              <p className="mt-3 font-medium">Worker 正在验证来源</p>
              <p className="mt-1 text-sm text-muted-foreground">
                检查网络边界、内容格式与最近条目。
              </p>
            </div>
          )}
          {step === 3 && (
            <div className="mt-5 grid gap-3">
              <p className="text-sm text-muted-foreground">
                核对最近内容确实来自你登记的来源：
              </p>
              {preview.map((item) => (
                <a
                  key={`${item.url}:${item.publishedAt}`}
                  href={item.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border p-3 hover:bg-muted/40"
                >
                  <p className="line-clamp-2 text-sm font-medium">
                    {item.title}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(item.publishedAt).toLocaleString('zh-CN')}
                  </p>
                </a>
              ))}
              {pendingSource?.rightsStatus === 'approved' ? (
                <Button
                  onClick={() => pendingSourceId && void enableSource(pendingSourceId)}
                  disabled={busy || !pendingSourceId}
                >
                  <CheckCircle2 />
                  确认并启用
                </Button>
              ) : (
                <p className="rounded-xl border border-chart-3/30 bg-chart-3/10 p-3 text-sm">
                  连接验证已完成，正在等待另一名具备“来源权利审批”能力的管理员核对证据。你可以先离开此页，审批后再启用。
                </p>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  setStep(1);
                  setPreview([]);
                }}
              >
                返回修改
              </Button>
            </div>
          )}
        </section>
        <section>
          <div className="mb-4 flex items-start justify-between">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.18em] text-chart-1">
                Ingestion operations
              </p>
              <h2 className="mt-2 text-lg font-semibold tracking-tight">
                来源与运行
              </h2>
              <output className="mt-2 block text-sm text-muted-foreground">
                {message}
              </output>
            </div>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <RefreshCw />
              刷新
            </Button>
          </div>
          <div className="mb-5 rounded-2xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">连接器发布控制</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  disabled 会停止并暂停来源；shadow
                  只记录脱敏统计，不写正式文章或 checkpoint；灰度按来源 ID
                  稳定分桶，未命中的来源自动走 shadow，越过失败阈值会停用整个版本。
                </p>
              </div>
              <Badge variant="outline">管理员</Badge>
            </div>
            <div className="mt-3 grid gap-2">
              {connectors.map((connector) => (
                <div
                  key={`${connector.id}@${connector.version}`}
                  className="flex flex-col justify-between gap-3 rounded-xl border p-3 sm:flex-row sm:items-center"
                >
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {connector.label}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {connector.id}@{connector.version}
                      </span>
                      <Badge
                        variant={
                          connector.rolloutMode === 'enabled'
                            ? 'default'
                            : connector.rolloutMode === 'shadow'
                              ? 'secondary'
                              : 'destructive'
                        }
                      >
                        {rolloutLabels[connector.rolloutMode]}
                      </Badge>
                      {connector.canaryEnabled && (
                        <Badge variant="secondary">
                          灰度 {connector.canaryPercent}% · 自动停用 ≥
                          {(connector.canaryFailureRateBps / 100).toFixed(2)}% /
                          {connector.canaryMinRuns} 次
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {connector.rolloutReason}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || connector.availability !== 'available' || connector.canaryEnabled}
                      onClick={() => startConnectorCanary(connector)}
                    >
                      灰度
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        connector.availability !== 'available' ||
                        connector.rolloutMode === 'shadow'
                      }
                      onClick={() => void setConnectorMode(connector, 'shadow')}
                    >
                      Shadow
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        connector.availability !== 'available' ||
                        connector.rolloutMode === 'enabled' && !connector.canaryEnabled
                      }
                      onClick={() =>
                        void setConnectorMode(connector, 'enabled', {
                          enabled: false,
                          percent: connector.canaryPercent,
                          failureRateBps: connector.canaryFailureRateBps,
                          minRuns: connector.canaryMinRuns,
                        })
                      }
                    >
                      启用
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy || connector.rolloutMode === 'disabled'}
                      onClick={() =>
                        void setConnectorMode(connector, 'disabled')
                      }
                    >
                      停用
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="grid gap-3">
            {sources.map((source) => {
              const capability = source.adapter === 'rss'
                ? 'source:rss'
                : source.adapter === 'web'
                  ? 'source:web'
                  : source.adapter === 'social'
                    ? 'source:social'
                    : 'source:http-json';
              const workerOnline = onlineCapabilities.has(capability);
              const recentRuns = runsBySource[source.id];
              const ownershipDraft = ownershipDrafts[source.id] ?? {
                businessOwnerId: source.businessOwnerId ?? '',
              };
              const maintenanceDraft = maintenanceDrafts[source.id] ?? {
                startsAt: '',
                endsAt: '',
                reason: '',
              };
              const sloExclusions = sloExclusionsBySource[source.id] ?? [];
              const legalHolds = legalHoldsBySource[source.id];
              const activeLegalHold = legalHolds?.find(
                (hold) => hold.status === 'active',
              );
              const rightsDraft = rightsDrafts[source.id] ?? {
                principal: source.businessOwnerId ?? '',
                sourceType: (source.publicConfig.sourceType ?? 'media') as 'social' | 'media' | 'market' | 'filing' | 'company',
                territory: 'global',
                evidenceRef: '',
                evidenceSnapshot: '',
                termsVersion: 'public-source-v1',
                termsSnapshot: '',
                expiresAt: '',
              };
              const canDecideRights = canApproveRights && source.pendingRightsRequestedBy !== actor.id;
              return (
                <article
                  key={source.id}
                  className="rounded-2xl border bg-card p-5"
                >
                  <div className="grid gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {source.publicErrorMessage ? (
                          <TriangleAlert className="size-4 text-destructive" />
                        ) : (
                          <CheckCircle2 className="size-4 text-chart-1" />
                        )}
                        <h3 className="font-semibold">{source.name}</h3>
                        <Badge variant="secondary">{source.platform}</Badge>
                        <Badge variant={source.enabled ? 'default' : 'outline'}>
                          {lifecycleLabels[source.lifecycleStatus]}
                        </Badge>
                        {source.deletionStatus && (
                          <Badge variant="destructive">
                            删除请求 {source.deletionStatus}
                          </Badge>
                        )}
                        <Badge
                          variant={workerOnline ? 'outline' : 'destructive'}
                        >
                          {workerOnline ? 'Worker 在线' : `缺少 ${capability}`}
                        </Badge>
                      </div>
                      <p className="mt-2 break-all text-sm text-muted-foreground">
                        {source.publicConfig.discoveryMode === 'opencli'
                          ? `OpenCLI 搜索：${source.publicConfig.accountName}`
                          : source.publicConfig.url}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                        <span>健康 {healthLabels[source.healthStatus]}</span>
                        <span>权利 {rightsLabels[source.rightsStatus]}</span>
                        <span>调度 {source.scheduleCron || '手动'}</span>
                        <span>
                          下次{' '}
                          {source.nextRunAt
                            ? new Date(source.nextRunAt).toLocaleString(
                                'zh-CN',
                              )
                            : '未计划'}
                        </span>
                        <span>
                          最近成功{' '}
                          {source.lastSuccessAt
                            ? new Date(source.lastSuccessAt).toLocaleString(
                                'zh-CN',
                              )
                            : '尚无'}
                        </span>
                        <span>checkpoint v{source.checkpointVersion}</span>
                        <span>
                          业务负责人 {memberLabel(source.businessOwnerId)}
                        </span>
                        <span>
                          成本{' '}
                          {source.costMicrosPerRequest > 0
                            ? `$${(source.costMicrosPerRequest / 1_000_000).toFixed(6)}/请求`
                            : '未建模'}
                        </span>
                        {source.monthlyBudgetMicros > 0 && (
                          <span>
                            月预算 $
                            {(
                              source.monthlyBudgetMicros / 1_000_000
                            ).toFixed(2)}{' '}
                            · {source.budgetSoftLimitPercent}% 提醒
                          </span>
                        )}
                        <span>
                          调度优先级 {source.schedulePriority}
                          {source.autoThrottleEnabled ? ' · 自动降频开启' : ' · 自动降频关闭'}
                        </span>
                        {source.effectiveScheduleMultiplier > 1 && (
                          <span className="text-amber-700 dark:text-amber-300">
                            当前降频 ×{source.effectiveScheduleMultiplier}
                            {source.scheduleThrottleRecoveryAt
                              ? ` · 最迟 ${new Date(source.scheduleThrottleRecoveryAt).toLocaleDateString('zh-CN')} 恢复评估`
                              : ''}
                          </span>
                        )}
                        {source.hasActiveRun && <span>运行中</span>}
                      </div>
                      {source.publicErrorMessage && (
                        <p className="mt-2 text-sm text-destructive">
                          {source.publicErrorCode
                            ? `${source.publicErrorCode} · `
                            : ''}
                          {source.publicErrorMessage}
                        </p>
                      )}
                      {source.pendingRightsRequestId && (
                        <details className="mt-3 rounded-lg border border-chart-3/30 bg-chart-3/5 p-3 text-xs">
                          <summary className="cursor-pointer font-medium">待独立权利审批</summary>
                          <p className="mt-2 text-muted-foreground">
                            声明人 {memberLabel(source.pendingRightsRequestedBy)}。来源配置者不能自批；审批者还必须确认治理后的来源类型。证据和条款正文不会进入浏览器响应，只保存引用与 SHA-256 防篡改摘要。
                          </p>
                          {canDecideRights ? (
                            <div className="mt-3 grid gap-3 sm:grid-cols-2">
                              <div className="grid gap-2"><Label>权利主体</Label><Input value={rightsDraft.principal} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, principal: event.target.value } }))} /></div>
                              <div className="grid gap-2"><Label>治理后的来源类型</Label><NativeSelect value={rightsDraft.sourceType} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, sourceType: event.target.value as typeof rightsDraft.sourceType } }))}>{['social', 'media', 'market', 'filing', 'company'].map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></div>
                              <div className="grid gap-2"><Label>地域</Label><Input value={rightsDraft.territory} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, territory: event.target.value } }))} /></div>
                              <div className="grid gap-2"><Label>证据引用（文档/工单 URI）</Label><Input value={rightsDraft.evidenceRef} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, evidenceRef: event.target.value } }))} /></div>
                              <div className="grid gap-2"><Label>条款版本</Label><Input value={rightsDraft.termsVersion} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, termsVersion: event.target.value } }))} /></div>
                              <div className="grid gap-2"><Label>证据快照（仅本机计算摘要）</Label><Textarea value={rightsDraft.evidenceSnapshot} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, evidenceSnapshot: event.target.value } }))} /></div>
                              <div className="grid gap-2"><Label>条款快照（仅本机计算摘要）</Label><Textarea value={rightsDraft.termsSnapshot} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, termsSnapshot: event.target.value } }))} /></div>
                              <div className="grid gap-2"><Label>到期日（可选）</Label><Input type="date" value={rightsDraft.expiresAt} onChange={(event) => setRightsDrafts((current) => ({ ...current, [source.id]: { ...rightsDraft, expiresAt: event.target.value } }))} /></div>
                              <div className="flex items-end gap-2"><Button size="sm" disabled={busy} onClick={() => void decideRights(source, 'approve')}>批准权利</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => void decideRights(source, 'reject')}>拒绝</Button></div>
                            </div>
                          ) : (
                            <p className="mt-2 text-muted-foreground">
                              {source.pendingRightsRequestedBy === actor.id
                                ? '这是你提交的声明，必须由另一名权利审批者处理。'
                                : '当前账号未被显式授予“来源权利审批”能力；请在治理页配置。'}
                            </p>
                          )}
                        </details>
                      )}
                      <details className="mt-3 rounded-lg border p-3 text-xs">
                        <summary className="cursor-pointer font-medium">
                          <span className="inline-flex items-center gap-2">
                            <UsersRound className="size-4" />
                            负责人和备用管理员
                          </span>
                        </summary>
                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                          <div className="grid gap-2">
                            <Label>业务负责人</Label>
                            <NativeSelect
                              value={ownershipDraft.businessOwnerId}
                              onChange={(event) =>
                                setOwnershipDrafts((current) => ({
                                  ...current,
                                  [source.id]: {
                                    ...ownershipDraft,
                                    businessOwnerId: event.target.value,
                                  },
                                }))
                              }
                            >
                              <NativeSelectOption value="">未分配</NativeSelectOption>
                              {activeOwnerMembers.map((member) => (
                                <NativeSelectOption
                                  key={member.user_id}
                                  value={member.user_id}
                                >
                                  {member.email} · {member.role}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          </div>
                        </div>
                        <div className="mt-3 flex items-center gap-3">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              busy ||
                              !ownershipDraft.businessOwnerId
                            }
                            onClick={() => void transferOwnership(source)}
                          >
                            保存负责人
                          </Button>
                          <span className="text-muted-foreground">
                            保存需要填写原因，并使用来源版本锁防止覆盖他人修改。
                          </span>
                        </div>
                      </details>
                      <details
                        className="mt-3 rounded-lg border p-3 text-xs"
                        onToggle={(event) => {
                          if (event.currentTarget.open) {
                            void loadSloExclusions(source.id).catch(
                              (error: unknown) =>
                                setMessage(
                                  error instanceof Error
                                    ? error.message
                                    : '读取 SLO 排除窗口失败。',
                                ),
                            );
                          }
                        }}
                      >
                        <summary className="cursor-pointer font-medium">
                          <span className="inline-flex items-center gap-2">
                            <CalendarClock className="size-4" />
                            计划维护与 SLO 排除
                          </span>
                        </summary>
                        <p className="mt-2 text-muted-foreground">
                          只能提前登记未来 90 天内、最长 7 天的维护。不能事后补窗；普通故障不得冒充维护。
                        </p>
                        <div className="mt-3 grid gap-3 sm:grid-cols-2">
                          <div className="grid gap-2">
                            <Label htmlFor={`maintenance-start-${source.id}`}>
                              开始时间
                            </Label>
                            <Input
                              id={`maintenance-start-${source.id}`}
                              type="datetime-local"
                              value={maintenanceDraft.startsAt}
                              onChange={(event) =>
                                setMaintenanceDrafts((current) => ({
                                  ...current,
                                  [source.id]: {
                                    ...maintenanceDraft,
                                    startsAt: event.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor={`maintenance-end-${source.id}`}>
                              结束时间
                            </Label>
                            <Input
                              id={`maintenance-end-${source.id}`}
                              type="datetime-local"
                              value={maintenanceDraft.endsAt}
                              onChange={(event) =>
                                setMaintenanceDrafts((current) => ({
                                  ...current,
                                  [source.id]: {
                                    ...maintenanceDraft,
                                    endsAt: event.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                          <div className="grid gap-2 sm:col-span-2">
                            <Label htmlFor={`maintenance-reason-${source.id}`}>
                              维护原因
                            </Label>
                            <Textarea
                              id={`maintenance-reason-${source.id}`}
                              value={maintenanceDraft.reason}
                              onChange={(event) =>
                                setMaintenanceDrafts((current) => ({
                                  ...current,
                                  [source.id]: {
                                    ...maintenanceDraft,
                                    reason: event.target.value,
                                  },
                                }))
                              }
                              placeholder="例如：上游公告的 API 升级维护"
                            />
                          </div>
                        </div>
                        <Button
                          className="mt-3"
                          size="sm"
                          variant="outline"
                          disabled={
                            busy ||
                            !maintenanceDraft.startsAt ||
                            !maintenanceDraft.endsAt ||
                            maintenanceDraft.reason.trim().length < 3
                          }
                          onClick={() => void scheduleMaintenance(source)}
                        >
                          <CalendarClock />
                          登记计划维护
                        </Button>
                        <div className="mt-3 grid gap-2">
                          {sloExclusions.length ? (
                            sloExclusions.map((exclusion) => (
                              <div
                                key={exclusion.id}
                                className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                              >
                                <div>
                                  <p className="font-medium">
                                    {exclusion.kind === 'manual_pause'
                                      ? '主动暂停'
                                      : '计划维护'}
                                    {exclusion.cancelledAt ? ' · 已撤销' : ''}
                                  </p>
                                  <p className="mt-1 text-muted-foreground">
                                    {new Date(exclusion.startsAt).toLocaleString('zh-CN')}
                                    {' → '}
                                    {exclusion.endsAt
                                      ? new Date(exclusion.endsAt).toLocaleString('zh-CN')
                                      : '进行中'}
                                  </p>
                                  <p className="mt-1">{exclusion.reason}</p>
                                </div>
                                {exclusion.kind === 'planned_maintenance' &&
                                  !exclusion.cancelledAt &&
                                  new Date(exclusion.startsAt).valueOf() > Date.now() && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      disabled={busy}
                                      onClick={() =>
                                        void cancelMaintenance(source, exclusion)
                                      }
                                    >
                                      撤销
                                    </Button>
                                  )}
                              </div>
                            ))
                          ) : (
                            <p className="text-muted-foreground">
                              尚无暂停或计划维护记录。
                            </p>
                          )}
                        </div>
                      </details>
                    </div>
                    <div className="flex flex-wrap gap-2 border-t pt-3">
                      {!source.enabled &&
                        source.rightsStatus === 'approved' && (
                          <Button
                            onClick={() => void testSource(source.id)}
                            disabled={busy}
                            variant="outline"
                          >
                            <TestTube2 />
                            测试/重连
                          </Button>
                        )}
                      {source.rightsStatus === 'approved' &&
                      (source.lifecycleStatus === 'tested' ||
                        source.lifecycleStatus === 'paused') ? (
                        <Button
                          onClick={() => void enableSource(source.id)}
                          disabled={busy}
                          variant="outline"
                        >
                          启用
                        </Button>
                      ) : null}
                      {source.enabled && (
                        <Button
                          onClick={() => void pauseSource(source)}
                          disabled={busy}
                          variant="outline"
                        >
                          停用
                        </Button>
                      )}
                      <Button
                        onClick={() => void run(source)}
                        disabled={
                          busy ||
                          !source.enabled ||
                          !workerOnline ||
                          source.hasActiveRun
                        }
                        variant="outline"
                      >
                        <Play />
                        立即采集
                      </Button>
                      {source.enabled && (
                        <Button
                          onClick={() => void backfill(source)}
                          disabled={
                            busy ||
                            !workerOnline ||
                            source.hasActiveRun
                          }
                          variant="outline"
                        >
                          <History />
                          补采 7 天
                        </Button>
                      )}
                      <Button
                        onClick={() =>
                          void loadRuns(source.id).catch((error: unknown) =>
                            setMessage(
                              error instanceof Error
                                ? error.message
                                : '运行读取失败。',
                            ),
                          )
                        }
                        variant="ghost"
                      >
                        <Activity />
                        运行详情
                      </Button>
                      <Button
                        onClick={() => void archive(source)}
                        disabled={busy || Boolean(source.deletionStatus)}
                        variant="ghost"
                      >
                        <Archive />
                        归档
                      </Button>
                      <Button
                        onClick={() =>
                          void loadLegalHolds(source.id).catch(
                            (error: unknown) =>
                              setMessage(
                                error instanceof Error
                                  ? error.message
                                  : '法律保全记录读取失败。',
                              ),
                          )
                        }
                        variant="ghost"
                      >
                        <ShieldAlert />
                        {legalHolds ? '收起法律保全' : '法律保全'}
                      </Button>
                      {source.rightsStatus === 'approved' &&
                        !source.deletionStatus && (
                          <Button
                            onClick={() => void withdrawContent(source)}
                            disabled={busy}
                            variant="destructive"
                          >
                            <TriangleAlert />
                            撤回权利与内容
                          </Button>
                        )}
                      {!source.pendingRightsRequestId &&
                        ['revoked', 'expired'].includes(source.rightsStatus) &&
                        !source.deletionStatus && (
                          <Button
                            onClick={() => void resubmitRights(source)}
                            disabled={busy}
                            variant="outline"
                          >
                            重新提交权利声明
                          </Button>
                        )}
                      {source.deletionStatus ? (
                        <span className="self-center text-xs text-muted-foreground">
                          请求 {source.deletionRequestId}{' '}
                          尚未完成；请查回执接口或运行页。
                        </span>
                      ) : actor.canManageSourceLegal ? (
                        <Button
                          onClick={() => void legallyDeleteSource(source)}
                          disabled={busy}
                          variant="destructive"
                        >
                          <Trash2 />
                          依法删除
                        </Button>
                      ) : (
                        <span className="self-center text-xs text-muted-foreground">
                          依法删除需要独立法律操作权限。
                        </span>
                      )}
                    </div>
                  </div>
                  {legalHolds && (
                    <div className="mt-4 grid gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">法律保全记录</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            建立者不能解除自己的保全；至少保留两名有效法律操作人。
                          </p>
                        </div>
                        {actor.canManageSourceLegal && !activeLegalHold && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void createLegalHold(source)}
                          >
                            <ShieldAlert />
                            建立保全
                          </Button>
                        )}
                      </div>
                      {legalHolds.length ? (
                        legalHolds.map((hold) => (
                          <div
                            key={hold.id}
                            className="flex flex-col gap-3 rounded-lg border bg-background/70 p-3 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0 text-xs">
                              <p className="font-medium">
                                {hold.status === 'active' ? '保全中' : '已解除'} · epoch {hold.hold_epoch}
                              </p>
                              <p className="mt-1 break-words text-muted-foreground">
                                {hold.reason} · 依据 {hold.authority_ref}
                              </p>
                              <p className="mt-1 text-muted-foreground">
                                建立者 {memberLabel(hold.created_by)} · {new Date(hold.created_at).toLocaleString('zh-CN')}
                                {hold.released_by
                                  ? ` · 解除者 ${memberLabel(hold.released_by)}`
                                  : ''}
                              </p>
                            </div>
                            {hold.status === 'active' &&
                              actor.canManageSourceLegal &&
                              (hold.created_by === actor.id ? (
                                <span className="text-xs text-muted-foreground">
                                  须由另一名法律操作人解除
                                </span>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  disabled={busy}
                                  onClick={() =>
                                    void releaseLegalHold(source, hold)
                                  }
                                >
                                  解除保全
                                </Button>
                              ))}
                          </div>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          尚无法律保全记录。
                        </p>
                      )}
                      {!actor.canManageSourceLegal && (
                        <p className="text-xs text-muted-foreground">
                          当前账号只有查看权限；建立、解除保全需要独立法律操作权限。
                        </p>
                      )}
                    </div>
                  )}
                  {recentRuns && (
                    <div className="mt-4 grid gap-2 border-t pt-4">
                      {recentRuns.length ? (
                        recentRuns.map((item) => (
                          <div
                            key={item.id}
                            className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div>
                              <span>
                                {item.trigger} · {runStatusLabels[item.status]} ·{' '}
                                {new Date(item.createdAt).toLocaleString(
                                  'zh-CN',
                                )}
                              </span>
                              <span className="ml-2">
                                隔离 {quarantineLabels[item.quarantineStatus]}
                              </span>
                              <span className="ml-2">
                                接受 {item.acceptedCount} / 拒绝{' '}
                                {item.rejectedCount} / 重复{' '}
                                {item.duplicateCount}
                                {item.errorCode ? ` · ${item.errorCode}` : ''}
                              </span>
                            </div>
                            {[
                              'succeeded',
                              'partial',
                              'failed',
                              'rights_blocked',
                            ].includes(item.status) && (
                              <div className="flex gap-1">
                                {item.quarantineStatus !== 'held' &&
                                  item.quarantineStatus !== 'discarded' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={busy}
                                      onClick={() =>
                                        void changeRunQuarantine(
                                          source.id,
                                          item,
                                          'hold',
                                        )
                                      }
                                    >
                                      挂起
                                    </Button>
                                  )}
                                {item.quarantineStatus === 'held' && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    onClick={() =>
                                      void changeRunQuarantine(
                                        source.id,
                                        item,
                                        'release',
                                      )
                                    }
                                  >
                                    释放
                                  </Button>
                                )}
                                {item.quarantineStatus !== 'discarded' && (
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    disabled={busy}
                                    onClick={() =>
                                      void changeRunQuarantine(
                                        source.id,
                                        item,
                                        'discard',
                                      )
                                    }
                                  >
                                    丢弃
                                  </Button>
                                )}
                              </div>
                            )}
                          </div>
                        ))
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          尚无采集运行。
                        </p>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
            {!sources.length && (
              <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                选择 RSS、JSON、公开网页或社交发现方式；保存后系统会先测试，再允许启用。
              </div>
            )}
          </div>
        </section>
      </PageContainer>
    </main>
  );
}
