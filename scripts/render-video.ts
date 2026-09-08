import fs from 'node:fs/promises';
import path from 'node:path';
import { migrateProjectV1, validateProjectV2, type VideoProjectV2 } from '../lib/project-v2.ts';
import { renderProject } from '../render-worker/render.ts';
import { resolveOutputPath } from './output-path.ts';

const inputPath = process.argv[2];
const outputPath = resolveOutputPath(process.argv[3] || 'output/signal40.mp4');
if (!inputPath) throw new Error('用法：npm run render -- <project.json> [output.mp4]');
const raw = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8')) as VideoProjectV2 | Parameters<typeof migrateProjectV1>[0];
const project = 'schemaVersion' in raw ? raw : migrateProjectV1(raw);
const validation = validateProjectV2(project);
if (!validation.valid) throw new Error(`项目协议无效：${validation.errors.join('；')}`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
const result = await renderProject(project, outputPath);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
