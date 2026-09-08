import { stableHash } from '../lib/workflow.ts';

/**
 * 把一个项目沿状态机尽可能往下推，每一步打印门禁结果。
 *
 * 用于本地端到端验证：走到需要外部依赖（云端配音、渲染 Worker）的那一步会停下并说明原因，
 * 而不是假装成功。
 *
 * 用法：npm run walk -- <projectId> [目标状态]
 * 配音和渲染作业都必须在特定状态入队（SCRIPT_APPROVED / ASSETS_READY），
 * 所以要能在指定状态停住，而不是一路推到底。
 */

// 控制面地址：优先 SIGNAL40_API_URL，否则按本机 PORT 推导，
// 免得改一次端口要同步好几个变量。
const apiUrl = (process.env.SIGNAL40_API_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const projectId = process.argv[2];
const stopAt = process.argv[3];
if (!projectId) throw new Error('用法：npm run walk -- <projectId> [目标状态]');

type Json = Record<string, unknown>;

async function call(path: string, init: RequestInit & { role?: string } = {}) {
  const { role = 'admin', headers, ...rest } = init;
  const response = await fetch(`${apiUrl}${path}`, {
    ...rest,
    headers: { 'content-type': 'application/json', 'x-signal-role': role, ...(headers as Record<string, string>) },
  });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body: body as Json };
}

async function loadProject() {
  const result = await call(`/api/v1/projects/${projectId}`);
  if (result.status !== 200) throw new Error(`读取项目失败：HTTP ${result.status} ${JSON.stringify(result.body).slice(0, 200)}`);
  return (result.body.project ?? result.body) as Json;
}

async function gates() {
  const result = await call(`/api/v1/projects/${projectId}/gates`);
  return (result.body.gates ?? []) as Array<{ code: string; passed: boolean; reasons: string[] }>;
}

async function approve(kind: string, subjectHash: string, role: string, note: string) {
  const result = await call(`/api/v1/projects/${projectId}/approvals`, {
    method: 'POST',
    role,
    headers: { 'idempotency-key': `walk-${kind}-${subjectHash.slice(-12)}` },
    body: JSON.stringify({ kind, decision: 'approved', subjectHash, note }),
  });
  console.log(`  批准 ${kind}: HTTP ${result.status}${result.status >= 400 ? ' ' + JSON.stringify(result.body).slice(0, 160) : ''}`);
  return result.status < 400;
}

async function transition(to: string, role: string, note: string) {
  const project = await loadProject();
  const result = await call(`/api/v1/projects/${projectId}/transitions`, {
    method: 'POST',
    role,
    headers: { 'if-match': `"${String(project.version)}"` },
    body: JSON.stringify({ to, note }),
  });
  const ok = result.status < 400;
  console.log(`→ ${to} (${role}): HTTP ${result.status}${ok ? '' : '  ' + JSON.stringify(result.body).slice(0, 220)}`);
  return ok;
}

const project = await loadProject();
console.log(`项目 ${projectId} 当前状态：${String(project.state)} v${String(project.version)}\n`);

const content = project.project as Json;
const research = content.research as Json;
const script = content.script as Json;

const steps: Array<{ to: string; role: string; note: string; before?: () => Promise<boolean> }> = [
  { to: 'RESEARCHING', role: 'researcher', note: '真实数据端到端验证' },
  { to: 'EVIDENCE_READY', role: 'researcher', note: '证据齐备' },
  { to: 'EDITOR_APPROVED', role: 'editor', note: '研究通过编辑审阅',
    before: () => approve('research', String(research.approvedHash), 'editor', '真实数据验证：研究快照已审阅') },
  { to: 'SCRIPT_DRAFT', role: 'editor', note: '进入脚本阶段' },
  { to: 'SCRIPT_APPROVED', role: 'editor', note: '脚本通过审阅',
    before: () => approve('script', stableHash(script), 'editor', '真实数据验证：脚本已审阅') },
  { to: 'ASSETS_READY', role: 'producer', note: '资产就绪' },
];

// 从当前状态之后接着走：这个脚本是设计来反复运行的，
// 每次都从 DRAFT 重来只会在第一步撞 INVALID_TRANSITION。
const passed = steps.findIndex((step) => step.to === String(project.state));
const stopIndex = stopAt ? steps.findIndex((step) => step.to === stopAt) : steps.length - 1;
if (stopAt && stopIndex === -1) throw new Error(`目标状态 ${stopAt} 不在这个脚本覆盖的步骤里。`);
const pending = steps.slice(passed + 1, stopIndex + 1);
if (!pending.length) console.log('已经走到脚本覆盖的最后一步。');

for (const step of pending) {
  if (step.before) await step.before();
  if (!(await transition(step.to, step.role, step.note))) {
    console.log('\n在这一步停下。当前门禁：');
    for (const gate of await gates()) {
      console.log(`  ${gate.passed ? '通过' : '未过'}  ${gate.code}${gate.passed ? '' : '  ← ' + gate.reasons.join('；').slice(0, 110)}`);
    }
    break;
  }
}

const final = await loadProject();
console.log(`\n最终状态：${String(final.state)} v${String(final.version)}`);
