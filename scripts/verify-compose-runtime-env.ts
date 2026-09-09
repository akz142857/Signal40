import { spawnSync } from 'node:child_process';

type RuntimeProfile = 'control' | 'source' | 'render' | 'broker' | 'scheduler';

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const service = argument('--service');
const profile = argument('--profile') as RuntimeProfile | undefined;
if (!service || !/^[a-z][a-z0-9-]{0,63}$/.test(service)) throw new Error('--service 无效。');
if (!profile || !['control', 'source', 'render', 'broker', 'scheduler'].includes(profile)) {
  throw new Error('--profile 必须是 control/source/render/broker/scheduler。');
}

const visibility: Record<string, RuntimeProfile[]> = {
  S3_ACCESS_KEY_ID: ['control', 'scheduler'],
  S3_SECRET_ACCESS_KEY: ['control', 'scheduler'],
  OPENAI_API_KEY: ['render'],
  YOUTUBE_ACCESS_TOKEN: ['render'],
  SIGNAL40_SOURCE_WORKER_TOKEN: ['control', 'source', 'broker'],
  SIGNAL40_RENDER_WORKER_TOKEN: ['control', 'render'],
  SIGNAL40_WORKER_TOKEN: [],
  WORKER_TOKEN: [],
  SCHEDULER_TOKEN: ['control'],
  WEBHOOK_SECRET: ['control', 'scheduler'],
  MEDIA_SIGNING_SECRET: ['control'],
  BOOTSTRAP_ADMIN_EMAILS: ['control'],
  SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON: ['control', 'broker'],
  SIGNAL40_MARKET_DATA_KEY: ['broker'],
  SIGNAL40_AUTOMATION_ACTOR_ID: ['control', 'scheduler'],
  SIGNAL40_ATTENTION_WEBHOOK_URL: ['scheduler'],
};

const markers = Object.fromEntries(Object.keys(visibility).map((name) => [
  name,
  `signal40-runtime-canary-${name.toLowerCase().replaceAll('_', '-')}`,
]));

const containerCheck = `
const profile = process.argv[1];
const visibility = ${JSON.stringify(visibility)};
const markers = ${JSON.stringify(markers)};
for (const [name, allowedProfiles] of Object.entries(visibility)) {
  const occurrences = Object.values(process.env).filter((value) => value === markers[name]).length;
  const expected = allowedProfiles.includes(profile);
  if ((expected && occurrences < 1) || (!expected && occurrences !== 0)) process.exit(20);
}
const databaseExpected = ['control', 'broker', 'scheduler'].includes(profile);
if (Boolean(process.env.DATABASE_URL) !== databaseExpected) process.exit(21);
if (process.env.SIGNAL40_DEPLOYMENT_MODE !== 'development') process.exit(22);
`;

const childEnvironment = { ...process.env, ...markers };
const result = spawnSync('docker', [
  'compose', '--env-file', '/dev/null', 'run', '--rm', '--no-deps', '--entrypoint', 'node',
  service, '-e', containerCheck, profile,
], {
  encoding: 'utf8',
  env: childEnvironment,
  maxBuffer: 4 * 1024 * 1024,
});
if (result.status !== 0) {
  throw new Error(`${profile} 运行环境可见矩阵不匹配（容器退出 ${result.status ?? 'unknown'}）。`);
}
process.stdout.write(`${profile} 运行环境可见矩阵通过。\n`);
