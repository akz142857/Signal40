type Environment = Record<string, string | undefined>;

export type WorkerProfile = 'source' | 'render' | 'combined';

const SOURCE_FORBIDDEN = [
  'DATABASE_URL',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'OPENAI_API_KEY',
  'YOUTUBE_ACCESS_TOKEN',
  'SCHEDULER_TOKEN',
  'WEBHOOK_SECRET',
  'MEDIA_SIGNING_SECRET',
  'BOOTSTRAP_ADMIN_EMAILS',
  'SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON',
] as const;

const RENDER_FORBIDDEN = [
  'DATABASE_URL',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'SCHEDULER_TOKEN',
  'WEBHOOK_SECRET',
  'MEDIA_SIGNING_SECRET',
  'BOOTSTRAP_ADMIN_EMAILS',
  'SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON',
  'SIGNAL40_SOURCE_WORKER_TOKEN',
] as const;

const BROKER_FORBIDDEN = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'OPENAI_API_KEY',
  'YOUTUBE_ACCESS_TOKEN',
  'SCHEDULER_TOKEN',
  'WEBHOOK_SECRET',
  'MEDIA_SIGNING_SECRET',
  'BOOTSTRAP_ADMIN_EMAILS',
  'SIGNAL40_RENDER_WORKER_TOKEN',
  'SIGNAL40_AUTOMATION_ACTOR_ID',
] as const;

function present(env: Environment, name: string) {
  return typeof env[name] === 'string' && env[name]!.length > 0;
}

export function resolveWorkerEnvironment(env: Environment) {
  const production = env.SIGNAL40_DEPLOYMENT_MODE === 'production';
  const profile: WorkerProfile = env.SIGNAL40_WORKER_PROFILE === 'source'
    ? 'source'
    : env.SIGNAL40_WORKER_PROFILE === 'render'
      ? 'render'
      : 'combined';
  if (production && profile === 'combined') {
    throw new Error('生产环境禁止 combined Worker；必须显式选择 source 或 render profile。');
  }
  if (production && (present(env, 'SIGNAL40_WORKER_TOKEN') || present(env, 'WORKER_TOKEN'))) {
    throw new Error('生产环境禁止共享 Worker token。');
  }
  const token = profile === 'source'
    ? env.SIGNAL40_SOURCE_WORKER_TOKEN || (!production ? env.SIGNAL40_WORKER_TOKEN : undefined)
    : profile === 'render'
      ? env.SIGNAL40_RENDER_WORKER_TOKEN || (!production ? env.SIGNAL40_WORKER_TOKEN : undefined)
      : env.SIGNAL40_WORKER_TOKEN;
  if (!env.SIGNAL40_CONTROL_URL || !token) {
    throw new Error('Worker 缺少控制面地址或对应 profile 的专用令牌。');
  }
  if (production) {
    const forbidden = profile === 'source' ? SOURCE_FORBIDDEN : RENDER_FORBIDDEN;
    const leaked = forbidden.filter((name) => present(env, name));
    if (leaked.length) throw new Error(`${profile} Worker 环境包含越界变量：${leaked.join(', ')}`);
  }
  return { production, profile, token, controlUrl: env.SIGNAL40_CONTROL_URL.replace(/\/$/, '') };
}

export function controlPlaneWorkerTokens(env: Environment) {
  const production = env.SIGNAL40_DEPLOYMENT_MODE === 'production';
  if (production && (present(env, 'SIGNAL40_WORKER_TOKEN') || present(env, 'WORKER_TOKEN'))) {
    throw new Error('生产控制面禁止配置共享 Worker token。');
  }
  return {
    shared: production ? undefined : env.WORKER_TOKEN || env.SIGNAL40_WORKER_TOKEN,
    source: env.SIGNAL40_SOURCE_WORKER_TOKEN || (!production ? env.WORKER_TOKEN || env.SIGNAL40_WORKER_TOKEN : undefined),
    render: env.SIGNAL40_RENDER_WORKER_TOKEN || (!production ? env.WORKER_TOKEN || env.SIGNAL40_WORKER_TOKEN : undefined),
  };
}

export function resolveCredentialBrokerEnvironment(env: Environment) {
  const production = env.SIGNAL40_DEPLOYMENT_MODE === 'production';
  if (production && (present(env, 'SIGNAL40_WORKER_TOKEN') || present(env, 'WORKER_TOKEN'))) {
    throw new Error('生产 Credential Broker 禁止配置共享 Worker token。');
  }
  if (production) {
    const leaked = BROKER_FORBIDDEN.filter((name) => present(env, name));
    if (leaked.length) throw new Error(`Credential Broker 环境包含越界变量：${leaked.join(', ')}`);
  }
  const sourceWorkerToken = env.SIGNAL40_SOURCE_WORKER_TOKEN || (!production ? env.SIGNAL40_WORKER_TOKEN : undefined);
  if (!env.DATABASE_URL || !sourceWorkerToken) {
    throw new Error('Credential Broker 缺少数据库连接或 source Worker 专用令牌。');
  }
  return {
    production,
    sourceWorkerToken,
    policiesJson: env.SIGNAL40_SOURCE_CREDENTIAL_POLICIES_JSON ?? '{}',
    port: Math.max(1, Math.min(65_535, Number(env.PORT ?? 3002) || 3002)),
  };
}
