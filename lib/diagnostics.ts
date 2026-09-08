import type { SqlDatabase } from './sql.ts';
import type { ObjectStorage } from './storage.ts';
import { listWorkers, queueBacklog } from './workers.ts';

/**
 * 系统自检：把「配错了」和「没配」分开报，并给出下一步。
 *
 * 之前这些判定只在 `scripts/check-storage.ts` 里，界面上看不到，
 * 凭据配错只能从 500 错误往回猜。凭据类检查只报可用/不可用/未配置和原因，
 * **任何情况下都不回显密钥本身**。
 */

export type DiagnosticStatus = 'ok' | 'degraded' | 'failed' | 'unconfigured';

export type DiagnosticCheck = {
  id: string;
  label: string;
  status: DiagnosticStatus;
  detail: string;
  hint?: string;
};

const isHex = (value: string, length: number) => new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value);

/** 对象存储凭据的形状检查——不发请求，只看值本身对不对。 */
export function inspectStorageCredentials(env: {
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}): DiagnosticCheck {
  const problems: string[] = [];
  if (!env.endpoint) problems.push('S3_ENDPOINT 未设置。');
  if (!env.bucket) problems.push('S3_BUCKET 未设置。');
  let accountId = '';
  if (env.endpoint) {
    try {
      const url = new URL(env.endpoint);
      if (url.pathname !== '/' && url.pathname !== '') problems.push(`S3_ENDPOINT 末尾多了路径 "${url.pathname}"；端点只能是 https://<account_id>.r2.cloudflarestorage.com，桶名走 S3_BUCKET。`);
      accountId = url.hostname.split('.')[0];
    } catch {
      problems.push('S3_ENDPOINT 不是合法 URL。');
    }
  }
  const keyId = env.accessKeyId ?? '';
  const secret = env.secretAccessKey ?? '';
  if (!keyId) problems.push('S3_ACCESS_KEY_ID 未设置。');
  else if (!isHex(keyId, 32)) problems.push(`S3_ACCESS_KEY_ID 应为 32 位十六进制，实际是 ${keyId.length} 字符${/^cfat/i.test(keyId) ? '（这是 Token value，不是 Access Key ID）' : ''}。`);
  else if (accountId && keyId.toLowerCase() === accountId.toLowerCase()) problems.push('S3_ACCESS_KEY_ID 与端点里的 Account ID 相同——填成了 Account ID。');
  if (!secret) problems.push('S3_SECRET_ACCESS_KEY 未设置。');
  else if (!isHex(secret, 64)) problems.push(`S3_SECRET_ACCESS_KEY 应为 64 位十六进制，实际是 ${secret.length} 字符${/^cfat/i.test(secret) ? '（这是 Token value，不是 Secret Access Key）' : ''}。`);
  if (!env.endpoint && !env.bucket && !keyId && !secret) {
    return { id: 'storage_credentials', label: '对象存储凭据', status: 'unconfigured', detail: '未配置对象存储。', hint: '按 .env.example 填 S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY。' };
  }
  return problems.length
    ? { id: 'storage_credentials', label: '对象存储凭据', status: 'failed', detail: problems.join(' '), hint: 'R2 → Manage API Tokens 建 Object Read & Write Token；结果页的 Access Key ID 是 32 位 hex，Secret 是 64 位 hex，Token value（cfat…）不用。' }
    : { id: 'storage_credentials', label: '对象存储凭据', status: 'ok', detail: '取值形状正确。' };
}

async function checkDatabase(db: SqlDatabase): Promise<DiagnosticCheck[]> {
  try {
    const ready = await db.prepare('SELECT 1 AS ready').first<{ ready: number }>();
    const migrations = await db
      .prepare('SELECT tag FROM schema_migrations ORDER BY tag DESC LIMIT 1')
      .first<{ tag: string }>()
      .catch(() => null);
    return [
      { id: 'database', label: '数据库连通性', status: ready?.ready === 1 ? 'ok' : 'failed', detail: ready?.ready === 1 ? '连接正常。' : '查询未返回结果。' },
      migrations
        ? { id: 'migrations', label: '迁移版本', status: 'ok', detail: `已应用到 ${migrations.tag}。` }
        : { id: 'migrations', label: '迁移版本', status: 'degraded', detail: '读不到 schema_migrations，可能尚未执行 npm run db:migrate。', hint: '执行 npm run db:migrate。' },
    ];
  } catch (error) {
    return [{ id: 'database', label: '数据库连通性', status: 'failed', detail: error instanceof Error ? error.message : String(error), hint: '检查 DATABASE_URL 与数据库是否可达。' }];
  }
}

async function checkStorageRoundTrip(storage: ObjectStorage): Promise<DiagnosticCheck> {
  const key = `diagnostics/selfcheck-${crypto.randomUUID()}.txt`;
  try {
    await storage.put(key, new TextEncoder().encode('selfcheck'), { contentType: 'text/plain' });
    const read = await storage.get(key);
    // 读完响应体，否则未消费的流会一直占着连接。
    await read?.body.cancel().catch(() => undefined);
    await storage.delete([key]);
    if (!read) return { id: 'storage_roundtrip', label: '对象存储读写', status: 'failed', detail: '写入成功但读不回来。' };
    return { id: 'storage_roundtrip', label: '对象存储读写', status: 'ok', detail: '写入、读取、删除均成功。' };
  } catch (error) {
    return { id: 'storage_roundtrip', label: '对象存储读写', status: 'failed', detail: error instanceof Error ? error.message : String(error), hint: 'Token 需要 Object Read & Write 权限，且作用域包含该桶。' };
  }
}

function credentialCheck(id: string, label: string, value: string | undefined, hint: string): DiagnosticCheck {
  return value
    ? { id, label, status: 'ok', detail: '已配置。' }
    : { id, label, status: 'unconfigured', detail: '未配置。', hint };
}

export type DiagnosticsInput = {
  db: SqlDatabase;
  storage?: ObjectStorage;
  env: {
    s3Endpoint?: string;
    s3Bucket?: string;
    s3AccessKeyId?: string;
    s3SecretAccessKey?: string;
    openAiApiKey?: string;
    youtubeAccessToken?: string;
    workerToken?: string;
    schedulerToken?: string;
    mediaSigningSecret?: string;
    automationActorId?: string;
    allowPublicPublish?: boolean;
  };
  now?: Date;
};

export async function runDiagnostics(input: DiagnosticsInput) {
  const now = input.now ?? new Date();
  const checks: DiagnosticCheck[] = [...(await checkDatabase(input.db))];

  const credentials = inspectStorageCredentials({
    endpoint: input.env.s3Endpoint,
    bucket: input.env.s3Bucket,
    accessKeyId: input.env.s3AccessKeyId,
    secretAccessKey: input.env.s3SecretAccessKey,
  });
  checks.push(credentials);
  if (credentials.status === 'ok' && input.storage) checks.push(await checkStorageRoundTrip(input.storage));

  checks.push(credentialCheck('openai', 'OpenAI 凭据（配音与字幕对齐）', input.env.openAiApiKey, '不配就跑不了 voice 作业，其余流程不受影响。'));
  checks.push(credentialCheck('youtube', 'YouTube 凭据', input.env.youtubeAccessToken, '不配就只能用 package 渠道产出发布包。'));
  checks.push(credentialCheck('worker_token', 'Worker 令牌', input.env.workerToken, '控制面与 Worker 共用同一个令牌，见 .env.example。'));
  checks.push(credentialCheck('scheduler_token', '调度器令牌', input.env.schedulerToken, '手动触发编排的接口需要它。'));
  checks.push(credentialCheck('media_signing_secret', '媒体签名密钥', input.env.mediaSigningSecret, '不配就签不出短时效媒体 URL。'));
  checks.push({
    id: 'public_publish',
    label: '公开发布开关',
    status: input.env.allowPublicPublish ? 'degraded' : 'ok',
    detail: input.env.allowPublicPublish ? '已开启：YouTube 上传可以是非 private。' : '关闭：所有上传强制 private，这是发布的 fail-safe。',
  });

  const workers = await listWorkers(input.db, now);
  const online = workers.filter((worker) => worker.online);
  checks.push({
    id: 'workers',
    label: '在线 Worker',
    status: online.length ? 'ok' : 'failed',
    detail: online.length ? `${online.length} 个在线：${online.map((worker) => worker.id).join('、')}` : '没有在线 Worker，入队的作业不会被执行。',
    hint: online.length ? undefined : '启动 render-worker 服务（docker compose up -d render-worker 或 npm run worker）。',
  });

  const backlog = await queueBacklog(input.db);
  const waiting = backlog.reduce((sum, item) => sum + item.waiting, 0);
  const deadLetter = backlog.reduce((sum, item) => sum + item.deadLetter, 0);
  checks.push({
    id: 'queue',
    label: '队列积压',
    status: deadLetter > 0 ? 'degraded' : 'ok',
    detail: `等待 ${waiting}，死信 ${deadLetter}。`,
    hint: deadLetter > 0 ? '在 /inbox 或 /operations 处理死信作业。' : undefined,
  });

  const lastRun = await input.db
    .prepare('SELECT id, status, started_at FROM automation_runs ORDER BY started_at DESC LIMIT 1')
    .first<{ id: string; status: string; started_at: string }>()
    .catch(() => null);
  const ageSeconds = lastRun ? Math.round((now.valueOf() - new Date(lastRun.started_at).valueOf()) / 1000) : null;
  checks.push({
    id: 'scheduler',
    label: '调度器上次 tick',
    status: ageSeconds === null ? 'failed' : ageSeconds > 300 ? 'degraded' : 'ok',
    detail: ageSeconds === null ? '从未运行过；调度器进程可能没起来。' : `${ageSeconds} 秒前（${lastRun?.status}）。`,
    hint: ageSeconds === null || ageSeconds > 300 ? '启动 scheduler 服务（docker compose up -d scheduler 或 npm run scheduler）。' : undefined,
  });

  checks.push(
    input.env.automationActorId
      ? { id: 'automation_actor', label: '自动化服务账号', status: 'ok', detail: '已配置。' }
      : { id: 'automation_actor', label: '自动化服务账号', status: 'unconfigured', detail: '未配置，编排引擎不会做任何写入。', hint: '把 SIGNAL40_AUTOMATION_ACTOR_ID 指向 team_members 里一个 active 的 admin 成员。' },
  );

  const worst: DiagnosticStatus = checks.some((check) => check.status === 'failed')
    ? 'failed'
    : checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : 'ok';
  return { status: worst, checkedAt: now.toISOString(), checks, workers, backlog };
}
