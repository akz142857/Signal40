'use client';

import { useCallback, useEffect, useState } from 'react';
import { Beaker, Check, FlaskConical, Plus, Shield, UsersRound, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Checkbox } from '@/components/ui/checkbox';
import { ROLES, type Role } from '@/lib/workflow';
import { PageContainer, PageHeader } from '@/components/page-shell';

type Member = {
  user_id: string;
  email: string;
  role: Role;
  status: 'active' | 'suspended';
  can_approve_source_rights: number;
  can_manage_source_legal: number;
  business_source_count: number | string;
};
type Experiment = { id: string; name: string; hypothesis: string; status: 'draft' | 'running' | 'completed' | 'cancelled'; variants: string[]; allocationBps: number[]; primary_metric: string };
type Calibration = { id: string; calibration_kind: 'score' | 'social_evidence'; algorithm_version: string; dataset_label: string; case_count: number; metrics: Record<string, number>; status: 'candidate' | 'approved' | 'rejected'; created_by: string };
type PublisherEntity = { id: string; legal_name: string; ownership_group: string; entity_type: string };
type EvidenceOrigin = { id: string; source_name: string; platform: string; title: string; detected_relationship: string; detected_evidence_family_id: string | null; detected_publisher_entity_id: string | null; detected_confidence: number; correction_id: string | null; relationship: string | null; evidence_family_id: string | null; publisher_entity_id: string | null; confidence: number | null };

async function readJson<T>(response: Response) {
  // 服务端 5xx 可能没有响应体，直接 .json() 会把真实错误盖成 “Unexpected end of JSON input”。
  const text = await response.text();
  let payload: (T & { error?: string }) | null = null;
  try { payload = text ? JSON.parse(text) as T & { error?: string } : null; }
  catch { payload = null; }
  if (!response.ok) throw new Error(payload?.error || `请求失败（${response.status}）`);
  if (!payload) throw new Error(`请求成功但响应不是 JSON（${response.status}）`);
  return payload;
}

export function GovernanceDashboard() {
  // 挂上会话：devIdentityHeaders 读的是它带回来的部署级开关。
  useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [calibrations, setCalibrations] = useState<Calibration[]>([]);
  const [entities, setEntities] = useState<PublisherEntity[]>([]);
  const [origins, setOrigins] = useState<EvidenceOrigin[]>([]);
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
  const [socialCalibrationForm, setSocialCalibrationForm] = useState({ algorithmVersion: 'social-evidence/1.0.0', datasetLabel: '', datasetRef: '', datasetSha256: '', caseCount: '100', falseIndependentRate: '0.02', independentRecall: '0.8', productionSampleSize: '30', minimumConfidence: '90' });
  const [entityForm, setEntityForm] = useState({ id: '', legalName: '', ownershipGroup: '', entityType: 'company', website: '' });
  const [correctionForm, setCorrectionForm] = useState({ originId: '', relationship: 'original', evidenceFamilyId: '', publisherEntityId: '', confidence: '90', reason: '' });

  const refresh = useCallback(async () => {
    const [memberPayload, experimentPayload, calibrationPayload, entityPayload, originPayload] = await Promise.all([
      readJson<{ members: Member[] }>(await fetch('/api/v1/team-members', { cache: 'no-store' })),
      readJson<{ experiments: Experiment[] }>(await fetch('/api/v1/experiments', { cache: 'no-store' })),
      readJson<{ runs: Calibration[] }>(await fetch('/api/v1/calibration-runs', { cache: 'no-store', headers: devIdentityHeaders({ role: 'researcher', id: 'local-researcher' }) })),
      readJson<{ entities: PublisherEntity[] }>(await fetch('/api/v1/publisher-entities', { cache: 'no-store', headers: devIdentityHeaders({ role: 'researcher', id: 'local-researcher' }) })),
      readJson<{ origins: EvidenceOrigin[] }>(await fetch('/api/v1/source-origins', { cache: 'no-store', headers: devIdentityHeaders({ role: 'editor', id: 'local-calibration-editor' }) })),
    ]);
    setMembers(memberPayload.members);
    setExperiments(experimentPayload.experiments);
    setCalibrations(calibrationPayload.runs);
    setEntities(entityPayload.entities);
    setOrigins(originPayload.origins);
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
    const businessCount = Number(member.business_source_count ?? 0);
    const affectedCount = suspending
      ? businessCount
      : 0;
    if (affectedCount > 0 && !window.confirm(
      `该成员当前承担 ${businessCount} 个来源的业务负责人。继续后会立即生成来源负责人待办；请尽快到来源页完成转移。`,
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

  const createSocialCalibration = async () => {
    try {
      await readJson(await fetch('/api/v1/calibration-runs', { method: 'POST', headers: { 'content-type': 'application/json', ...devIdentityHeaders({ role: 'researcher', id: 'local-researcher' }) }, body: JSON.stringify({
        calibrationKind: 'social_evidence', algorithmVersion: socialCalibrationForm.algorithmVersion,
        datasetLabel: socialCalibrationForm.datasetLabel, datasetRef: socialCalibrationForm.datasetRef,
        datasetSha256: socialCalibrationForm.datasetSha256, caseCount: Number(socialCalibrationForm.caseCount),
        metrics: { falseIndependentRate: Number(socialCalibrationForm.falseIndependentRate), independentRecall: Number(socialCalibrationForm.independentRecall), productionSampleSize: Number(socialCalibrationForm.productionSampleSize) },
        policy: { version: socialCalibrationForm.algorithmVersion, minimumConfidence: Number(socialCalibrationForm.minimumConfidence), eligibleRelationships: ['original'], socialAutoProductionEnabled: true, maximumFalseIndependentRate: 0.02, minimumIndependentRecall: 0.8, minimumProductionSampleSize: 30 },
        note: 'Social Evidence 标注集与生产抽样候选，等待独立编辑审批。',
      }) }));
      setMessage('Social Evidence 校准候选已冻结；未独立批准前仍失败关闭。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Social Evidence 校准登记失败。'); }
  };

  const createPublisherEntity = async () => {
    try {
      await readJson(await fetch('/api/v1/publisher-entities', { method: 'POST', headers: { 'content-type': 'application/json', ...devIdentityHeaders({ role: 'admin', id: 'local-admin' }) }, body: JSON.stringify({ ...entityForm, identifiers: entityForm.website ? { website: entityForm.website } : {} }) }));
      setEntityForm({ id: '', legalName: '', ownershipGroup: '', entityType: 'company', website: '' });
      setMessage('Publisher entity 已登记并写入审计。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Publisher entity 登记失败。'); }
  };

  const correctOrigin = async () => {
    try {
      await readJson(await fetch(`/api/v1/source-origins/${encodeURIComponent(correctionForm.originId)}/corrections`, { method: 'POST', headers: { 'content-type': 'application/json', ...devIdentityHeaders({ role: 'editor', id: 'local-calibration-editor' }) }, body: JSON.stringify({ ...correctionForm, confidence: Number(correctionForm.confidence) }) }));
      setMessage('Origin 修正已版本化保存，并已排队重算 72 小时滚动语料。');
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Origin 修正失败。'); }
  };

  return <main className="min-h-screen bg-background text-foreground">
    <PageHeader width="wide" icon={<Shield className="size-5" />} title="治理与增长实验" subtitle="成员权限、受控实验与离线校准" />
    <PageContainer width="wide" className="space-y-7 py-7">{message && <output className="block rounded-xl border border-chart-3/30 bg-chart-3/10 p-3 text-sm">{message}</output>}
      <Section icon={UsersRound} title="团队与最小权限" description="权利审批和法律操作都是独立 capability；active legal hold 期间必须保留两名法律操作人。">
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-[1fr_1fr_160px_190px_190px_auto]">
          <Field label="用户 ID"><Input value={memberForm.userId} onChange={(event) => setMemberForm({ ...memberForm, userId: event.target.value })} /></Field>
          <Field label="邮箱"><Input type="email" value={memberForm.email} onChange={(event) => setMemberForm({ ...memberForm, email: event.target.value })} /></Field>
          <Field label="角色"><NativeSelect value={memberForm.role} onChange={(event) => setMemberForm({ ...memberForm, role: event.target.value as Role, canApproveSourceRights: event.target.value === 'admin' ? memberForm.canApproveSourceRights : false, canManageSourceLegal: event.target.value === 'admin' ? memberForm.canManageSourceLegal : false })}>{ROLES.map((role) => <NativeSelectOption key={role} value={role}>{role}</NativeSelectOption>)}</NativeSelect></Field>
          <div className="flex items-center gap-2 self-end rounded-lg border px-3 py-2 text-sm"><Checkbox id="new-member-rights-approver" checked={memberForm.canApproveSourceRights} disabled={memberForm.role !== 'admin'} onCheckedChange={(checked) => setMemberForm({ ...memberForm, canApproveSourceRights: checked === true })} /><Label htmlFor="new-member-rights-approver">来源权利审批者</Label></div>
          <div className="flex items-center gap-2 self-end rounded-lg border px-3 py-2 text-sm"><Checkbox id="new-member-legal-operator" checked={memberForm.canManageSourceLegal} disabled={memberForm.role !== 'admin'} onCheckedChange={(checked) => setMemberForm({ ...memberForm, canManageSourceLegal: checked === true })} /><Label htmlFor="new-member-legal-operator">来源法律操作人</Label></div>
          <Button className="self-end" disabled={!memberForm.userId || !memberForm.email} onClick={() => void addMember()}><Plus />添加</Button>
        </div>
        <div className="mt-4 grid gap-2">{members.map((member) => <article key={member.user_id} className="grid items-center gap-3 rounded-xl border p-3 md:grid-cols-[1fr_180px_160px_170px_110px]"><div><p className="font-medium">{member.email}</p><p className="font-mono text-xs text-muted-foreground">{member.user_id}</p><p className="mt-1 text-xs text-muted-foreground">负责来源：{Number(member.business_source_count ?? 0)}</p></div><NativeSelect value={member.role} onChange={(event) => void updateMember(member, { role: event.target.value as Role })}>{ROLES.map((role) => <NativeSelectOption key={role} value={role}>{role}</NativeSelectOption>)}</NativeSelect><div className="flex items-center gap-2 text-sm"><Checkbox id={`member-rights-${member.user_id}`} checked={Boolean(member.can_approve_source_rights)} disabled={member.role !== 'admin' || member.status !== 'active'} onCheckedChange={(checked) => void updateMember(member, { canApproveSourceRights: checked === true })} /><Label htmlFor={`member-rights-${member.user_id}`}>权利审批</Label></div><div className="flex items-center gap-2 text-sm"><Checkbox id={`member-legal-${member.user_id}`} checked={Boolean(member.can_manage_source_legal)} disabled={member.role !== 'admin' || member.status !== 'active'} onCheckedChange={(checked) => void updateMember(member, { canManageSourceLegal: checked === true })} /><Label htmlFor={`member-legal-${member.user_id}`}>法律操作</Label></div><Button variant="outline" onClick={() => void updateMember(member, { status: member.status === 'active' ? 'suspended' : 'active' })}>{member.status === 'active' ? '停用' : '恢复'}</Button></article>)}{!members.length && <Empty text="当前本地库还没有正式团队成员；生产环境由首个允许邮箱引导建立管理员。" />}</div>
      </Section>
      <Section icon={Beaker} title="A/B 实验" description="默认 50/50 稳定分流；实验指标不会绕过事实、版权或发布门禁。">
        <div className="grid gap-3 lg:grid-cols-3"><Field label="实验名称"><Input value={experimentForm.name} onChange={(event) => setExperimentForm({ ...experimentForm, name: event.target.value })} /></Field><Field label="假设"><Input value={experimentForm.hypothesis} onChange={(event) => setExperimentForm({ ...experimentForm, hypothesis: event.target.value })} /></Field><Field label="主指标"><Input value={experimentForm.primaryMetric} onChange={(event) => setExperimentForm({ ...experimentForm, primaryMetric: event.target.value })} /></Field></div><Button className="mt-3" disabled={!experimentForm.name || !experimentForm.hypothesis} onClick={() => void createExperiment()}><Plus />创建实验草稿</Button>
        <div className="mt-4 grid gap-2">{experiments.map((experiment) => <article key={experiment.id} className="flex flex-col justify-between gap-3 rounded-xl border p-4 md:flex-row md:items-center"><div><p className="font-medium">{experiment.name} <span className="ml-2 font-mono text-xs text-muted-foreground">{experiment.status}</span></p><p className="mt-1 text-sm text-muted-foreground">{experiment.hypothesis} · {experiment.variants.join(' / ')} · {experiment.primary_metric}</p></div><div className="flex gap-2">{experiment.status === 'draft' && <Button size="sm" onClick={() => void transitionExperiment(experiment, 'running')}>启动</Button>}{experiment.status === 'running' && <Button size="sm" onClick={() => void transitionExperiment(experiment, 'completed')}>完成</Button>}{['draft','running'].includes(experiment.status) && <Button size="sm" variant="outline" onClick={() => void transitionExperiment(experiment, 'cancelled')}>取消</Button>}</div></article>)}{!experiments.length && <Empty text="尚无受控实验。" />}</div>
      </Section>
      <Section icon={FlaskConical} title="离线校准" description="至少 100 个标注案例并强制异人审批；评分校准不自动改写权重，Social Evidence 审批会激活冻结门禁并触发重算。">
        <div className="grid gap-3 lg:grid-cols-4"><Field label="算法版本"><Input value={calibrationForm.algorithmVersion} onChange={(event) => setCalibrationForm({ ...calibrationForm, algorithmVersion: event.target.value })} /></Field><Field label="数据集标签"><Input value={calibrationForm.datasetLabel} onChange={(event) => setCalibrationForm({ ...calibrationForm, datasetLabel: event.target.value })} /></Field><Field label="样本数"><Input type="number" min="100" value={calibrationForm.caseCount} onChange={(event) => setCalibrationForm({ ...calibrationForm, caseCount: event.target.value })} /></Field><Field label="门禁准确率"><Input type="number" min="0" max="1" step="0.01" value={calibrationForm.gateAccuracy} onChange={(event) => setCalibrationForm({ ...calibrationForm, gateAccuracy: event.target.value })} /></Field></div><Button className="mt-3" disabled={!calibrationForm.datasetLabel || Number(calibrationForm.caseCount) < 100} onClick={() => void createCalibration()}><Plus />登记校准候选</Button>
        <div className="mt-4 grid gap-2">{calibrations.map((run) => <article key={run.id} className="flex flex-col justify-between gap-3 rounded-xl border p-4 md:flex-row md:items-center"><div><p className="font-medium">{run.dataset_label} <span className="ml-2 font-mono text-xs text-muted-foreground">{run.status}</span></p><p className="mt-1 text-sm text-muted-foreground">{run.algorithm_version} · {run.case_count} cases · accuracy {run.metrics.gateAccuracy ?? '—'}</p></div>{run.status === 'candidate' && <div className="flex gap-2"><Button size="sm" onClick={() => void decideCalibration(run, 'approved')}><Check />批准</Button><Button size="sm" variant="outline" onClick={() => void decideCalibration(run, 'rejected')}><X />拒绝</Button></div>}</article>)}{!calibrations.length && <Empty text="尚无真实历史金标校准记录；synthetic 回归不会自动登记为金标。" />}</div>
      </Section>
      <Section icon={Shield} title="Social Evidence 门禁" description="纳管 origin 默认失败关闭；只有人工修正、合格最大匹配和已批准阈值同时成立，社交信号才可能进入自动生产。">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-5"><Field label="主体稳定 ID"><Input value={entityForm.id} onChange={(event) => setEntityForm({ ...entityForm, id: event.target.value })} /></Field><Field label="法定主体"><Input value={entityForm.legalName} onChange={(event) => setEntityForm({ ...entityForm, legalName: event.target.value })} /></Field><Field label="所有权集团"><Input value={entityForm.ownershipGroup} onChange={(event) => setEntityForm({ ...entityForm, ownershipGroup: event.target.value })} /></Field><Field label="主体类型"><Input value={entityForm.entityType} onChange={(event) => setEntityForm({ ...entityForm, entityType: event.target.value })} /></Field><Field label="官方站点"><Input value={entityForm.website} onChange={(event) => setEntityForm({ ...entityForm, website: event.target.value })} placeholder="https://example.com" /></Field></div>
        <Button className="mt-3" variant="outline" disabled={!entityForm.id || !entityForm.legalName || !entityForm.ownershipGroup} onClick={() => void createPublisherEntity()}><Plus />登记主体</Button>
        <p className="mt-4 text-xs text-muted-foreground">已登记主体：{entities.map((entity) => `${entity.id}（${entity.ownership_group}）`).join('、') || '暂无'}</p>
        <div className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-3"><Field label="Origin"><NativeSelect value={correctionForm.originId} onChange={(event) => setCorrectionForm({ ...correctionForm, originId: event.target.value })}><NativeSelectOption value="">选择待修正 origin</NativeSelectOption>{origins.map((origin) => <NativeSelectOption key={origin.id} value={origin.id}>{origin.source_name} · {origin.title.slice(0, 32)}</NativeSelectOption>)}</NativeSelect></Field><Field label="关系"><NativeSelect value={correctionForm.relationship} onChange={(event) => setCorrectionForm({ ...correctionForm, relationship: event.target.value })}>{['original','repost','quote','syndicated','unknown'].map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect></Field><Field label="证据家族 ID"><Input value={correctionForm.evidenceFamilyId} onChange={(event) => setCorrectionForm({ ...correctionForm, evidenceFamilyId: event.target.value })} /></Field><Field label="Publisher entity"><NativeSelect value={correctionForm.publisherEntityId} onChange={(event) => setCorrectionForm({ ...correctionForm, publisherEntityId: event.target.value })}><NativeSelectOption value="">选择主体</NativeSelectOption>{entities.map((entity) => <NativeSelectOption key={entity.id} value={entity.id}>{entity.legal_name} · {entity.ownership_group}</NativeSelectOption>)}</NativeSelect></Field><Field label="置信度"><Input type="number" min="0" max="100" value={correctionForm.confidence} onChange={(event) => setCorrectionForm({ ...correctionForm, confidence: event.target.value })} /></Field><Field label="修正依据"><Input value={correctionForm.reason} onChange={(event) => setCorrectionForm({ ...correctionForm, reason: event.target.value })} /></Field></div>
        <Button className="mt-3" disabled={!correctionForm.originId || !correctionForm.evidenceFamilyId || !correctionForm.publisherEntityId || correctionForm.reason.trim().length < 10} onClick={() => void correctOrigin()}><Check />保存修正并重算</Button>
        <div className="mt-4 grid gap-2">{origins.slice(0, 20).map((origin) => <article key={origin.id} className="rounded-xl border p-3 text-sm"><p className="font-medium">{origin.title}</p><p className="mt-1 text-muted-foreground">{origin.platform} · {origin.correction_id ? `${origin.relationship} / ${origin.evidence_family_id} / ${origin.publisher_entity_id} / ${origin.confidence}` : `${origin.detected_relationship} / confidence ${origin.detected_confidence}（未人工修正，不计独立证据）`}</p></article>)}{!origins.length && <Empty text="暂无已采集 origin。" />}</div>
        <div className="mt-6 grid gap-3 md:grid-cols-2 lg:grid-cols-4"><Field label="算法版本"><Input value={socialCalibrationForm.algorithmVersion} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, algorithmVersion: event.target.value })} /></Field><Field label="数据集标签"><Input value={socialCalibrationForm.datasetLabel} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, datasetLabel: event.target.value })} /></Field><Field label="数据集引用"><Input value={socialCalibrationForm.datasetRef} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, datasetRef: event.target.value })} /></Field><Field label="数据集 SHA-256"><Input value={socialCalibrationForm.datasetSha256} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, datasetSha256: event.target.value })} /></Field><Field label="标注数"><Input type="number" min="100" value={socialCalibrationForm.caseCount} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, caseCount: event.target.value })} /></Field><Field label="误独立率"><Input type="number" min="0" max="0.02" step="0.001" value={socialCalibrationForm.falseIndependentRate} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, falseIndependentRate: event.target.value })} /></Field><Field label="独立召回率"><Input type="number" min="0.8" max="1" step="0.01" value={socialCalibrationForm.independentRecall} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, independentRecall: event.target.value })} /></Field><Field label="生产抽样数"><Input type="number" min="30" value={socialCalibrationForm.productionSampleSize} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, productionSampleSize: event.target.value })} /></Field><Field label="最低置信度"><Input type="number" min="0" max="100" value={socialCalibrationForm.minimumConfidence} onChange={(event) => setSocialCalibrationForm({ ...socialCalibrationForm, minimumConfidence: event.target.value })} /></Field></div>
        <Button className="mt-3" disabled={!socialCalibrationForm.datasetLabel || !socialCalibrationForm.datasetRef || !/^[a-f0-9]{64}$/.test(socialCalibrationForm.datasetSha256)} onClick={() => void createSocialCalibration()}><FlaskConical />冻结门禁候选</Button>
      </Section>
    </PageContainer>
  </main>;
}

function Section({ icon: Icon, title, description, children }: { icon: typeof Beaker; title: string; description: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border bg-card p-5"><div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary"><Icon className="size-5" /></span><div><h2 className="text-xl font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div></div><div className="mt-5">{children}</div></section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid gap-2"><Label>{label}</Label>{children}</div>; }
function Empty({ text }: { text: string }) { return <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{text}</p>; }
