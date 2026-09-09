'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Beaker, Check, FlaskConical, Plus, Shield, UsersRound, X } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { ROLES, type Role } from '@/lib/workflow';

type Member = {
  user_id: string;
  email: string;
  role: Role;
  status: 'active' | 'suspended';
  can_approve_source_rights: number;
  can_manage_source_legal: number;
  business_source_count: number | string;
  credential_source_count: number | string;
  backup_source_count: number | string;
};
type Experiment = { id: string; name: string; hypothesis: string; status: 'draft' | 'running' | 'completed' | 'cancelled'; variants: string[]; allocationBps: number[]; primary_metric: string };
type Calibration = { id: string; algorithm_version: string; dataset_label: string; case_count: number; metrics: Record<string, number>; status: 'candidate' | 'approved' | 'rejected'; created_by: string };

async function readJson<T>(response: Response) {
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

export function GovernanceDashboard() {
  // 挂上会话：devIdentityHeaders 读的是它带回来的部署级开关。
  useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [message, setMessage] = useState('');
  const [memberForm, setMemberForm] = useState({
    userId: '',
    email: '',
    role: 'researcher' as Role,
    canApproveSourceRights: false,
    canManageSourceLegal: false,
  });
  const [experimentForm, setExperimentForm] = useState({ name: '', hypothesis: '', primaryMetric: 'completionRate' });
  const [calibrationForm, setCalibrationForm] = useState({ algorithmVersion: 'signal40-score/1.0.0', datasetLabel: '', caseCount: '100', gateAccuracy: '1' });

  const refresh = useCallback(async () => {
    const [memberPayload, experimentPayload, calibrationPayload] = await Promise.all([
      readJson<{ members: Member[] }>(await fetch('/api/v1/team-members', { cache: 'no-store' })),
      readJson<{ experiments: Experiment[] }>(await fetch('/api/v1/experiments', { cache: 'no-store' })),
      readJson<{ runs: Calibration[] }>(await fetch('/api/v1/calibration-runs', { cache: 'no-store', headers: devIdentityHeaders({ role: 'researcher', id: 'local-researcher' }) })),
    ]);
    setMembers(memberPayload.members);
    setExperiments(experimentPayload.experiments);
    setCalibrations(calibrationPayload.runs);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : '治理数据读取失败。')); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const addMember = async () => {
    try {
      await readJson(await fetch('/api/v1/team-members', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `member:${memberForm.userId}:${memberForm.email}` }, body: JSON.stringify(memberForm) }));
      setMemberForm({ userId: '', email: '', role: 'researcher', canApproveSourceRights: false, canManageSourceLegal: false });
      setMessage('成员已加入，权限立即由服务端生效。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '成员添加失败。'); }
  };

  const updateMember = async (
    member: Member,
    update: Partial<Pick<Member, 'role' | 'status'>> & {
      canApproveSourceRights?: boolean;
      canManageSourceLegal?: boolean;
    },
  ) => {
    const suspending = update.status === 'suspended';
    const removingAdmin = member.role === 'admin' && update.role !== undefined && update.role !== 'admin';
    const businessCount = Number(member.business_source_count ?? 0);
    const credentialCount = Number(member.credential_source_count ?? 0);
    const backupCount = Number(member.backup_source_count ?? 0);
    const affectedCount = suspending
      ? businessCount + credentialCount + backupCount
      : removingAdmin
        ? credentialCount + backupCount
        : 0;
    if (affectedCount > 0 && !window.confirm(
      `该成员当前承担 ${businessCount} 个来源的业务负责人、${credentialCount} 个来源的凭据管理员、${backupCount} 个来源的备用管理员。继续后会立即生成来源负责人待办；请尽快到来源页完成转移。`,
    )) return;
    try {
      const result = await readJson<{ ownershipImpact?: { issueCount?: number } }>(await fetch(`/api/v1/team-members/${encodeURIComponent(member.user_id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) }));
      setMessage(result.ownershipImpact?.issueCount
        ? `成员已更新；${result.ownershipImpact.issueCount} 个来源需要重新分配负责人，待办已生成。`
        : '成员已更新；来源维护责任仍然完整。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '成员更新失败。'); }
  };

  const createExperiment = async () => {
    try {
      await readJson(await fetch('/api/v1/experiments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `experiment:${crypto.randomUUID()}` }, body: JSON.stringify({ ...experimentForm, variants: ['control', 'variant'], allocationBps: [5000, 5000], guardrails: ['correctionRate', 'negativeFeedbackRate'] }) }));
      setExperimentForm({ name: '', hypothesis: '', primaryMetric: 'completionRate' });
      setMessage('实验草稿已创建，启动后项目将按稳定哈希分流。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '实验创建失败。'); }
  };

  const transitionExperiment = async (experiment: Experiment, status: 'running' | 'completed' | 'cancelled') => {
    try {
      await readJson(await fetch(`/api/v1/experiments/${experiment.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) }));
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '实验状态更新失败。'); }
  };

  const createCalibration = async () => {
    try {
      await readJson(await fetch('/api/v1/calibration-runs', { method: 'POST', headers: { 'content-type': 'application/json', ...devIdentityHeaders({ role: 'researcher', id: 'local-researcher' }) }, body: JSON.stringify({ algorithmVersion: calibrationForm.algorithmVersion, datasetLabel: calibrationForm.datasetLabel, caseCount: Number(calibrationForm.caseCount), metrics: { gateAccuracy: Number(calibrationForm.gateAccuracy) }, note: '候选算法离线评估，等待独立编辑审批。' }) }));
      setCalibrationForm((current) => ({ ...current, datasetLabel: '' }));
      setMessage('校准候选已登记；提交者不能审批自己的结果。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '校准登记失败。'); }
  };

  const decideCalibration = async (run: Calibration, decision: 'approved' | 'rejected') => {
    try {
      await readJson(await fetch(`/api/v1/calibration-runs/${run.id}/decision`, { method: 'POST', headers: { 'content-type': 'application/json', ...devIdentityHeaders({ role: 'editor', id: 'local-calibration-editor' }) }, body: JSON.stringify({ decision, note: decision === 'approved' ? '已独立核对样本量、数据口径与离线指标。' : '离线证据不足，拒绝进入线上评分候选。' }) }));
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '校准审批失败。'); }
  };

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4"><div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Shield className="size-5" /></span><div><h1 className="font-semibold">治理与增长实验</h1><p className="text-xs text-muted-foreground">成员权限、受控实验与离线校准</p></div></div><Link href="/" className={buttonVariants({ variant: 'outline' })}><ArrowLeft />返回雷达</Link></div></header>
    <div className="mx-auto max-w-7xl space-y-7 px-5 py-7">{message && <output className="block rounded-xl border border-chart-3/30 bg-chart-3/10 p-3 text-sm">{message}</output>}
      <Section icon={UsersRound} title="团队与最小权限" description="权利审批和法律操作都是独立 capability；active legal hold 期间必须保留两名法律操作人。">
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-[1fr_1fr_160px_190px_190px_auto]">
          <Field label="用户 ID"><Input value={memberForm.userId} onChange={(event) => setMemberForm({ ...memberForm, userId: event.target.value })} /></Field>
          <Field label="邮箱"><Input type="email" value={memberForm.email} onChange={(event) => setMemberForm({ ...memberForm, email: event.target.value })} /></Field>
          <Field label="角色"><NativeSelect value={memberForm.role} onChange={(event) => setMemberForm({ ...memberForm, role: event.target.value as Role, canApproveSourceRights: event.target.value === 'admin' ? memberForm.canApproveSourceRights : false, canManageSourceLegal: event.target.value === 'admin' ? memberForm.canManageSourceLegal : false })}>{ROLES.map((role) => <NativeSelectOption key={role} value={role}>{role}</NativeSelectOption>)}</NativeSelect></Field>
          <div className="flex items-center gap-2 self-end rounded-lg border px-3 py-2 text-sm"><Checkbox id="new-member-rights-approver" checked={memberForm.canApproveSourceRights} disabled={memberForm.role !== 'admin'} onCheckedChange={(checked) => setMemberForm({ ...memberForm, canApproveSourceRights: checked === true })} /><Label htmlFor="new-member-rights-approver">来源权利审批者</Label></div>
          <div className="flex items-center gap-2 self-end rounded-lg border px-3 py-2 text-sm"><Checkbox id="new-member-legal-operator" checked={memberForm.canManageSourceLegal} disabled={memberForm.role !== 'admin'} onCheckedChange={(checked) => setMemberForm({ ...memberForm, canManageSourceLegal: checked === true })} /><Label htmlFor="new-member-legal-operator">来源法律操作人</Label></div>
          <Button className="self-end" disabled={!memberForm.userId || !memberForm.email} onClick={() => void addMember()}><Plus />添加</Button>
        </div>
        <div className="mt-4 grid gap-2">{members.map((member) => <article key={member.user_id} className="grid items-center gap-3 rounded-xl border p-3 md:grid-cols-[1fr_180px_160px_170px_110px]"><div><p className="font-medium">{member.email}</p><p className="font-mono text-xs text-muted-foreground">{member.user_id}</p><p className="mt-1 text-xs text-muted-foreground">来源责任：业务 {Number(member.business_source_count ?? 0)} · 凭据 {Number(member.credential_source_count ?? 0)} · 备用 {Number(member.backup_source_count ?? 0)}</p></div><NativeSelect value={member.role} onChange={(event) => void updateMember(member, { role: event.target.value as Role })}>{ROLES.map((role) => <NativeSelectOption key={role} value={role}>{role}</NativeSelectOption>)}</NativeSelect><div className="flex items-center gap-2 text-sm"><Checkbox id={`member-rights-${member.user_id}`} checked={Boolean(member.can_approve_source_rights)} disabled={member.role !== 'admin' || member.status !== 'active'} onCheckedChange={(checked) => void updateMember(member, { canApproveSourceRights: checked === true })} /><Label htmlFor={`member-rights-${member.user_id}`}>权利审批</Label></div><div className="flex items-center gap-2 text-sm"><Checkbox id={`member-legal-${member.user_id}`} checked={Boolean(member.can_manage_source_legal)} disabled={member.role !== 'admin' || member.status !== 'active'} onCheckedChange={(checked) => void updateMember(member, { canManageSourceLegal: checked === true })} /><Label htmlFor={`member-legal-${member.user_id}`}>法律操作</Label></div><Button variant="outline" onClick={() => void updateMember(member, { status: member.status === 'active' ? 'suspended' : 'active' })}>{member.status === 'active' ? '停用' : '恢复'}</Button></article>)}{!members.length && <Empty text="当前本地库还没有正式团队成员；生产环境由首个允许邮箱引导建立管理员。" />}</div>
      </Section>
      <Section icon={Beaker} title="A/B 实验" description="默认 50/50 稳定分流；实验指标不会绕过事实、版权或发布门禁。">
        <div className="grid gap-3 lg:grid-cols-3"><Field label="实验名称"><Input value={experimentForm.name} onChange={(event) => setExperimentForm({ ...experimentForm, name: event.target.value })} /></Field><Field label="假设"><Input value={experimentForm.hypothesis} onChange={(event) => setExperimentForm({ ...experimentForm, hypothesis: event.target.value })} /></Field><Field label="主指标"><Input value={experimentForm.primaryMetric} onChange={(event) => setExperimentForm({ ...experimentForm, primaryMetric: event.target.value })} /></Field></div><Button className="mt-3" disabled={!experimentForm.name || !experimentForm.hypothesis} onClick={() => void createExperiment()}><Plus />创建实验草稿</Button>
        <div className="mt-4 grid gap-2">{experiments.map((experiment) => <article key={experiment.id} className="flex flex-col justify-between gap-3 rounded-xl border p-4 md:flex-row md:items-center"><div><p className="font-medium">{experiment.name} <span className="ml-2 font-mono text-xs text-muted-foreground">{experiment.status}</span></p><p className="mt-1 text-sm text-muted-foreground">{experiment.hypothesis} · {experiment.variants.join(' / ')} · {experiment.primary_metric}</p></div><div className="flex gap-2">{experiment.status === 'draft' && <Button size="sm" onClick={() => void transitionExperiment(experiment, 'running')}>启动</Button>}{experiment.status === 'running' && <Button size="sm" onClick={() => void transitionExperiment(experiment, 'completed')}>完成</Button>}{['draft','running'].includes(experiment.status) && <Button size="sm" variant="outline" onClick={() => void transitionExperiment(experiment, 'cancelled')}>取消</Button>}</div></article>)}{!experiments.length && <Empty text="尚无受控实验。" />}</div>
      </Section>
      <Section icon={FlaskConical} title="评分离线校准" description="至少 100 个标注案例；提交者与审批者强制分离，批准也不会自动改写线上权重。">
        <div className="grid gap-3 lg:grid-cols-4"><Field label="算法版本"><Input value={calibrationForm.algorithmVersion} onChange={(event) => setCalibrationForm({ ...calibrationForm, algorithmVersion: event.target.value })} /></Field><Field label="数据集标签"><Input value={calibrationForm.datasetLabel} onChange={(event) => setCalibrationForm({ ...calibrationForm, datasetLabel: event.target.value })} /></Field><Field label="样本数"><Input type="number" min="100" value={calibrationForm.caseCount} onChange={(event) => setCalibrationForm({ ...calibrationForm, caseCount: event.target.value })} /></Field><Field label="门禁准确率"><Input type="number" min="0" max="1" step="0.01" value={calibrationForm.gateAccuracy} onChange={(event) => setCalibrationForm({ ...calibrationForm, gateAccuracy: event.target.value })} /></Field></div><Button className="mt-3" disabled={!calibrationForm.datasetLabel || Number(calibrationForm.caseCount) < 100} onClick={() => void createCalibration()}><Plus />登记校准候选</Button>
        <div className="mt-4 grid gap-2">{calibrations.map((run) => <article key={run.id} className="flex flex-col justify-between gap-3 rounded-xl border p-4 md:flex-row md:items-center"><div><p className="font-medium">{run.dataset_label} <span className="ml-2 font-mono text-xs text-muted-foreground">{run.status}</span></p><p className="mt-1 text-sm text-muted-foreground">{run.algorithm_version} · {run.case_count} cases · accuracy {run.metrics.gateAccuracy ?? '—'}</p></div>{run.status === 'candidate' && <div className="flex gap-2"><Button size="sm" onClick={() => void decideCalibration(run, 'approved')}><Check />批准</Button><Button size="sm" variant="outline" onClick={() => void decideCalibration(run, 'rejected')}><X />拒绝</Button></div>}</article>)}{!calibrations.length && <Empty text="尚无真实历史金标校准记录；synthetic 回归不会自动登记为金标。" />}</div>
      </Section>
    </div>
  </main>;
}

function Section({ icon: Icon, title, description, children }: { icon: typeof Beaker; title: string; description: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border bg-card p-5"><div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary"><Icon className="size-5" /></span><div><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div></div><div className="mt-5">{children}</div></section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-2"><Label>{label}</Label>{children}</div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{text}</p>; }
