import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { VideoProjectV2 } from '../lib/project-v2.ts';
import { validateProjectV2 } from '../lib/project-v2.ts';

function capture(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args);
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', (data) => { output += String(data); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

const videoPath = process.argv[2];
const projectPath = process.argv[3];
if (!videoPath || !projectPath) throw new Error('用法：npm run qc:media -- <video.mp4> <project-v2.json>');
const project = JSON.parse(await fs.readFile(projectPath, 'utf8')) as VideoProjectV2;
const probe = JSON.parse(await capture('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath])) as { streams: Array<{ codec_type: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; bit_rate?: string }>; format: { duration?: string; bit_rate?: string } };
const duration = Number(probe.format.duration || 0);
const video = probe.streams.find((stream) => stream.codec_type === 'video');
const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
const black = await capture('ffmpeg', ['-hide_banner', '-i', videoPath, '-vf', 'blackdetect=d=1:pix_th=0.10:pic_th=0.98', '-an', '-f', 'null', '-']).catch((error: Error) => error.message);
const volume = await capture('ffmpeg', ['-hide_banner', '-i', videoPath, '-af', 'volumedetect', '-vn', '-f', 'null', '-']).catch((error: Error) => error.message);
const silence = await capture('ffmpeg', ['-hide_banner', '-i', videoPath, '-af', 'silencedetect=n=-45dB:d=1.5', '-vn', '-f', 'null', '-']).catch((error: Error) => error.message);
const meanVolume = Number(/mean_volume:\s*(-?[\d.]+) dB/.exec(volume)?.[1] ?? Number.NaN);
const maxVolume = Number(/max_volume:\s*(-?[\d.]+) dB/.exec(volume)?.[1] ?? Number.NaN);
const frameRateParts = (video?.avg_frame_rate ?? '0/1').split('/').map(Number);
const frameRate = frameRateParts[1] ? frameRateParts[0] / frameRateParts[1] : 0;
const schema = validateProjectV2(project);
const bitrate = Number(video?.bit_rate ?? probe.format.bit_rate ?? 0);
const silenceDurations = [...silence.matchAll(/silence_duration:\s*([\d.]+)/g)].map((match) => Number(match[1]));
const verifiableKinds = new Set(['fact', 'numeric', 'comparison', 'causal', 'prediction', 'analysis']);
const scriptText = project.script.lines.map((line) => line.text).join(' ');
const numericClaims = project.research.claims.filter((claim) => claim.kind === 'numeric' && claim.quantity);
const factualLineIds = new Set(project.script.lines.filter((line) => line.claimIds.some((id) => project.research.claims.some((claim) => claim.id === id && verifiableKinds.has(claim.kind)))).map((line) => line.id));
const frameDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'signal40-qc-frames-'));
const frameHashes: Array<{ sceneId: string; sha256: string; bytes: number }> = [];
try {
  for (const scene of project.timeline.slice(0, 12)) {
    const second = (scene.startFrame + Math.floor(scene.durationFrames / 2)) / project.render.fps;
    const framePath = path.join(frameDirectory, `${scene.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`);
    await capture('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', second.toFixed(3), '-i', videoPath, '-frames:v', '1', '-y', framePath]);
    const bytes = await fs.readFile(framePath);
    frameHashes.push({ sceneId: scene.id, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength });
  }
} finally {
  await fs.rm(frameDirectory, { recursive: true, force: true });
}
const checks = [
  { code: 'schema', passed: schema.valid, value: schema.errors },
  { code: 'duration', passed: Math.abs(duration - project.render.durationSeconds) <= 0.25, value: duration },
  { code: 'dimensions', passed: video?.width === project.render.width && video?.height === project.render.height, value: `${video?.width}x${video?.height}` },
  { code: 'frame-rate', passed: Math.abs(frameRate - project.render.fps) < 0.01, value: frameRate },
  { code: 'video-codec', passed: video?.codec_name === 'h264', value: video?.codec_name ?? 'missing' },
  { code: 'video-bitrate', passed: bitrate >= 150_000 && bitrate <= 20_000_000, value: bitrate },
  { code: 'audio-track', passed: Boolean(audio), value: audio?.codec_type || 'missing' },
  { code: 'audio-codec', passed: audio?.codec_name === 'aac', value: audio?.codec_name ?? 'missing' },
  { code: 'audio-loudness', passed: Number.isFinite(meanVolume) && meanVolume >= -35 && meanVolume <= -6 && maxVolume <= 0, value: { meanVolume, maxVolume } },
  { code: 'audio-silence', passed: silenceDurations.every((value) => value <= 3), value: silenceDurations },
  { code: 'black-frame', passed: !black.includes('black_start'), value: black.includes('black_start') ? 'detected' : 'none' },
  { code: 'caption-bounds', passed: project.captions.every((caption) => caption.startMs >= 0 && caption.endMs > caption.startMs && caption.endMs <= project.render.durationSeconds * 1000), value: project.captions.length },
  { code: 'caption-readability', passed: project.captions.every((caption) => Array.from(caption.text).length <= 18 && caption.endMs - caption.startMs >= 120), value: { maxCharacters: Math.max(0, ...project.captions.map((caption) => Array.from(caption.text).length)), minimumDurationMs: Math.min(...project.captions.map((caption) => caption.endMs - caption.startMs)) } },
  { code: 'caption-safe-area', passed: project.captions.every((caption) => caption.safeArea.left >= 48 && caption.safeArea.right >= 48 && caption.safeArea.top >= 96 && caption.safeArea.bottom >= 180), value: project.captions.map((caption) => caption.safeArea) },
  { code: 'font-availability', passed: project.visuals.every((visual) => typeof visual.spec.fontAssetId !== 'string' || project.assets.some((asset) => asset.id === visual.spec.fontAssetId && asset.mediaType === 'font/woff2' && asset.rightsStatus === 'cleared')), value: project.visuals.map((visual) => visual.spec.fontAssetId).filter(Boolean) },
  { code: 'asset-rights', passed: project.assets.every((asset) => asset.rightsStatus === 'cleared'), value: project.assets.map((asset) => asset.rightsStatus) },
  { code: 'music-mix', passed: !project.audio.music || (project.audio.music.volume >= 0 && project.audio.music.volume <= 0.5 && project.assets.some((asset) => asset.id === project.audio.music?.assetId && asset.rightsStatus === 'cleared')), value: project.audio.music ? { assetId: project.audio.music.assetId, volume: project.audio.music.volume, targetLufs: project.audio.mix?.targetLufs ?? -16 } : 'none' },
  { code: 'fact-coverage', passed: project.research.claims.filter((claim) => verifiableKinds.has(claim.kind)).every((claim) => project.script.lines.some((line) => line.claimIds.includes(claim.id))), value: project.research.claims.length },
  { code: 'source-footnote-readability', passed: project.timeline.every((scene) => !scene.narrationLineIds.some((id) => factualLineIds.has(id)) || scene.sourceFootnote.trim().length >= 2), value: project.timeline.map((scene) => ({ sceneId: scene.id, sourceFootnote: scene.sourceFootnote })) },
  { code: 'numeric-script-consistency', passed: numericClaims.every((claim) => scriptText.includes(String(claim.quantity!.value))), value: numericClaims.map((claim) => ({ claimId: claim.id, value: claim.quantity!.value })) },
  { code: 'prohibited-language', passed: !/(稳赚|保本|必涨|必跌|零风险|guaranteed returns?)/iu.test(scriptText), value: '稳赚/保本/必涨/必跌/零风险/guaranteed return' },
  { code: 'finance-disclaimer', passed: project.script.disclaimer.trim().length >= 10 && project.script.disclaimer.includes('不构成') && project.script.disclaimer.includes('投资建议'), value: project.script.disclaimer },
  { code: 'key-scene-snapshots', passed: frameHashes.length === Math.min(12, project.timeline.length) && frameHashes.every((frame) => frame.bytes > 10_000), value: frameHashes },
  { code: 'cryptographic-snapshot', passed: /^sha256:[a-f0-9]{64}$/.test(project.render.snapshotHash), value: project.render.snapshotHash },
];
const report = { status: checks.every((check) => check.passed) ? 'passed' : 'failed', videoPath, projectId: project.identity.projectId, snapshotHash: project.render.snapshotHash, checks };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'passed') process.exitCode = 2;
