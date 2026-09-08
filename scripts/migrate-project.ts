import fs from 'node:fs/promises';
import path from 'node:path';
import { migrateProjectV1, validateProjectV2, type VideoProjectV2 } from '../lib/project-v2.ts';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error('用法：npm run project:migrate -- <v1.json> <v2.json>');
const raw = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8')) as VideoProjectV2 | Parameters<typeof migrateProjectV1>[0];
const project = 'schemaVersion' in raw ? raw : migrateProjectV1(raw);
const validation = validateProjectV2(project);
if (!validation.valid) throw new Error(validation.errors.join('；'));
await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
await fs.writeFile(path.resolve(outputPath), `${JSON.stringify(project, null, 2)}\n`);
process.stdout.write(`${path.resolve(outputPath)}\n`);
