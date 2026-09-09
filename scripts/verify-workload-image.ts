import { spawn, spawnSync } from 'node:child_process';

type Profile = 'control' | 'source' | 'render' | 'broker';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const image = argument('--image');
const profile = argument('--profile') as Profile | undefined;
const canary = process.env.SIGNAL40_IMAGE_SCAN_CANARY;

if (!image || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) {
  throw new Error('--image 必须是明确且安全的本地镜像引用。');
}
if (!profile || !['control', 'source', 'render', 'broker'].includes(profile)) {
  throw new Error('--profile 必须是 control/source/render/broker。');
}
if (!canary || canary.length < 16) {
  throw new Error('SIGNAL40_IMAGE_SCAN_CANARY 必须是至少 16 字符的非生产测试值。');
}

function docker(args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} 失败：${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  return result.stdout;
}

const inspect = JSON.parse(docker(['image', 'inspect', image])) as Array<{
  Config?: { User?: string; Env?: string[] };
}>;
const config = inspect[0]?.Config;
if (!config || !config.User || config.User === '0' || config.User === 'root') {
  throw new Error(`${profile} 镜像必须声明非 root USER。`);
}
const environment = config.Env ?? [];
if (!environment.includes('SIGNAL40_DEPLOYMENT_MODE=production')) {
  throw new Error(`${profile} 镜像必须默认 SIGNAL40_DEPLOYMENT_MODE=production。`);
}
const forbiddenEnvironment: Record<Profile, string[]> = {
  control: ['SIGNAL40_MARKET_DATA_KEY', 'OPENAI_API_KEY', 'YOUTUBE_ACCESS_TOKEN'],
  source: ['DATABASE_URL', 'S3_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'YOUTUBE_ACCESS_TOKEN'],
  render: ['DATABASE_URL', 'S3_SECRET_ACCESS_KEY', 'SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON'],
  broker: ['S3_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'YOUTUBE_ACCESS_TOKEN', 'SIGNAL40_RENDER_WORKER_TOKEN'],
};
for (const name of forbiddenEnvironment[profile]) {
  if (environment.some((value) => value.startsWith(`${name}=`))) {
    throw new Error(`${profile} 镜像默认环境包含越界变量 ${name}。`);
  }
}

const rootfsChecks: Record<Profile, string[]> = {
  control: [
    'test ! -e /app/.env',
    'test ! -d /app/render-worker',
    'test ! -d /app/video',
    '! command -v chromium',
    '! command -v ffmpeg',
  ],
  source: [
    'test ! -e /app/.env',
    'test ! -e /app/render-worker/render.ts',
    'test ! -d /app/video',
    'test ! -e /app/scripts/media-qc.ts',
    '! command -v chromium',
    '! command -v ffmpeg',
  ],
  render: [
    'test ! -e /app/.env',
    'command -v chromium >/dev/null',
    'command -v ffmpeg >/dev/null',
  ],
  broker: [
    'test ! -e /app/.env',
    'test ! -d /app/render-worker',
    'test ! -d /app/video',
    'test ! -e /app/scripts/media-qc.ts',
    '! command -v chromium',
    '! command -v ffmpeg',
  ],
};
docker(['run', '--rm', '--entrypoint', 'sh', image, '-c', [
  'test "$(id -u)" != 0',
  'test ! -d /root/.aws',
  'test ! -d /root/.config/gcloud',
  'test ! -d /root/.azure',
  ...rootfsChecks[profile],
].join(' && ')]);

const encodedCanaries = [
  canary,
  Buffer.from(canary).toString('base64'),
  Buffer.from(canary).toString('hex'),
  encodeURIComponent(canary),
].map((value) => Buffer.from(value));

function assertNoCanary(buffer: Buffer, where: string) {
  if (encodedCanaries.some((candidate) => buffer.includes(candidate))) {
    throw new Error(`${profile} 镜像的 ${where} 命中 canary 或其常见编码。`);
  }
}

assertNoCanary(Buffer.from(JSON.stringify(inspect)), 'config');
assertNoCanary(Buffer.from(docker(['history', '--no-trunc', '--format', '{{.CreatedBy}}', image])), 'history');

await new Promise<void>((resolve, reject) => {
  const child = spawn('docker', ['image', 'save', image], { stdio: ['ignore', 'pipe', 'pipe'] });
  const maxLength = Math.max(...encodedCanaries.map((value) => value.length));
  let carry = Buffer.alloc(0);
  let stderr = '';
  let failed = false;
  child.stdout.on('data', (chunk: Buffer) => {
    const combined = Buffer.concat([carry, chunk]);
    try {
      assertNoCanary(combined, 'layer archive');
    } catch (error) {
      failed = true;
      child.kill('SIGTERM');
      reject(error);
      return;
    }
    carry = combined.subarray(Math.max(0, combined.length - maxLength + 1));
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-1_000);
  });
  child.on('error', reject);
  child.on('close', (code) => {
    if (failed) return;
    if (code !== 0) reject(new Error(`docker image save 失败：${stderr.trim().slice(0, 500)}`));
    else resolve();
  });
});

process.stdout.write(`${profile} 镜像边界验证通过。\n`);
