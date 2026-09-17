/**
 * 向量作业的入队与写回。
 *
 * 为什么是作业而不是在控制面顺手算：`runPipeline` 是同步函数，
 * `GET /api/topics` 每次打开首页都会调它，热路径里不能有网络调用。
 * 向量必须是「算好落库、判定时直接读」的。
 *
 * 为什么落在 Render Worker：OPENAI_API_KEY 目前只有它持有。
 * 让调度器或控制面去调嵌入接口就得把模型密钥发给它们，
 * 这会改变 `lib/workload-env.ts` 里划定的爆炸半径——CLAUDE.md 的不变量之一。
 *
 * 作业载荷里直接带文本而不是只带 id：Render Worker 没有数据库凭据，
 * 这和它拿不到文章正文是同一个设计，不能为了省几 KB 载荷给它开一条读库的路。
 *
 * **这是一条把来源内容发给第三方的外发通道**，因此它必须继承采集那条不变量：
 * 没有有效授权就不发。授权在入队时过滤（`pendingArticleEmbeddings`），
 * 并在租约判定时按 `sourceConfigId` 复核一次（`leaseNextJob`）——
 * 作业排队到执行之间授权可能被撤销。
 */

import { EMBEDDING_VERSION, embeddingSourceHash, serializeEmbedding } from './embedding.ts';
import { needsCentroidRefresh, type TopicDomain } from './topic-domains.ts';
import type { SqlDatabase, SqlStatement } from './sql.ts';
import { stableHash } from './hash.ts';

/** 作业能力标识；Render Worker 用它申明自己能领这类作业。 */
export const EMBEDDING_CAPABILITY = 'embedding:openai';
/** 能力协议版本。改载荷结构或写回契约要 +1。 */
export const EMBEDDING_CAPABILITY_PROTOCOL_VERSION = 1;
/**
 * 一个作业最多带多少条待嵌入文本。
 *
 * 32 条对应 `EMBEDDING_BATCH_SIZE`，即一个作业正好一次 API 请求；
 * 载荷也因此控制在百 KB 量级而不是兆级——载荷会随每次租约响应整包发给 Worker。
 */
export const EMBEDDING_JOB_ITEM_LIMIT = 32;

export type EmbeddingJobItem = {
  /** `article` 或 `domain`；两类主体共用一条流水线，写回路径不同。 */
  subject: 'article' | 'domain';
  id: string;
  text: string;
  /** 主体内容的哈希；写回时比对，内容在作业排队期间变过就丢弃这条结果。 */
  sourceHash: string;
};

export type EmbeddingJobPayload = {
  schemaVersion: 1;
  operation: 'embedding';
  model: string;
  version: number;
  /**
   * 这批文章所属的来源配置；租约判定用它复核授权是否仍然有效。
   * 领域中心作业没有来源，为 null。
   */
  sourceConfigId: string | null;
  items: EmbeddingJobItem[];
};

export type PendingArticle = {
  id: string;
  title: string;
  summary: string;
  sourceConfigId: string | null;
  sourceHash: string;
};

type PendingRow = {
  id: string;
  title: string;
  summary: string;
  embedding_source_hash: string;
  embedding_model: string;
  embedding_version: number;
  source_config_id: string | null;
};

/**
 * 授权仍然有效的文章才进待嵌入队列。
 *
 * 判据分两层：
 *
 * 1. **授权**——必须存在已批准、未撤销、未过期、且绑定当前 config hash 的权利授予，
 *    来源 origin 也没有被标记删除。这一层和采集用的是同一套事实，
 *    只是这里是「能不能把这段文本发给第三方」而不是「能不能抓取」。
 * 2. **新鲜度**——向量口径（模型 + 版本）对不上，或者嵌入来源哈希与当前
 *    标题摘要算出来的不一致。后者必须在应用层算：`embedding_source_hash`
 *    是标题摘要的哈希，SQL 里没有等价物（不引 pgcrypto）。
 */
export async function pendingArticleEmbeddings(
  db: SqlDatabase,
  model: string,
  version: number,
  since: Date,
  limit = EMBEDDING_JOB_ITEM_LIMIT,
): Promise<PendingArticle[]> {
  // 授权判据与采集租约里的那段（`lib/control-plane.ts` 的 rights EXISTS）逐条对齐，
  // 用的是同一批事实：来源启用中、rights_status 已批准、授权绑定当前 config hash、
  // 未撤销未过期、用途与使用范围在允许集合内。
  //
  // 复用 ingestion 的 purpose/usage_scope 是当前能拿到的最严判据；
  // 「把规范化元数据交给第三方处理」是否该有自己的 usage_scope，
  // 是权利所有者的政策决定，不该由这里替它发明一个。
  const authorized = `
    SELECT a.id, a.title, a.summary, a.embedding_source_hash,
           a.embedding_model, a.embedding_version,
           MIN(o.source_config_id) AS source_config_id
    FROM articles a
    JOIN source_item_origins o ON o.article_id = a.id AND o.deleted_at IS NULL
    JOIN source_configs sc ON sc.id = o.source_config_id
    JOIN source_rights_grants g ON g.source_config_id = sc.id
    WHERE sc.enabled = 1
      AND sc.lifecycle_status IN ('enabled', 'degraded')
      AND sc.rights_status = 'approved'
      AND g.config_hash = COALESCE(NULLIF(sc.rights_config_hash, ''), sc.config_hash)
      AND g.purpose = 'finance-editorial-ingestion'
      AND g.usage_scope IN ('normalized-metadata', 'normalized-and-authorized-raw')
      AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > ?)
      AND (a.embedding_model <> ? OR a.embedding_version <> ? OR a.embedding_source_hash = '')
  `;
  // 两段查询：窗内优先（新选题最需要向量），窗外兜底。
  // 只有窗口没有兜底的话，回填开始前就已经在库里的文章永远拿不到向量——
  // 窗口每 30 秒前移 30 秒，滑过去就再也不会被选中。
  const collect = async (extra: string, binds: unknown[]) => {
    const result = await db
      .prepare(`${authorized} ${extra} GROUP BY a.id, a.title, a.summary, a.embedding_source_hash,
                 a.embedding_model, a.embedding_version
               ORDER BY a.published_at DESC LIMIT ?`)
      .bind(...binds)
      .all<PendingRow>();
    return result.results;
  };
  const nowIso = new Date().toISOString();
  const inWindow = await collect('AND a.published_at >= ?', [
    nowIso,
    model,
    version,
    since.toISOString(),
    limit * 4,
  ]);
  const olderNeeded = limit * 4 - inWindow.length;
  const older = olderNeeded > 0
    ? await collect('AND a.published_at < ?', [
        nowIso,
        model,
        version,
        since.toISOString(),
        olderNeeded,
      ])
    : [];

  const pending: PendingArticle[] = [];
  for (const row of [...inWindow, ...older]) {
    const sourceHash = embeddingSourceHash({ title: row.title, summary: row.summary });
    const fresh =
      row.embedding_source_hash === sourceHash &&
      row.embedding_model === model &&
      Number(row.embedding_version) === version;
    if (fresh) continue;
    pending.push({
      id: row.id,
      title: row.title,
      summary: row.summary,
      sourceConfigId: row.source_config_id,
      sourceHash,
    });
    if (pending.length >= limit) break;
  }
  return pending;
}

/** 中心向量缺失或与描述/模型口径不同步的领域。 */
export function pendingDomainCentroids(
  domains: readonly TopicDomain[],
  model: string,
  version: number,
) {
  return domains.filter(
    (domain) => domain.enabled && needsCentroidRefresh(domain, model, version),
  );
}

/**
 * 是否已经有向量作业在途。
 *
 * 在途作业不会把它的文章从待嵌入集合里摘掉，所以不看这个的话，
 * 下一个 tick 只要多进来一篇新文章，集合哈希就变了、就会排一个含大量重复项的新作业——
 * 30 秒一次，同一批文本反复付费嵌入。同时只允许一个在途作业，这个问题就不存在。
 */
export async function embeddingJobInFlight(db: SqlDatabase) {
  const row = await db
    .prepare(`
      SELECT 1 AS present FROM jobs
      WHERE kind = 'embedding' AND status IN ('queued', 'running', 'retrying')
      LIMIT 1
    `)
    .first<{ present: number }>();
  return Boolean(row);
}

/**
 * 入队一个向量作业。
 *
 * 幂等键由「模型 + 版本 + 本批主体 id 集合」决定：同一批主体在同一口径下
 * 只会排一个作业，调度器每轮重复调用不会堆积重复作业。
 *
 * 冲突时不是简单跳过：**死信作业的行和幂等键都还在**，若原样跳过，
 * 这批文章从此再也排不出作业——一次限流把回填永久卡死，而且没有任何信号。
 * 所以命中冲突且对方已经是 `dead_letter` 时，把它复位成 `queued` 重新开始。
 */
export async function enqueueEmbeddingJob(
  db: SqlDatabase,
  items: EmbeddingJobItem[],
  model: string,
  now: Date,
  version = EMBEDDING_VERSION,
  sourceConfigId: string | null = null,
) {
  if (!items.length) return null;
  const payload: EmbeddingJobPayload = {
    schemaVersion: 1,
    operation: 'embedding',
    model,
    version,
    sourceConfigId,
    items,
  };
  const derivationKey = stableHash({
    model,
    version,
    sourceConfigId,
    ids: items
      .map((item) => `${item.subject}:${item.id}:${item.sourceHash}`)
      .sort(),
  });
  const jobId = `job_embedding_${derivationKey.slice(0, 32)}`;
  const timestamp = now.toISOString();
  const result = await db
    .prepare(`
      INSERT INTO jobs
        (id, kind, required_capability, required_capability_protocol_version,
         payload_schema_version, payload_json, status, idempotency_key,
         attempt, max_attempts, available_at, created_at, updated_at)
      VALUES (?, 'embedding', ?, ?, 1, ?, 'queued', ?, 0, 5, ?, ?, ?)
      ON CONFLICT (kind, idempotency_key) DO UPDATE SET
        status = 'queued', attempt = 0, lease_owner = NULL, lease_expires_at = NULL,
        available_at = excluded.available_at, updated_at = excluded.updated_at,
        payload_json = excluded.payload_json
      WHERE jobs.status = 'dead_letter'
    `)
    .bind(
      jobId,
      EMBEDDING_CAPABILITY,
      EMBEDDING_CAPABILITY_PROTOCOL_VERSION,
      JSON.stringify(payload),
      `embedding:${derivationKey}`,
      timestamp,
      timestamp,
      timestamp,
    )
    .run();
  return {
    jobId,
    itemCount: items.length,
    derivationKey,
    sourceConfigId,
    /** 0 表示命中了一个还活着的同批作业，什么都没做。 */
    changes: result.meta.changes,
  };
}

export type EmbeddingResultItem = {
  subject: 'article' | 'domain';
  id: string;
  sourceHash: string;
  embedding: number[];
};

/**
 * 写回向量。
 *
 * `sourceHash` 必须与库里当前内容一致才写：作业排队到执行之间文章可能被更新过，
 * 那时这个向量代表的是旧内容，写进去会让后面所有相似度判定都对着一份看不见的
 * 过期文本在算。对不上就跳过，下一轮调度会重新排。
 *
 * 调用方必须已经把 results 与作业载荷比对过（见 `app/api/v1/embeddings/route.ts`）——
 * 这里只做「内容有没有在排队期间变过」这一层守卫，不做授权判定。
 */
export async function applyEmbeddingResults(
  db: SqlDatabase,
  results: readonly EmbeddingResultItem[],
  model: string,
  version: number,
  now: Date,
) {
  const usable = results.filter((result) => result.embedding.length);
  if (!usable.length) return { articles: 0, domains: 0, written: 0, skipped: 0 };
  const timestamp = now.toISOString();

  /**
   * 新鲜度守卫在应用层判定，不在 SQL 里比 `embedding_source_hash`。
   *
   * 那一列只有写入路径会填，存量行是空串——照着它比，守卫会把每一条都挡掉，
   * 而作业仍然报成功。这个错在单元测试里看不出来（测试种子会显式写这一列），
   * 真跑一次才暴露：`skipped` 24/25。
   *
   * 所以这里按行里**当前**的标题摘要重算一次哈希再比对，并把结果一并写回那一列。
   * 判据因此只依赖内容本身，存量行第一次写入时自动补齐。
   */
  const articleIds = usable.filter((r) => r.subject === 'article').map((r) => r.id);
  const current = new Map<string, string>();
  if (articleIds.length) {
    const rows = await db
      .prepare(`
        SELECT id, title, summary FROM articles
        WHERE id IN (${articleIds.map(() => '?').join(', ')})
      `)
      .bind(...articleIds)
      .all<{ id: string; title: string; summary: string }>();
    for (const row of rows.results) {
      current.set(row.id, embeddingSourceHash({ title: row.title, summary: row.summary }));
    }
  }

  const statements: SqlStatement[] = [];
  let articles = 0;
  let domains = 0;
  let skipped = 0;
  for (const result of usable) {
    const serialized = serializeEmbedding(result.embedding);
    if (result.subject === 'article') {
      // 排队期间内容变过（或文章已被删除）就丢弃这条结果，下一轮会按新内容重排。
      if (current.get(result.id) !== result.sourceHash) {
        skipped += 1;
        continue;
      }
      articles += 1;
      statements.push(
        db
          .prepare(`
            UPDATE articles
            SET embedding_json = ?, embedding_model = ?, embedding_version = ?,
                embedded_at = ?, embedding_source_hash = ?
            WHERE id = ?
          `)
          .bind(serialized, model, version, timestamp, result.sourceHash, result.id),
      );
    } else {
      domains += 1;
      statements.push(
        db
          .prepare(`
            UPDATE topic_domains
            SET centroid_json = ?, centroid_source_hash = ?, centroid_model = ?,
                centroid_version = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND description_hash = ?
          `)
          .bind(serialized, result.sourceHash, model, version, timestamp, result.id, result.sourceHash),
      );
    }
  }
  if (!statements.length) return { articles: 0, domains: 0, written: 0, skipped };
  const runs = await db.batch(statements);
  const written = runs.reduce((sum, run) => sum + run.meta.changes, 0);
  return {
    articles,
    domains,
    written,
    /**
     * 提交了但没写进去的条数——内容在排队期间变过，或领域描述已改。
     * 全部被挡时 `written` 是 0 而作业仍然成功，调用方必须据此报警，
     * 否则就是每轮重烧一次同一批文本、永远不自愈、也永远没人知道。
     */
    skipped: skipped + (articles + domains - written),
  };
}
