'use client';

import { useEffect, useState } from 'react';
import { Lock, LockOpen, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { ProjectRecord } from '@/lib/control-plane';
import { devIdentityHeaders, useSession } from '@/hooks/use-session';
import { evaluateScriptDuration } from '@/lib/script-duration';
import { checkScriptCompliance } from '@/lib/script-compliance';

async function errorMessage(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error || `请求失败（${response.status}）`;
}

export function ScriptEditor({ project, onSaved, onMessage }: { project: ProjectRecord; onSaved: () => Promise<void>; onMessage: (value: string) => void }) {
  const session = useSession();
  const actorId = session.actor?.id ?? 'local-editor';
  const [script, setScript] = useState(project.project.script);
  const [previous, setPrevious] = useState<ProjectRecord['project']['script'] | null>(null);
  const [saving, setSaving] = useState(false);
  // 提前给出朗读时长估算：不匹配时本来要等配音生成后才在 G5 或自动 QC 上失败，
  // 反馈链太长。估算只用于提示，门禁判定仍以实际音轨为准。
  const duration = evaluateScriptDuration({ lines: script.lines, targetDurationSeconds: project.project.render.durationSeconds, speed: project.project.audio.speed });
  // 表达合规只是提示，不是门禁：人看过之后照样可以批准，自动放行则一律不碰这些表述。
  const compliance = checkScriptCompliance(script);
  useEffect(() => {
    void fetch(`/api/v1/projects/${project.id}/scripts`, { cache: 'no-store' })
      .then((response) => response.json() as Promise<{ versions?: Array<{ script: ProjectRecord['project']['script'] }> }>)
      .then((payload) => setPrevious(payload.versions?.[1]?.script ?? null))
      .catch(() => undefined);
  }, [project.id]);
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/scripts`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, ...devIdentityHeaders({ role: 'editor', id: 'local-editor' }) }, body: JSON.stringify({ script: { ...script, humanModifiedBy: actorId, humanModifiedAt: new Date().toISOString() } }) });
      if (!response.ok) throw new Error(await errorMessage(response));
      await onSaved();
      onMessage('脚本新版本已保存，旧脚本批准自动失效。');
    } catch (error) { onMessage(error instanceof Error ? error.message : '脚本保存失败。'); }
    finally { setSaving(false); }
  };
  return <div className="rounded-2xl border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">脚本编辑器 · v{script.version}</h2><p className="mt-1 text-xs text-muted-foreground">事实行必须绑定声明；旁白与屏幕文字分别保存，逐句评论和锁定进入不可变版本。</p><p className="mt-1 font-mono text-[11px] text-muted-foreground">{script.modelVersion} · {script.promptVersion}</p><p className={`mt-1 text-xs ${duration.status === 'ok' ? 'text-chart-1' : 'text-destructive'}`}>预计旁白 {duration.estimatedSeconds} 秒 / 目标 {duration.targetSeconds} 秒——{duration.reason}</p>{!compliance.passed && <p className="mt-1 text-xs text-chart-2">表达提示：{compliance.reasons.join('；')}。这不阻断人工批准，但会挡下自动放行。</p>}</div><Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}><Save />保存新版本</Button></div>{previous && <details className="mt-4 rounded-xl border bg-secondary/30 p-3"><summary className="cursor-pointer text-sm font-medium">与上一版 v{previous.version} 比较</summary><div className="mt-3 grid gap-2">{script.lines.map((line) => { const before = previous.lines.find((item) => item.id === line.id)?.text ?? '（新增）'; return before === line.text ? null : <div className="grid gap-2 rounded-lg bg-background p-3 text-xs sm:grid-cols-2" key={line.id}><p className="text-destructive"><span className="font-mono">旧</span> {before}</p><p className="text-chart-1"><span className="font-mono">新</span> {line.text}</p></div>; })}</div></details>}<div className="mt-4 space-y-3">{script.lines.map((line, index) => <div key={line.id} className="grid grid-cols-[32px_1fr] gap-2"><span className="pt-2 font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><div><Textarea aria-label={`${line.id} 旁白`} disabled={line.locked} value={line.text} onChange={(event) => setScript((current) => ({ ...current, lines: current.lines.map((item) => item.id === line.id ? { ...item, text: event.target.value } : item) }))} className="min-h-20 text-sm" /><Input className="mt-2" aria-label={`${line.id} 屏幕文字`} disabled={line.locked} value={line.screenText} onChange={(event) => setScript((current) => ({ ...current, lines: current.lines.map((item) => item.id === line.id ? { ...item, screenText: event.target.value } : item) }))} placeholder="屏幕文字" /><div className="mt-2 flex gap-2"><Input aria-label={`${line.id} 评论`} value={line.comment ?? ''} onChange={(event) => setScript((current) => ({ ...current, lines: current.lines.map((item) => item.id === line.id ? { ...item, comment: event.target.value } : item) }))} placeholder="逐句修改意见" /><Button type="button" size="icon-sm" variant="outline" aria-label={line.locked ? '解除锁定' : '锁定本行'} onClick={() => setScript((current) => ({ ...current, lines: current.lines.map((item) => item.id === line.id ? { ...item, locked: !item.locked } : item) }))}>{line.locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />}</Button></div><p className="mt-1 font-mono text-[11px] text-muted-foreground">Claims: {line.claimIds.join(', ') || '非事实行'}</p></div></div>)}</div></div>;
}

export function StoryboardEditor({ project, onSaved, onMessage }: { project: ProjectRecord; onSaved: () => Promise<void>; onMessage: (value: string) => void }) {
  // 挂上会话：devIdentityHeaders 读的是它带回来的部署级开关。
  useSession();
  const [timeline, setTimeline] = useState(project.project.timeline);
  const [saving, setSaving] = useState(false);
  const total = timeline.reduce((sum, scene) => sum + scene.durationFrames, 0);
  const save = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/storyboards`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, ...devIdentityHeaders({ role: 'producer', id: 'local-producer' }) }, body: JSON.stringify({ timeline }) });
      if (!response.ok) throw new Error(await errorMessage(response));
      await onSaved();
      onMessage('分镜新版本已保存，渲染快照哈希已更新。');
    } catch (error) { onMessage(error instanceof Error ? error.message : '分镜保存失败。'); }
    finally { setSaving(false); }
  };
  return <div className="rounded-2xl border border-border bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">分镜时间轴</h2><p className="mt-1 text-xs text-muted-foreground">每个场景保存转场、画面意图、屏幕文字、来源脚注与镜头运动；服务端重新计算连续起始帧。</p></div><Button size="sm" variant="outline" disabled={saving || total !== project.project.render.durationSeconds * 30} onClick={() => void save()}><Save />保存分镜</Button></div><div className="mt-4 space-y-2">{timeline.map((scene, index) => <div key={scene.id} className="grid gap-3 rounded-lg bg-secondary/60 p-3"><div className="grid grid-cols-[38px_1fr_110px] items-center gap-3"><span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, '0')}</span><div><p className="text-sm font-medium">{scene.kind}</p><p className="font-mono text-[11px] text-muted-foreground">{scene.id}</p></div><div className="flex items-center gap-2 text-xs"><Input aria-label={`${scene.kind} 时长（秒）`} type="number" min="0.1" step="0.1" value={scene.durationFrames / 30} onChange={(event) => { const frames = Math.max(1, Math.round(Number(event.target.value) * 30)); setTimeline((current) => current.map((item) => item.id === scene.id ? { ...item, durationFrames: frames } : item)); }} className="h-8" /> 秒</div></div><div className="grid gap-2 sm:grid-cols-2"><NativeSelect aria-label={`${scene.id} 转场`} className="w-full" value={scene.transition} onChange={(event) => setTimeline((current) => current.map((item) => item.id === scene.id ? { ...item, transition: event.target.value as typeof item.transition } : item))}>{['cut','fade','slide','zoom'].map((value) => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}</NativeSelect><Input aria-label={`${scene.id} 镜头运动`} value={scene.motion} onChange={(event) => setTimeline((current) => current.map((item) => item.id === scene.id ? { ...item, motion: event.target.value } : item))} placeholder="镜头运动" /><Input aria-label={`${scene.id} 画面意图`} value={scene.visualIntent} onChange={(event) => setTimeline((current) => current.map((item) => item.id === scene.id ? { ...item, visualIntent: event.target.value } : item))} placeholder="画面意图" /><Input aria-label={`${scene.id} 屏幕文字`} value={scene.screenText} onChange={(event) => setTimeline((current) => current.map((item) => item.id === scene.id ? { ...item, screenText: event.target.value } : item))} placeholder="屏幕文字" /><Input className="sm:col-span-2" aria-label={`${scene.id} 来源脚注`} value={scene.sourceFootnote} onChange={(event) => setTimeline((current) => current.map((item) => item.id === scene.id ? { ...item, sourceFootnote: event.target.value } : item))} placeholder="来源脚注" /></div></div>)}</div><p className={`mt-3 text-xs ${total === project.project.render.durationSeconds * 30 ? 'text-chart-1' : 'text-destructive'}`}>当前总时长 {(total / 30).toFixed(1)} 秒</p></div>;
}
