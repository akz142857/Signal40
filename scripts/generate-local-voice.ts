import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeRenderSnapshotHash, upgradeProjectV2Defaults, validateProjectV2, type VideoProjectV2 } from '../lib/project-v2.ts';

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

const inputPath = process.argv[2];
const outputPath = path.resolve(process.argv[3] || 'public/generated/signal40-voice.m4a');
const updatedProjectPath = path.resolve(process.argv[4] || 'output/project.with-voice.json');
if (!inputPath) throw new Error('用法：npm run voice:local -- <project-v2.json> [public/generated/voice.m4a] [updated-project.json]');
const project = upgradeProjectV2Defaults(JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8')) as VideoProjectV2);
const text = project.script.lines.map((line) => line.text).join('。');
const aiff = outputPath.replace(/\.[^.]+$/, '.aiff');
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await run('/usr/bin/say', ['-v', process.env.SIGNAL40_LOCAL_VOICE || 'Tingting', '-r', '220', '-o', aiff, text]);
await run('ffmpeg', ['-y', '-i', aiff, '-c:a', 'aac', '-b:a', '192k', outputPath]);
await fs.unlink(aiff);
const audioSha256 = createHash('sha256').update(await fs.readFile(outputPath)).digest('hex');
const probe = await new Promise<string>((resolve, reject) => {
  let output = '';
  const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', outputPath]);
  child.stdout.on('data', (data) => { output += String(data); });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`ffprobe 退出码 ${code}`)));
});
const durationMs = Math.round(Number(probe) * 1000);
if (!Number.isFinite(durationMs) || durationMs < 500) {
  throw new Error('TTS 供应商返回了空音频或无法探测时长，已阻止进入渲染。');
}
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const weights = project.script.lines.map((line) => Math.max(1, Array.from(segmenter.segment(line.text)).length));
const totalWeight = weights.reduce((sum, value) => sum + value, 0);
let cursor = 0;
project.captions = project.script.lines.flatMap((line, index) => {
  const characters = Array.from(line.text);
  const chunks = Array.from({ length: Math.ceil(characters.length / 18) }, (_, chunkIndex) => characters.slice(chunkIndex * 18, (chunkIndex + 1) * 18).join(''));
  const lineDuration = durationMs * weights[index] / totalWeight;
  return chunks.map((text) => {
    const startMs = Math.round(cursor);
    cursor += lineDuration * Math.max(1, Array.from(text).length) / weights[index];
    return { startMs, endMs: Math.min(durationMs, Math.round(cursor)), text, lineId: line.id, granularity: 'sentence' as const, style: line.id.includes('takeaway') ? 'disclaimer' as const : 'default' as const, safeArea: { left: 72, right: 72, top: 160, bottom: 280 }, manuallyEdited: false };
  });
});
project.audio = {
  ...project.audio,
  provider: 'macos-say-local',
  voice: process.env.SIGNAL40_LOCAL_VOICE || 'Tingting',
  objectKey: path.relative(path.resolve('public'), outputPath),
  durationMs,
  speed: 220 / 200,
  pronunciationDictionary: Object.assign({}, ...project.script.lines.map((line) => line.pronunciationHints)),
  sha256: audioSha256,
  fallbackProvider: null,
  estimatedCostMicros: 0,
};
const renderHash = computeRenderSnapshotHash(project);
project.render.snapshotHash = renderHash;
project.provenance.immutableInputsHash = renderHash;
const validation = validateProjectV2(project);
if (!validation.valid) throw new Error(`生成配音后的项目协议无效：${validation.errors.join('；')}`);
await fs.mkdir(path.dirname(updatedProjectPath), { recursive: true });
await fs.writeFile(updatedProjectPath, `${JSON.stringify(project, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ audio: outputPath, audioSha256, project: updatedProjectPath, durationMs, captions: project.captions.length }, null, 2)}\n`);
