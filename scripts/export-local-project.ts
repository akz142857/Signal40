import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { upgradeProjectV2Defaults, validateProjectV2, type VideoProjectV2 } from '../lib/project-v2.ts';

const [databaseInput, projectId, outputInput] = process.argv.slice(2);
if (!databaseInput || !projectId || !outputInput) {
  throw new Error('用法：npm run project:export-local -- <local-d1.sqlite> <project-id> <output.json>');
}
const databasePath = path.resolve(databaseInput);
if (!databasePath.includes(`${path.sep}.wrangler${path.sep}state${path.sep}`) || !databasePath.endsWith('.sqlite')) {
  throw new Error('只允许读取当前项目 .wrangler/state 下的本地 SQLite 数据库。');
}
const database = new DatabaseSync(databasePath, { readOnly: true });
let raw: string | undefined;
try {
  raw = (database.prepare('SELECT project_json FROM content_projects WHERE id = ? LIMIT 1').get(projectId) as { project_json?: string } | undefined)?.project_json;
} finally {
  database.close();
}
if (!raw) throw new Error(`项目 ${projectId} 不存在。`);
const project = upgradeProjectV2Defaults(JSON.parse(raw) as VideoProjectV2);
const validation = validateProjectV2(project);
if (!validation.valid) throw new Error(`项目协议无效：${validation.errors.join('；')}`);
const outputPath = path.resolve(outputInput);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(project, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ projectId, outputPath, snapshotHash: project.render.snapshotHash }, null, 2)}\n`);
