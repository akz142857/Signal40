import fs from 'node:fs/promises';
import pg from 'pg';
import { upgradeProjectV2Defaults, validateProjectV2, type VideoProjectV2 } from '../lib/project-v2.ts';
import { resolveOutputPath } from './output-path.ts';

/** 把控制面里的一个项目导出成本地 project.json，供本地渲染流水线使用。 */

const [projectId, outputInput] = process.argv.slice(2);
if (!projectId || !outputInput) {
  throw new Error('用法：npm run project:export-local -- <project-id> <output.json>');
}
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('环境变量 DATABASE_URL 必填。');

const client = new pg.Client({ connectionString });
await client.connect();
let raw: string | undefined;
try {
  const result = await client.query<{ project_json: string }>(
    'SELECT project_json FROM content_projects WHERE id = $1 LIMIT 1',
    [projectId],
  );
  raw = result.rows[0]?.project_json;
} finally {
  await client.end();
}
if (!raw) throw new Error(`项目 ${projectId} 不存在。`);

const project = upgradeProjectV2Defaults(JSON.parse(raw) as VideoProjectV2);
const validation = validateProjectV2(project);
if (!validation.valid) throw new Error(`项目协议无效：${validation.errors.join('；')}`);
const outputPath = resolveOutputPath(outputInput);
await fs.mkdir(outputPath.slice(0, outputPath.lastIndexOf('/')), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(project, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ projectId, outputPath, snapshotHash: project.render.snapshotHash }, null, 2)}\n`);
