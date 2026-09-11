/**
 * `@/lib/runtime` 的测试替身。
 *
 * 真 runtime 在模块加载时就建 PostgreSQL 连接池和 S3 客户端，路由一 import
 * 就会连真库，所以路由里的 SQL 一直没被自动化测试执行过——两条必然失败的
 * INSERT（team_members 8 列 9 值、source_configs 33 列 31 值）因此通过了
 * lint、tsc 和全部测试。见 R-ROUTE-SQL-01。
 *
 * 这里只替换「连接从哪来」和「身份怎么解析」，`db` 背后是 PGlite 上按
 * `drizzle/` 建好的真 PostgreSQL：路由的 SQL 会被真正执行、真正报错。
 */

import type { Actor } from '../lib/workflow.ts';
import type { SqlDatabase } from '../lib/sql.ts';
import type { ObjectStorage } from '../lib/storage.ts';

type RouteTestContext = {
  db: SqlDatabase;
  actor: Actor | null;
  storage?: ObjectStorage;
  config?: {
    workerToken?: string;
    sourceWorkerToken?: string;
    renderWorkerToken?: string;
    automationActorId?: string;
  };
};

let context: RouteTestContext | null = null;

export function setRouteTestContext(next: RouteTestContext) {
  context = next;
}

export function setRouteTestActor(actor: Actor | null) {
  if (!context) throw new Error('必须先调用 setRouteTestContext。');
  context.actor = actor;
}

function required() {
  if (!context) throw new Error('路由测试未初始化：请先调用 setRouteTestContext。');
  return context;
}

export const db: SqlDatabase = {
  prepare: (sql) => required().db.prepare(sql),
  batch: (statements) => required().db.batch(statements),
  transaction: (run) => required().db.transaction(run),
};

export async function closeDatabase() {}

export const storage = {
  put: (...args: Parameters<ObjectStorage['put']>) => required().storage?.put(...args) ?? Promise.reject(new Error('路由测试未提供对象存储。')),
  get: (...args: Parameters<ObjectStorage['get']>) => required().storage?.get(...args) ?? Promise.reject(new Error('路由测试未提供对象存储。')),
  delete: (...args: Parameters<ObjectStorage['delete']>) => required().storage?.delete(...args) ?? Promise.reject(new Error('路由测试未提供对象存储。')),
  list: (...args: Parameters<ObjectStorage['list']>) => required().storage?.list(...args) ?? Promise.reject(new Error('路由测试未提供对象存储。')),
  createMultipartUpload: (...args: Parameters<ObjectStorage['createMultipartUpload']>) => required().storage?.createMultipartUpload(...args) ?? Promise.reject(new Error('路由测试未提供对象存储。')),
  resumeMultipartUpload: (...args: Parameters<ObjectStorage['resumeMultipartUpload']>) => required().storage?.resumeMultipartUpload(...args) ?? Promise.reject(new Error('路由测试未提供对象存储。')),
} as never;

export const config = {
  get bootstrapAdminEmails() { return ''; },
  get workerToken() { return required().config?.workerToken; },
  get sourceWorkerToken() { return required().config?.sourceWorkerToken; },
  get renderWorkerToken() { return required().config?.renderWorkerToken; },
  get schedulerToken() { return undefined; },
  get webhookSecret() { return undefined; },
  get mediaSigningSecret() { return undefined; },
  get localMediaSigningSecret() { return 'signal40-local-media-signing-key'; },
  get identityHeaders() { return { id: 'oai-authenticated-user-id', email: 'oai-authenticated-user-email' }; },
  get allowLocalRoleHeaders() { return false; },
  get production() { return false; },
  get renderConcurrencyLimit() { return 2; },
  get monthlyRenderBudgetMicros() { return 0; },
  get automationActorId() { return required().config?.automationActorId; },
  get diagnosticsEnvironment() { return {}; },
} as never;

/** 直接返回注入的 actor：身份解析本身由 workflow.test.ts 覆盖，这里要测的是路由体。 */
export function resolveRequestActor(): Promise<Actor | null> {
  return Promise.resolve(required().actor);
}
