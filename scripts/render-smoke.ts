import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runPipeline } from '../lib/domain.ts';
import { computeRenderSnapshotHash, createProjectV2 } from '../lib/project-v2.ts';
import { sampleArticles } from '../lib/sample-data.ts';
import { VIDEO_TEMPLATES } from '../lib/templates.ts';
import { renderProject } from '../render-worker/render.ts';

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

const now = new Date('2026-09-08T00:00:00.000Z');
const topic = runPipeline(sampleArticles(now), now).find((candidate) => candidate.gate.passed);
if (!topic) throw new Error('Smoke fixture did not produce a gated topic.');
const project = createProjectV2({ ...topic, verificationStatus: 'verified' }, now);
project.render.durationSeconds = 2;
project.script.targetDurationSeconds = 2;
project.timeline = [{ ...project.timeline[0], startFrame: 0, durationFrames: 60 }];
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'signal40-smoke-'));
const previewOutput = path.join(directory, 'smoke-preview.mp4');
try {
  const templateResults: Array<{ id: string; bytes: number; sha256: string }> = [];
  for (const template of VIDEO_TEMPLATES) {
    const candidate = structuredClone(project);
    candidate.render.templateId = template.id;
    candidate.render.templateVersion = template.version;
    candidate.render.snapshotHash = computeRenderSnapshotHash(candidate);
    candidate.provenance.immutableInputsHash = candidate.render.snapshotHash;
    const output = path.join(directory, `smoke-${template.id}.mp4`);
    await renderProject(candidate, output);
    const probe = JSON.parse(await capture('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration?: string } };
    const video = probe.streams.find((stream) => stream.codec_type === 'video');
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio');
    if (video?.width !== 1080 || video.height !== 1920 || !audio || Math.abs(Number(probe.format.duration) - 2) > 0.25) throw new Error(`Render smoke probe failed for ${template.id}: ${JSON.stringify(probe)}`);
    const bytes = await fs.readFile(output);
    templateResults.push({ id: template.id, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  if (new Set(templateResults.map((item) => item.sha256)).size !== VIDEO_TEMPLATES.length) throw new Error('模板渲染结果没有视觉差异。');
  const finalOutput = path.join(directory, `smoke-${VIDEO_TEMPLATES[0].id}.mp4`);
  const previewRendered = await renderProject(project, previewOutput, { profile: 'preview' });
  const previewProbe = JSON.parse(await capture('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', previewOutput])) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration?: string } };
  const previewVideo = previewProbe.streams.find((stream) => stream.codec_type === 'video');
  const previewAudio = previewProbe.streams.find((stream) => stream.codec_type === 'audio');
  if (previewVideo?.width !== 1080 || previewVideo.height !== 1920 || !previewAudio || Math.abs(Number(previewProbe.format.duration) - 2) > 0.25) throw new Error(`Preview render smoke probe failed: ${JSON.stringify(previewProbe)}`);
  const [finalStats, previewStats] = await Promise.all([fs.stat(finalOutput), fs.stat(previewOutput)]);
  if (previewStats.size >= finalStats.size) throw new Error(`Preview should be lower bitrate than final: preview=${previewStats.size}, final=${finalStats.size}`);
  process.stdout.write(`${JSON.stringify({ status: 'passed', templates: templateResults, preview: { ...previewRendered, bytes: previewStats.size, duration: Number(previewProbe.format.duration) } })}\n`);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
