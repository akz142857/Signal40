import fs from 'node:fs/promises';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ProjectRecord } from '../lib/control-plane.ts';
import { mapHttpJson, parseRssFeed, assertPublicHttpUrl, type SourceConfigInput } from '../lib/source-adapters.ts';
import { validateArticleInput, type ArticleInput } from '../lib/domain.ts';
import { renderProject } from './render.ts';

const controlUrl = process.env.SIGNAL40_CONTROL_URL?.replace(/\/$/, '');
const workerToken = process.env.SIGNAL40_WORKER_TOKEN;
const openAiApiKey = process.env.OPENAI_API_KEY;
const workerId = process.env.SIGNAL40_WORKER_ID || `render-${os.hostname()}`;
if (!controlUrl || !workerToken) throw new Error('SIGNAL40_CONTROL_URL 与 SIGNAL40_WORKER_TOKEN 必填。');
const requiredWorkerToken = workerToken;

const workerHeaders = { 'content-type': 'application/json', 'x-worker-token': requiredWorkerToken };

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function runQc(videoPath: string, projectPath: string) {
  return new Promise<{ status: string; checks: unknown[] }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', path.resolve('scripts/media-qc.ts'), videoPath, projectPath]);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('exit', () => {
      try { resolve(JSON.parse(output) as { status: string; checks: unknown[] }); }
      catch { reject(new Error(`无法解析 QC 输出：${output.slice(-2000)}`)); }
    });
  });
}

async function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args);
    let error = '';
    child.stderr.on('data', (data) => { error += String(data); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} 失败：${error.slice(-1500)}`)));
  });
}

type WorkerJob = { id: string; kind: string; project_id: string | null; payload: Record<string, unknown> };

type AlignmentWord = { word: string; start: number; end: number };

function captionChunks(text: string, maxCharacters = 18) {
  const clauses = text.match(/.*?[，。！？；：,.!?;:]|.+$/g)?.map((item) => item.trim()).filter(Boolean) ?? [text];
  return clauses.flatMap((clause) => {
    const characters = Array.from(clause);
    const result: string[] = [];
    for (let index = 0; index < characters.length; index += maxCharacters) result.push(characters.slice(index, index + maxCharacters).join(''));
    return result;
  });
}

function buildCaptions(lines: ProjectRecord['project']['script']['lines'], durationMs: number, alignment: AlignmentWord[] = []) {
  const weighted = lines.map((line) => ({ ...line, chunks: captionChunks(line.text), weight: Math.max(1, Array.from(line.text).length) }));
  const totalWeight = weighted.reduce((sum, line) => sum + line.weight, 0);
  let cursor = 0;
  return weighted.flatMap((line) => {
    const lineDuration = durationMs * line.weight / totalWeight;
    const chunkWeight = line.chunks.reduce((sum, chunk) => sum + Math.max(1, Array.from(chunk).length), 0);
    return line.chunks.map((text) => {
      const startRatio = cursor / durationMs;
      const proportionalDuration = lineDuration * Math.max(1, Array.from(text).length) / chunkWeight;
      cursor += proportionalDuration;
      const endRatio = cursor / durationMs;
      const startWord = alignment[Math.min(alignment.length - 1, Math.floor(startRatio * alignment.length))];
      const endWord = alignment[Math.min(alignment.length - 1, Math.max(0, Math.ceil(endRatio * alignment.length) - 1))];
      const startMs = startWord ? Math.round(startWord.start * 1000) : Math.round(cursor - proportionalDuration);
      const endMs = endWord ? Math.round(endWord.end * 1000) : Math.round(cursor);
      return {
        startMs: Math.max(0, startMs),
        endMs: Math.min(durationMs, Math.max(startMs + 120, endMs)),
        text,
        lineId: line.id,
        granularity: 'sentence' as const,
        style: line.id.includes('takeaway') ? 'disclaimer' as const : 'default' as const,
        safeArea: { left: 72, right: 72, top: 160, bottom: 280 },
        manuallyEdited: false,
      };
    });
  });
}

async function fetchPublicSource(initialUrl: string) {
  let url = assertPublicHttpUrl(initialUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const hostname = new URL(url).hostname;
    const addresses = await dns.lookup(hostname, { all: true, order: 'verbatim' });
    if (!addresses.length || addresses.some(({ address }) => {
      if (net.isIPv4(address)) return address.startsWith('10.') || address.startsWith('127.') || address.startsWith('169.254.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || address === '0.0.0.0';
      const normalized = address.toLowerCase();
      if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice(7);
        return mapped.startsWith('10.') || mapped.startsWith('127.') || mapped.startsWith('169.254.') || mapped.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(mapped);
      }
      return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb');
    })) throw new Error('来源 DNS 解析到私有或保留网络。');
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'application/rss+xml, application/atom+xml, application/json, text/xml;q=0.9, */*;q=0.1', 'user-agent': 'Signal40-Ingestion/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('来源重定向缺少 Location。');
      url = assertPublicHttpUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`来源请求失败：HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > 5_000_000) throw new Error('来源响应超过 5 MB。');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 5_000_000) throw new Error('来源响应超过 5 MB。');
    return { url, contentType: response.headers.get('content-type') ?? '', text: new TextDecoder().decode(bytes) };
  }
  throw new Error('来源重定向次数超过 3 次。');
}

async function workIngestion(job: WorkerJob) {
  const sourceConfigId = typeof job.payload.sourceConfigId === 'string' ? job.payload.sourceConfigId : '';
  const ingestionRunId = typeof job.payload.ingestionRunId === 'string' ? job.payload.ingestionRunId : '';
  if (!sourceConfigId || !ingestionRunId) throw new Error('采集作业缺少 sourceConfigId 或 ingestionRunId。');
  const { source } = await json<{ source: { name: string; adapter: string; enabled: number; rights_status: string; rate_limit_per_minute: number; retention_mode: 'metadata' | 'raw'; retention_days: number; config: { sourceType: SourceConfigInput['sourceType']; url?: string; mapping?: Record<string, string> } } }>(await fetch(`${controlUrl}/api/v1/source-configs/${encodeURIComponent(sourceConfigId)}`, { headers: { 'x-worker-token': requiredWorkerToken } }));
  if (!source.enabled || source.rights_status !== 'approved') throw new Error('来源未启用或授权未批准。');
  if (!source.config.url || !['rss', 'http'].includes(source.adapter)) throw new Error(`后台 Worker 暂不支持 ${source.adapter} 适配器自动拉取。`);
  const response = await fetchPublicSource(source.config.url);
  const config: SourceConfigInput = {
    name: source.name,
    adapter: source.adapter as 'rss' | 'http',
    sourceType: source.config.sourceType,
    url: response.url,
    rightsStatus: 'approved',
    mapping: source.config.mapping,
    rateLimitPerMinute: source.rate_limit_per_minute,
    retention: { mode: source.retention_mode, days: source.retention_days },
  };
  let articles: ArticleInput[];
  if (source.adapter === 'rss') {
    articles = parseRssFeed(response.text, config);
  } else {
    if (!response.contentType.toLowerCase().includes('json')) throw new Error('HTTP 适配器要求 JSON Content-Type。');
    articles = mapHttpJson(JSON.parse(response.text), config);
  }
  const validArticles = articles.filter((article) => validateArticleInput(article) === null);
  const checkpoint = validArticles.map((article) => article.publishedAt).sort().at(-1) ?? null;
  let rawObjectKey: string | null = null;
  if (source.retention_mode === 'raw') {
    const rawUpload = await json<{ objectKey: string }>(await fetch(`${controlUrl}/api/v1/ingestion-runs/${encodeURIComponent(ingestionRunId)}/raw`, {
      method: 'PUT',
      headers: { 'content-type': response.contentType || 'application/octet-stream', 'x-worker-token': requiredWorkerToken, 'x-job-id': job.id },
      body: response.text,
    }));
    rawObjectKey = rawUpload.objectKey;
  }
  return json(await fetch(`${controlUrl}/api/v1/ingestion-runs/${encodeURIComponent(ingestionRunId)}/commit`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({ jobId: job.id, articles: validArticles, fetchedCount: articles.length, checkpoint, rawObjectKey }),
  }));
}

async function workVoice(job: WorkerJob) {
  if (!job.project_id) throw new Error('配音作业缺少 project_id。');
  if (!openAiApiKey) throw new Error('OPENAI_API_KEY 未配置，不能执行云端配音。');
  const projectPayload = await json<{ project: ProjectRecord }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}`));
  const project = projectPayload.project.project;
  if (typeof job.payload.scriptHash !== 'string') throw new Error('配音作业缺少 scriptHash。');
  const textInput = project.script.lines.map((line) => line.text).join('\n');
  if (!textInput.trim() || textInput.length > 4096) throw new Error('配音文本必须为 1–4096 个字符。');
  const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
  const voice = process.env.OPENAI_TTS_VOICE || 'coral';
  const pronunciationHints = Object.entries(Object.assign({}, ...project.script.lines.map((line) => line.pronunciationHints)) as Record<string, string>);
  const pronunciationInstruction = pronunciationHints.length ? `读音要求：${pronunciationHints.map(([term, pronunciation]) => `${term} 读作 ${pronunciation}`).join('；')}。` : '';
  const speech = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${openAiApiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, voice, input: textInput, response_format: 'mp3', instructions: `使用清晰、克制、可信的普通话财经新闻语气，数字读法准确，避免营销腔。${pronunciationInstruction}` }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!speech.ok) throw new Error(`OpenAI 配音失败：${speech.status} ${(await speech.text()).slice(0, 500)}`);
  const audio = await speech.arrayBuffer();
  if (audio.byteLength < 1000) throw new Error('OpenAI 返回了空音频。');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/mpeg' }), 'voice.mp3');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', 'zh');
  const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${openAiApiKey}` }, body: form, signal: AbortSignal.timeout(120_000) });
  if (!transcriptionResponse.ok) throw new Error(`字幕对齐失败：${transcriptionResponse.status} ${(await transcriptionResponse.text()).slice(0, 500)}`);
  const transcription = await json<{ duration?: number; words?: AlignmentWord[] }>(transcriptionResponse);
  const alignment = (transcription.words ?? []).filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end > word.start);
  const durationMs = Math.round(1000 * (transcription.duration ?? alignment.at(-1)?.end ?? 0));
  if (durationMs < 500) throw new Error('字幕对齐未返回有效音频时长。');
  const upload = await json<{ asset: { id: string } }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/assets`, {
    method: 'POST',
    headers: { 'content-type': 'audio/mpeg', 'x-filename': `${job.id}.mp3`, 'x-asset-role': 'voice-output', 'x-rights-status': 'cleared', 'x-rights-note': `OpenAI ${model} built-in voice ${voice}`, 'x-worker-token': requiredWorkerToken },
    body: audio,
  }));
  return json(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/voice-tracks`, {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({ jobId: job.id, assetId: upload.asset.id, provider: `openai:${model}`, fallbackProvider: project.audio.fallbackProvider, voice, speed: project.audio.speed, pronunciationDictionary: Object.fromEntries(pronunciationHints), estimatedCostMicros: 0, durationMs, alignment, captions: buildCaptions(project.script.lines, durationMs, alignment), scriptVersion: project.script.version, scriptHash: job.payload.scriptHash }),
  }));
}

async function downloadMedia(objectKey: string) {
  const response = await fetch(`${controlUrl}/api/v1/media?objectKey=${encodeURIComponent(objectKey)}`, { headers: { 'x-worker-token': requiredWorkerToken } });
  if (!response.ok) throw new Error(`媒体下载失败：${response.status} ${await response.text()}`);
  return { bytes: await response.arrayBuffer(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
}

async function uploadYouTube(input: { bytes: ArrayBuffer; contentType: string; title: string; description: string; tags: string[]; privacyStatus: string; cover?: { bytes: ArrayBuffer; contentType: string } | null }) {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) throw new Error('YOUTUBE_ACCESS_TOKEN 未配置。');
  const allowPublic = process.env.SIGNAL40_ALLOW_PUBLIC_PUBLISH === 'true';
  const privacyStatus = allowPublic ? input.privacyStatus : 'private';
  const metadata = JSON.stringify({ snippet: { title: input.title, description: input.description, tags: input.tags, categoryId: '25' }, status: { privacyStatus, selfDeclaredMadeForKids: false } });
  const session = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-length': String(input.bytes.byteLength), 'x-upload-content-type': input.contentType },
    body: metadata,
    signal: AbortSignal.timeout(30_000),
  });
  if (!session.ok) throw new Error(`YouTube 上传会话创建失败：${session.status} ${(await session.text()).slice(0, 500)}`);
  const location = session.headers.get('location');
  if (!location) throw new Error('YouTube 未返回续传会话 URL。');
  let offset = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const remaining = input.bytes.slice(offset);
    const response = await fetch(location, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': input.contentType, 'content-length': String(remaining.byteLength), 'content-range': `bytes ${offset}-${input.bytes.byteLength - 1}/${input.bytes.byteLength}` },
      body: remaining,
      signal: AbortSignal.timeout(180_000),
    });
    if (response.ok) {
      const video = await json<{ id?: string }>(response);
      if (!video.id) throw new Error('YouTube 上传完成但未返回视频 ID。');
      if (input.cover) {
        const thumbnail = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(video.id)}&uploadType=media`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': input.cover.contentType }, body: input.cover.bytes, signal: AbortSignal.timeout(60_000),
        });
        if (!thumbnail.ok) throw new Error(`YouTube 封面上传失败：${thumbnail.status} ${(await thumbnail.text()).slice(0, 500)}`);
      }
      return { externalId: video.id, finalUrl: `https://www.youtube.com/watch?v=${video.id}`, privacyStatus };
    }
    if (response.status === 308) {
      const range = response.headers.get('range');
      offset = range ? Number(range.split('-').at(-1)) + 1 : 0;
      continue;
    }
    if (![500, 502, 503, 504].includes(response.status)) throw new Error(`YouTube 上传失败：${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  throw new Error('YouTube 上传在 6 次恢复尝试后仍未完成。');
}

async function deleteYouTube(externalId: string) {
  const token = process.env.YOUTUBE_ACCESS_TOKEN;
  if (!token) throw new Error('YOUTUBE_ACCESS_TOKEN 未配置。');
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(externalId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`YouTube 下架失败：${response.status} ${(await response.text()).slice(0, 500)}`);
  return { withdrawn: true, externalId };
}

async function workPublish(job: WorkerJob) {
  if (!job.project_id || typeof job.payload.publishJobId !== 'string' || typeof job.payload.channel !== 'string') throw new Error('发布作业字段不完整。');
  if (job.payload.operation === 'withdraw') {
    if (job.payload.channel === 'youtube' && typeof job.payload.externalId === 'string') return deleteYouTube(job.payload.externalId);
    return { withdrawn: true, externalId: job.payload.externalId ?? null };
  }
  if (!job.payload.asset || typeof job.payload.asset !== 'object') throw new Error('发布作业缺少成片资产。');
  const asset = job.payload.asset as { objectKey?: unknown; sha256?: unknown; byteSize?: unknown };
  if (typeof asset.objectKey !== 'string') throw new Error('发布作业缺少成片对象键。');
  const title = typeof job.payload.title === 'string' ? job.payload.title : '';
  const description = typeof job.payload.description === 'string' ? job.payload.description : '';
  const channel = job.payload.channel;
  let completion: { externalId?: string; finalUrl?: string; manifest?: unknown; platformResponse?: unknown };
  if (channel === 'package') {
    completion = { manifest: { schemaVersion: '1.0', projectId: job.project_id, snapshotHash: job.payload.snapshotHash, accountId: job.payload.accountId, title, description, tags: job.payload.tags, cover: job.payload.coverAsset, video: asset, sources: job.payload.sources, createdAt: new Date().toISOString(), mediaEndpoint: `/api/v1/media?objectKey=${encodeURIComponent(asset.objectKey)}` } };
  } else if (channel === 'youtube') {
    const media = await downloadMedia(asset.objectKey);
    const coverAsset = job.payload.coverAsset && typeof job.payload.coverAsset === 'object' ? job.payload.coverAsset as { object_key?: unknown } : null;
    const cover = coverAsset && typeof coverAsset.object_key === 'string' ? await downloadMedia(coverAsset.object_key) : null;
    const uploaded = await uploadYouTube({ bytes: media.bytes, contentType: media.contentType, title, description, tags: Array.isArray(job.payload.tags) ? job.payload.tags.filter((tag): tag is string => typeof tag === 'string') : [], privacyStatus: typeof job.payload.privacyStatus === 'string' ? job.payload.privacyStatus : 'private', cover });
    completion = {
      externalId: uploaded.externalId,
      finalUrl: uploaded.finalUrl,
      platformResponse: { privacyStatus: uploaded.privacyStatus, accountId: job.payload.accountId ?? null },
    };
  } else {
    throw new Error(`不支持发布渠道 ${channel}。`);
  }
  return json(await fetch(`${controlUrl}/api/v1/publish-jobs/${encodeURIComponent(job.payload.publishJobId)}/complete`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ jobId: job.id, channel, ...completion }) }));
}

async function workRender(job: WorkerJob) {
  if (!job.project_id) throw new Error('渲染作业缺少 project_id。');
  const profile = job.kind === 'preview' ? 'preview' : 'final';
  const projectPayload = await json<{ project: ProjectRecord }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}`));
  const renderProjectInput = structuredClone(projectPayload.project.project);
  if (renderProjectInput.audio.objectKey?.startsWith('projects/')) {
    const media = await downloadMedia(renderProjectInput.audio.objectKey);
    renderProjectInput.audio.objectKey = `data:${media.contentType};base64,${Buffer.from(media.bytes).toString('base64')}`;
  }
  if (renderProjectInput.audio.music?.objectKey.startsWith('projects/')) {
    const music = await downloadMedia(renderProjectInput.audio.music.objectKey);
    renderProjectInput.audio.music.objectKey = `data:${music.contentType};base64,${Buffer.from(music.bytes).toString('base64')}`;
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'signal40-render-'));
  const videoPath = path.join(directory, `${job.id}.mp4`);
  const coverPath = path.join(directory, `${job.id}-cover.jpg`);
  const projectPath = path.join(directory, `${job.id}.project.json`);
  try {
    await fs.writeFile(projectPath, JSON.stringify(renderProjectInput));
    await renderProject(renderProjectInput, videoPath, { profile });
    const qc = profile === 'final' ? await runQc(videoPath, projectPath) : null;
    const bytes = await fs.readFile(videoPath);
    const upload = await json<{ asset: { id: string; objectKey: string; sha256: string } }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'video/mp4', 'x-filename': `${job.id}.mp4`, 'x-asset-role': profile === 'preview' ? 'preview-output' : 'render-output', 'x-rights-status': 'cleared', 'x-rights-note': profile === 'preview' ? 'Signal 40 Render Worker 低码率预览资产' : 'Signal 40 Render Worker 正式成片资产', 'x-worker-token': requiredWorkerToken },
      body: bytes,
    }));
    if (profile === 'preview') return { asset: upload.asset, profile, snapshotHash: renderProjectInput.render.snapshotHash };
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '2', '-y', coverPath]);
    const coverBytes = await fs.readFile(coverPath);
    const cover = await json<{ asset: { id: string; objectKey: string; sha256: string } }>(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/assets`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg', 'x-filename': `${job.id}-cover.jpg`, 'x-asset-role': 'render-output', 'x-rights-status': 'cleared', 'x-rights-note': 'Signal 40 Render Worker 从成片抽取的封面', 'x-worker-token': requiredWorkerToken },
      body: coverBytes,
    }));
    await json(await fetch(`${controlUrl}/api/v1/projects/${encodeURIComponent(job.project_id)}/qc-reports`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ renderJobId: job.id, status: qc!.status, checks: qc!.checks }) }));
    return { asset: upload.asset, cover: cover.asset, qc };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function work(job: WorkerJob) {
  if (job.kind === 'ingestion') return workIngestion(job);
  if (job.kind === 'voice') return workVoice(job);
  if (job.kind === 'preview' || job.kind === 'render') return workRender(job);
  if (job.kind === 'publish') return workPublish(job);
  throw new Error(`Worker 不支持 ${job.kind} 作业。`);
}

async function finish(jobId: string, payload: unknown) {
  await json(await fetch(`${controlUrl}/api/v1/jobs/${encodeURIComponent(jobId)}/finish`, { method: 'POST', headers: workerHeaders, body: JSON.stringify(payload) }));
}

async function main() {
  process.stdout.write(`Signal 40 Render Worker ${workerId} connected to ${controlUrl}\n`);
  for (;;) {
    const response = await fetch(`${controlUrl}/api/v1/jobs/lease`, { method: 'POST', headers: workerHeaders, body: JSON.stringify({ workerId, kinds: ['ingestion', 'voice', 'preview', 'render', 'publish'], leaseSeconds: 900 }) });
    if (response.status === 204) { await new Promise((resolve) => setTimeout(resolve, 2000)); continue; }
    const { job } = await json<{ job: WorkerJob }>(response);
    try {
      const startedAt = Date.now();
      const result = await work(job);
      const measuredResult = result && typeof result === 'object' ? { ...result, durationMs: Date.now() - startedAt } : { value: result, durationMs: Date.now() - startedAt };
      await finish(job.id, { workerId, succeeded: true, result: measuredResult });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${job.id}: ${message}\n`);
      await finish(job.id, { workerId, succeeded: false, error: message });
    }
  }
}

await main();
