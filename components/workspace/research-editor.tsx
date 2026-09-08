'use client';

import { useState } from 'react';
import { BookOpenCheck, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { ProjectRecord } from '@/lib/control-plane';
import type { VideoProjectV2 } from '@/lib/project-v2';

async function readError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error ?? `请求失败（${response.status}）`;
}

export function ResearchEditor({ project, onSaved, onMessage }: { project: ProjectRecord; onSaved: () => Promise<void>; onMessage: (message: string) => void }) {
  const [research, setResearch] = useState<VideoProjectV2['research']>(() => structuredClone(project.project.research));
  const [busy, setBusy] = useState(false);
  const editable = ['RESEARCHING', 'CHANGES_REQUESTED'].includes(project.state);

  const updateClaim = (index: number, change: Partial<VideoProjectV2['research']['claims'][number]>) => {
    setResearch((current) => ({ ...current, claims: current.claims.map((claim, position) => position === index ? { ...claim, ...change } : claim) }));
  };

  const addEvidence = (claimIndex: number) => {
    const evidence = { sourceId: `manual_${crypto.randomUUID().slice(0, 8)}`, articleRevisionId: null, url: '', stance: 'supports' as const, quote: '', observedAt: new Date().toISOString(), locator: { type: 'url' as const, value: '' } };
    updateClaim(claimIndex, { evidence: [...research.claims[claimIndex].evidence, evidence] });
  };

  const save = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(project.id)}/research`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, 'x-signal-role': 'researcher' },
        body: JSON.stringify({ research }),
      });
      if (!response.ok) throw new Error(await readError(response));
      await onSaved();
      onMessage('研究快照新版本已保存，旧研究批准自动失效。');
    } catch (error) { onMessage(error instanceof Error ? error.message : '研究保存失败。'); }
    finally { setBusy(false); }
  };

  return <section className="rounded-2xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Claim-level evidence</p><h2 className="mt-1 text-xl font-semibold">声明、证据与冲突</h2></div>{editable && <div className="flex gap-2"><Button variant="outline" onClick={() => setResearch((current) => ({ ...current, claims: [...current.claims, { id: `claim_${crypto.randomUUID().slice(0, 8)}`, text: '', kind: 'fact', quantity: null, evidence: [] }] }))}><Plus />声明</Button><Button disabled={busy} onClick={() => void save()}><Save />保存研究版本</Button></div>}</div>
    <p className="mt-2 text-sm text-muted-foreground">每条事实声明都要绑定支持证据；反驳证据会自动形成冲突，填写解决依据后才能通过 G2。</p>
    <div className="mt-5 space-y-4">{research.claims.map((claim, claimIndex) => <article key={claim.id} className="rounded-xl border p-4">
      <div className="flex gap-2"><NativeSelect disabled={!editable} value={claim.kind} onChange={(event) => { const kind = event.target.value as typeof claim.kind; updateClaim(claimIndex, { kind, quantity: kind === 'numeric' ? claim.quantity ?? { value: 0, unit: '', currency: null, timeRange: '', basis: '', entity: '', uncertainty: null } : claim.quantity }); }}>{['fact','numeric','comparison','causal','prediction','analysis','opinion','disclaimer'].map((kind) => <NativeSelectOption key={kind} value={kind}>{kind}</NativeSelectOption>)}</NativeSelect><Textarea disabled={!editable} value={claim.text} onChange={(event) => updateClaim(claimIndex, { text: event.target.value })} className="min-h-16 flex-1" />{editable && research.claims.length > 1 && <Button variant="ghost" size="icon" aria-label="删除声明" onClick={() => setResearch((current) => ({ ...current, claims: current.claims.filter((_, position) => position !== claimIndex), conflicts: current.conflicts.filter((conflict) => conflict.claimId !== claim.id) }))}><Trash2 /></Button>}</div>
      {claim.kind === 'numeric' && claim.quantity && <div className="mt-3 grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-3"><div className="grid gap-1"><Label>数值</Label><Input disabled={!editable} type="number" value={claim.quantity.value} onChange={(event) => updateClaim(claimIndex, { quantity: { ...claim.quantity!, value: Number(event.target.value) } })} /></div><div className="grid gap-1"><Label>单位</Label><Input disabled={!editable} value={claim.quantity.unit} onChange={(event) => updateClaim(claimIndex, { quantity: { ...claim.quantity!, unit: event.target.value } })} /></div><div className="grid gap-1"><Label>币种</Label><Input disabled={!editable} value={claim.quantity.currency ?? ''} onChange={(event) => updateClaim(claimIndex, { quantity: { ...claim.quantity!, currency: event.target.value || null } })} /></div><div className="grid gap-1"><Label>统计周期</Label><Input disabled={!editable} value={claim.quantity.timeRange} onChange={(event) => updateClaim(claimIndex, { quantity: { ...claim.quantity!, timeRange: event.target.value } })} /></div><div className="grid gap-1"><Label>同比/环比基准</Label><Input disabled={!editable} value={claim.quantity.basis} onChange={(event) => updateClaim(claimIndex, { quantity: { ...claim.quantity!, basis: event.target.value } })} /></div><div className="grid gap-1"><Label>主体</Label><Input disabled={!editable} value={claim.quantity.entity} onChange={(event) => updateClaim(claimIndex, { quantity: { ...claim.quantity!, entity: event.target.value } })} /></div><div className="grid gap-1 sm:col-span-3"><Label>不确定性</Label><Input disabled={!editable} value={claim.quantity.uncertainty ?? ''} onChange={(event) => updateClaim(claimIndex, { quantity: { ...claim.quantity!, uncertainty: event.target.value || null } })} /></div></div>}
      <div className="mt-3 space-y-2">{claim.evidence.map((evidence, evidenceIndex) => <div key={`${evidence.sourceId}-${evidenceIndex}`} className="grid gap-2 rounded-lg bg-secondary/45 p-3 md:grid-cols-[120px_1fr]">
        <NativeSelect disabled={!editable} value={evidence.stance} onChange={(event) => updateClaim(claimIndex, { evidence: claim.evidence.map((item, position) => position === evidenceIndex ? { ...item, stance: event.target.value as typeof item.stance } : item) })}><NativeSelectOption value="supports">支持</NativeSelectOption><NativeSelectOption value="refutes">反驳</NativeSelectOption><NativeSelectOption value="context">背景</NativeSelectOption></NativeSelect>
        <div className="grid gap-2"><Input disabled={!editable} value={evidence.url} onChange={(event) => updateClaim(claimIndex, { evidence: claim.evidence.map((item, position) => position === evidenceIndex ? { ...item, url: event.target.value, locator: item.locator.type === 'url' ? { ...item.locator, value: event.target.value } : item.locator } : item) })} placeholder="https://原始来源" /><div className="grid gap-2 sm:grid-cols-[140px_1fr]"><NativeSelect disabled={!editable} value={evidence.locator.type} onChange={(event) => updateClaim(claimIndex, { evidence: claim.evidence.map((item, position) => position === evidenceIndex ? { ...item, locator: { ...item.locator, type: event.target.value as typeof item.locator.type } } : item) })}>{['url','page','paragraph','table','section','timecode'].map((type) => <NativeSelectOption key={type} value={type}>{type}</NativeSelectOption>)}</NativeSelect><Input disabled={!editable} value={evidence.locator.value} onChange={(event) => updateClaim(claimIndex, { evidence: claim.evidence.map((item, position) => position === evidenceIndex ? { ...item, locator: { ...item.locator, value: event.target.value } } : item) })} placeholder="页码、段落、表格或时间码" /></div><Textarea disabled={!editable} value={evidence.quote} onChange={(event) => updateClaim(claimIndex, { evidence: claim.evidence.map((item, position) => position === evidenceIndex ? { ...item, quote: event.target.value } : item) })} className="min-h-16" placeholder="支持该声明的原文摘录" /></div>
      </div>)}{editable && <Button variant="ghost" onClick={() => addEvidence(claimIndex)}><Plus />添加证据</Button>}</div>
    </article>)}</div>
    {research.conflicts.length > 0 && <div className="mt-5 rounded-xl border border-chart-2/30 bg-chart-2/5 p-4"><div className="flex items-center gap-2"><BookOpenCheck className="size-4 text-chart-2" /><h3 className="font-semibold">冲突解决记录</h3></div><div className="mt-3 space-y-3">{research.conflicts.map((conflict, index) => <div key={`${conflict.claimId}-${index}`}><p className="text-sm font-medium">{conflict.claimId} · {conflict.description}</p><Textarea disabled={!editable} className="mt-2 min-h-16" value={conflict.resolution ?? ''} onChange={(event) => setResearch((current) => ({ ...current, conflicts: current.conflicts.map((item, position) => position === index ? { ...item, resolution: event.target.value || null } : item) }))} placeholder="说明为何采信、如何修正或为何保留不确定性" /></div>)}</div></div>}
  </section>;
}
