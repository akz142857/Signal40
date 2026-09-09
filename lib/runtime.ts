import pg from 'pg';
import { configurePgTypeParsers, createPgDatabase } from './sql-pg.ts';
import type { SqlDatabase } from './sql.ts';
import type { ObjectStorage } from './storage.ts';
import { controlPlaneWorkerTokens } from './workload-env.ts';
import { createS3Client, createS3Storage } from './storage-s3.ts';
import { resolveActor, type Actor } from './workflow.ts';

/**
 * 运行时装配层——路由拿到的是 `db` / `storage` / `config` 三个后端无关的入口，
 * 不知道连接池和对象存储是怎么建起来的。整个仓库只有这个文件读 `process.env`。
 *
 * 连接池和 S3 客户端都惰性建立：模块加载时不碰网络，
 * 构建期和只读路由不会平白开一条数据库连接。
 */

// int8（COUNT/SUM）默认按字符串返回，必须在建池之前改掉，否则 `total > 0` 这类判断会静默失效。
configurePgTypeParsers(pg.types);

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`环境变量 ${name} 必填。`);
  return value;
}

let pool: pg.Pool | null = null;
let database: SqlDatabase | null = null;

function resolveDatabase() {
  if (!database) {
    pool = new pg.Pool({
      connectionString: required('DATABASE_URL'),
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      // 控制面的查询都很短；连接卡住不如快速失败让上游重试。
      connectionTimeoutMillis: Number(process.env.DATABASE_CONNECT_TIMEOUT_MS ?? 5_000),
      idleTimeoutMillis: 30_000,
    });
    database = createPgDatabase(pool);
  }
  return database;
}

/** 控制面数据库。 */
export const db: SqlDatabase = {
  prepare: (sql) => resolveDatabase().prepare(sql),
  batch: (statements) => resolveDatabase().batch(statements),
  transaction: (run) => resolveDatabase().transaction(run),
};

/** 进程退出前释放连接池；供脚本和优雅停机使用。 */
export async function closeDatabase() {
  const current = pool;
  pool = null;
  database = null;
  await current?.end();
}

let storageInstance: ObjectStorage | null = null;

function resolveStorage() {
  if (!storageInstance) {
    storageInstance = createS3Storage({
      bucket: required('S3_BUCKET'),
      client: createS3Client({
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE ? process.env.S3_FORCE_PATH_STYLE === 'true' : undefined,
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        checksumMode: process.env.S3_CHECKSUM_MODE === 'WHEN_SUPPORTED' ? 'WHEN_SUPPORTED' : 'WHEN_REQUIRED',
      }),
    });
  }
  return storageInstance;
}

/** 媒体对象存储。 */
export const storage: ObjectStorage = {
  get: (key) => resolveStorage().get(key),
  put: (key, data, options) => resolveStorage().put(key, data, options),
  delete: (keys) => resolveStorage().delete(keys),
  list: (options) => resolveStorage().list(options),
  createMultipartUpload: (key, options) => resolveStorage().createMultipartUpload(key, options),
  resumeMultipartUpload: (key, uploadId) => resolveStorage().resumeMultipartUpload(key, uploadId),
};

/**
 * 非绑定类配置。密钥缺失时返回 undefined 而不是抛错——
 * 各个鉴权函数自己决定「未配置」意味着拒绝还是本地放行，这个语义不能在这里替它们定。
 */
export const config = {
  get bootstrapAdminEmails() {
    return process.env.BOOTSTRAP_ADMIN_EMAILS ?? '';
  },
  get workerToken() {
    return controlPlaneWorkerTokens(process.env).shared;
  },
  /** 采集服务专用令牌；共享令牌回退只允许本机开发模式。 */
  get sourceWorkerToken() {
    return controlPlaneWorkerTokens(process.env).source;
  },
  /** 渲染/发布服务专用令牌；生产不接受共享令牌回退。 */
  get renderWorkerToken() {
    return controlPlaneWorkerTokens(process.env).render;
  },
  get schedulerToken() {
    return process.env.SCHEDULER_TOKEN;
  },
  get webhookSecret() {
    return process.env.WEBHOOK_SECRET;
  },
  get mediaSigningSecret() {
    return process.env.MEDIA_SIGNING_SECRET;
  },
  get renderConcurrencyLimit() {
    return process.env.RENDER_CONCURRENCY_LIMIT;
  },
  get monthlyRenderBudgetMicros() {
    return process.env.MONTHLY_RENDER_BUDGET_MICROS;
  },
  /**
   * 编排引擎的服务账号。必须指向 `team_members` 里一个 active 且角色为 admin 的成员——
   * 自动化不能凭空构造身份，配错或没配时引擎一律不写入（失败方向是关，不是开）。
   */
  get automationActorId() {
    return process.env.SIGNAL40_AUTOMATION_ACTOR_ID;
  },
  /** 待办箱外部通知地址；不配就只在界面里能看到待办。 */
  get attentionWebhookUrl() {
    return process.env.SIGNAL40_ATTENTION_WEBHOOK_URL;
  },
  /**
   * 反向代理注入身份头时用的头名。默认沿用 OpenAI Sites 时期的 `oai-authenticated-user-*`，
   * 自建部署把认证代理配成注入自己的头名即可，不用改代码。
   */
  get identityHeaders() {
    return {
      id: process.env.SIGNAL40_IDENTITY_HEADER_ID || 'oai-authenticated-user-id',
      email: process.env.SIGNAL40_IDENTITY_HEADER_EMAIL || 'oai-authenticated-user-email',
    };
  },
  /**
   * 是否允许本机请求用 `x-signal-role` 伪造角色。生产部署必须置为 false：
   * 身份由前端说了算时，G7 的「独立发布人」就不成立。
   */
  get allowLocalRoleHeaders() {
    return (process.env.SIGNAL40_ALLOW_LOCAL_ROLE_HEADERS ?? 'true') !== 'false';
  },
};

/**
 * 路由侧的身份解析入口。`resolveActor` 本身保持参数化（测试要注入假 db），
 * 这里只是把「数据库 + 引导管理员邮箱」这对固定实参收拢起来。
 */
export function resolveRequestActor(request: Request): Promise<Actor | null> {
  return resolveActor(request, db, {
    bootstrapAdminEmails: config.bootstrapAdminEmails,
    identityHeaders: config.identityHeaders,
    allowLocalRoleHeaders: config.allowLocalRoleHeaders,
  });
}
