'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileUp, ImageIcon, Music2, Palette, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import type { ProjectRecord } from '@/lib/control-plane';
import { VIDEO_TEMPLATES } from '@/lib/templates';

type AssetRow = {
  id: string;
  object_key: string;
  media_type: string;
  asset_role: string;
  byte_size: number;
  rights_status: 'cleared' | 'restricted' | 'unknown';
  rights_note: string;
  created_at: string;
};

async function responseError(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  return payload.error ?? `请求失败（${response.status}）`;
}

export function ProductionConfig({ project, onSaved, onMessage }: { project: ProjectRecord; onSaved: () => Promise<void>; onMessage: (message: string) => void }) {
  const contract = project.project;
  const [templateId, setTemplateId] = useState(contract.render.templateId ?? 'signal40-editorial');
  const [brand, setBrand] = useState(contract.identity.brand);
  const [locale, setLocale] = useState(contract.identity.locale);
  const [channelPreset, setChannelPreset] = useState(contract.distribution.channelPreset ?? 'package');
  const [accountId, setAccountId] = useState(contract.distribution.accountId ?? '');
  const [title, setTitle] = useState(contract.distribution.title);
  const [description, setDescription] = useState(contract.distribution.description);
  const [tags, setTags] = useState((contract.distribution.tags ?? []).join(', '));
  const [scheduledAt, setScheduledAt] = useState(contract.distribution.scheduledAt?.slice(0, 16) ?? '');
  const [coverAssetId, setCoverAssetId] = useState(contract.distribution.coverAssetId ?? '');
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [rightsStatus, setRightsStatus] = useState<AssetRow['rights_status']>('cleared');
  const [rightsNote, setRightsNote] = useState('自有或已取得当前品牌与渠道使用授权。');
  const [assetPurpose, setAssetPurpose] = useState<'visual' | 'music'>('visual');
  const [musicVolume, setMusicVolume] = useState('0.12');
  const [busy, setBusy] = useState(false);

  const canUpload = ['SCRIPT_APPROVED', 'CHANGES_REQUESTED'].includes(project.state);
  const coverAssets = useMemo(() => assets.filter((asset) => asset.media_type.startsWith('image/') && asset.rights_status === 'cleared'), [assets]);

  const loadAssets = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${project.id}/assets`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await responseError(response));
    const payload = (await response.json()) as { assets: AssetRow[] };
    setAssets(payload.assets ?? []);
  }, [project.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAssets().catch((error: unknown) => onMessage(error instanceof Error ? error.message : '资产读取失败。')), 0);
    return () => window.clearTimeout(timer);
  }, [loadAssets, onMessage]);

  const saveProduction = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, 'x-signal-role': 'producer', 'x-signal-actor-id': 'local-producer' },
        body: JSON.stringify({ templateId, brand, locale }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      await onSaved();
      onMessage('模板、品牌和语言已保存；渲染快照已重新冻结，旧制作批准已失效。');
    } catch (error) { onMessage(error instanceof Error ? error.message : '生产配置保存失败。'); }
    finally { setBusy(false); }
  };

  const saveDistribution = async () => {
    setBusy(true);
    try {
      const normalizedTags = tags.split(',').map((tag) => tag.trim()).filter(Boolean);
      const response = await fetch(`/api/v1/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'if-match': `"${project.version}"`, 'x-signal-role': 'publisher', 'x-signal-actor-id': 'local-publisher' },
        body: JSON.stringify({ distribution: { channelPreset, accountId: accountId.trim() || null, title, description, tags: normalizedTags, coverAssetId: coverAssetId || null, scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null } }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      await onSaved();
      onMessage('渠道、账号、文案、标签、封面和排期已保存。发布仍需独立批准。');
    } catch (error) { onMessage(error instanceof Error ? error.message : '分发配置保存失败。'); }
    finally { setBusy(false); }
  };

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/assets`, {
        method: 'POST',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
          'x-rights-status': rightsStatus,
          'x-rights-note': encodeURIComponent(rightsNote),
          'x-asset-role': 'input',
          'x-signal-role': 'producer',
          'x-signal-actor-id': 'local-producer',
          ...(assetPurpose === 'music' ? { 'x-audio-purpose': 'music', 'x-music-volume': musicVolume } : {}),
        },
        body: file,
      });
      if (!response.ok) throw new Error(await responseError(response));
      setFile(null);
      await Promise.all([loadAssets(), onSaved()]);
      onMessage(assetPurpose === 'music' ? '音乐已上传、校验并加入混音配置。' : '资产已上传到私有对象存储并绑定版权依据。');
    } catch (error) { onMessage(error instanceof Error ? error.message : '资产上传失败。'); }
    finally { setBusy(false); }
  };

  const openAsset = async (objectKey: string) => {
    try {
      const response = await fetch('/api/v1/media-tokens', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objectKey, ttlSeconds: 300 }) });
      if (!response.ok) throw new Error(await responseError(response));
      const payload = await response.json() as { url: string };
      window.open(payload.url, '_blank', 'noopener,noreferrer');
    } catch (error) { onMessage(error instanceof Error ? error.message : '媒体授权失败。'); }
  };

  return <section className="rounded-2xl border border-border bg-card p-5">
    <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-secondary"><Palette className="size-5" /></span><div><p className="font-mono text-xs uppercase tracking-[0.15em] text-muted-foreground">Production configuration</p><h2 className="text-xl font-semibold">模板、资产与渠道</h2></div></div>

    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <div className="rounded-xl border border-border p-4">
        <h3 className="font-semibold">成片身份</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="template-id">视觉模板</Label><NativeSelect id="template-id" className="w-full" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>{VIDEO_TEMPLATES.map((template) => <NativeSelectOption key={template.id} value={template.id}>{template.name} · v{template.version}</NativeSelectOption>)}</NativeSelect><p className="text-xs text-muted-foreground">{VIDEO_TEMPLATES.find((item) => item.id === templateId)?.description}</p></div>
          <div className="grid gap-2"><Label htmlFor="project-brand">品牌</Label><Input id="project-brand" maxLength={80} value={brand} onChange={(event) => setBrand(event.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="project-locale">语言</Label><Input id="project-locale" placeholder="zh-CN" value={locale} onChange={(event) => setLocale(event.target.value)} /></div>
        </div>
        <Button className="mt-4" variant="outline" disabled={busy || !brand.trim() || !locale.trim()} onClick={() => void saveProduction()}><Save />保存成片身份</Button>
      </div>

      <div className="rounded-xl border border-border p-4">
        <h3 className="font-semibold">发布预设</h3>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-2"><Label htmlFor="channel-preset">渠道</Label><NativeSelect id="channel-preset" className="w-full" value={channelPreset} onChange={(event) => setChannelPreset(event.target.value)}><NativeSelectOption value="package">可下载发布包</NativeSelectOption><NativeSelectOption value="youtube">YouTube</NativeSelectOption></NativeSelect></div>
          <div className="grid gap-2"><Label htmlFor="account-id">账号标识</Label><Input id="account-id" value={accountId} onChange={(event) => setAccountId(event.target.value)} placeholder="channel/account id" /></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="distribution-title">标题</Label><Input id="distribution-title" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="distribution-description">描述</Label><Textarea id="distribution-description" maxLength={5000} value={description} onChange={(event) => setDescription(event.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="distribution-tags">标签（逗号分隔）</Label><Input id="distribution-tags" value={tags} onChange={(event) => setTags(event.target.value)} /></div>
          <div className="grid gap-2"><Label htmlFor="scheduled-at">计划时间</Label><Input id="scheduled-at" type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} /></div>
          <div className="grid gap-2 sm:col-span-2"><Label htmlFor="cover-asset">封面</Label><NativeSelect id="cover-asset" className="w-full" value={coverAssetId} onChange={(event) => setCoverAssetId(event.target.value)}><NativeSelectOption value="">自动抽帧</NativeSelectOption>{coverAssets.map((asset) => <NativeSelectOption key={asset.id} value={asset.id}>{asset.object_key.split('/').at(-1)}</NativeSelectOption>)}</NativeSelect></div>
        </div>
        <Button className="mt-4" variant="outline" disabled={busy || !title.trim()} onClick={() => void saveDistribution()}><Save />保存发布预设</Button>
      </div>
    </div>

    <div className="mt-5 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold">生产资产</h3><p className="mt-1 text-xs text-muted-foreground">支持图片、MP4、MP3/WAV、WOFF2；50 MB 以上使用分片上传 API。</p></div><span className="rounded-full bg-secondary px-3 py-1 text-xs">{assets.length} 项</span></div>
      <div className="mt-4 grid gap-3 md:grid-cols-[1.4fr_.8fr_.8fr_1fr_auto]">
        <div className="grid gap-2"><Label htmlFor="asset-file">文件</Label><Input id="asset-file" type="file" accept="image/png,image/jpeg,image/webp,audio/mpeg,audio/wav,video/mp4,font/woff2" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></div>
        <div className="grid gap-2"><Label htmlFor="asset-purpose">用途</Label><NativeSelect id="asset-purpose" className="w-full" value={assetPurpose} onChange={(event) => setAssetPurpose(event.target.value as 'visual' | 'music')}><NativeSelectOption value="visual">画面/字体</NativeSelectOption><NativeSelectOption value="music">背景音乐</NativeSelectOption></NativeSelect></div>
        <div className="grid gap-2"><Label htmlFor="asset-rights">版权状态</Label><NativeSelect id="asset-rights" className="w-full" value={rightsStatus} onChange={(event) => setRightsStatus(event.target.value as AssetRow['rights_status'])}><NativeSelectOption value="cleared">已清除</NativeSelectOption><NativeSelectOption value="restricted">受限</NativeSelectOption><NativeSelectOption value="unknown">未知</NativeSelectOption></NativeSelect></div>
        <div className="grid gap-2"><Label htmlFor="rights-note">版权依据</Label><Input id="rights-note" maxLength={1000} value={rightsNote} onChange={(event) => setRightsNote(event.target.value)} /></div>
        <div className="flex items-end"><Button disabled={busy || !canUpload || !file || !rightsNote.trim() || (assetPurpose === 'music' && file ? !file.type.startsWith('audio/') : false)} onClick={() => void upload()}><FileUp />上传</Button></div>
      </div>
      {assetPurpose === 'music' && <div className="mt-3 grid max-w-xs gap-2"><Label htmlFor="music-volume">音乐音量（0–0.5）</Label><Input id="music-volume" type="number" min="0" max="0.5" step="0.01" value={musicVolume} onChange={(event) => setMusicVolume(event.target.value)} /></div>}
      {!canUpload && <p className="mt-3 text-sm text-muted-foreground">项目进入“脚本已批准”后开放输入资产上传。</p>}
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{assets.slice(0, 12).map((asset) => <button type="button" key={asset.id} onClick={() => void openAsset(asset.object_key)} className="flex items-center gap-3 rounded-lg bg-secondary/50 p-3 text-left hover:bg-secondary"><span className="grid size-9 place-items-center rounded-lg bg-card">{asset.media_type.startsWith('audio/') ? <Music2 className="size-4" /> : <ImageIcon className="size-4" />}</span><span className="min-w-0"><span className="block truncate text-sm font-medium">{asset.object_key.split('/').at(-1)}</span><span className="block text-xs text-muted-foreground">{asset.rights_status} · {(asset.byte_size / 1024 / 1024).toFixed(1)} MB</span></span></button>)}</div>
    </div>
  </section>;
}
