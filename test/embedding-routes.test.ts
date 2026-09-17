import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { createMemoryPg } from './pg-memory.ts';
import { setRouteTestContext } from './route-runtime.ts';
import { leaseNextJob } from '../lib/control-plane.ts';
import {
  applyEmbeddingResults,
  EMBEDDING_CAPABILITY,
  EMBEDDING_CAPABILITY_PROTOCOL_VERSION,
  embeddingJobInFlight,
  enqueueEmbeddingJob,
  pendingArticleEmbeddings,
} from '../lib/embedding-jobs.ts';
import { embeddingSourceHash, EMBEDDING_VERSION } from '../lib/embedding.ts';
import { loadTopicDomains } from '../lib/topic-domains.ts';

/**
 * 向量作业的写路径测试：真正执行路由与 SQL。
 *
 * 这个文件的存在有具体原因。上一版没有它，于是三个只有真跑一次才会暴露的问题
 * 全部通过了 tsc、lint 和 363 项测试：
 *
 * 1. 租约路由的能力白名单正则是 `^source:...$`，`embedding:openai` 被静默丢掉，
 *    向量作业一条也领不出去——功能是死的，而所有纯函数测试都绿；
 * 2. 写回路由没有把结果与作业载荷比对，任何合法租约都能覆写任意领域中心向量；
 * 3. `topic_domains` 的 UPDATE 从没在真实 PostgreSQL 上执行过。
 */

register('./route-alias-hook.mjs', import.meta.url);

const renderToken = 'render-token-for-embedding-tests';
const MODEL = 'text-embedding-3-small';
/**
 * 用真实当前时间：租约是否有效由路由按 `new Date()` 判定，
 * 固定时间点造出来的租约在路由看来早就过期了。
 * 这里没有依赖具体时刻的断言，哈希也与时间无关。
 */
const now = new Date();

function vector(seed: number) {
  return Array.from({ length: 8 }, (_, index) => (index === seed % 8 ? 1 : 0.01));
}

/** 造一篇「授权有效」的文章：来源启用、权利已批准且绑定当前 config hash。 */
async function seedAuthorizedArticle(
  db: Awaited<ReturnType<typeof createMemoryPg>>,
  id: string,
  title: string,
  summary: string,
) {
  const sourceId = 'source-authorized';
  await db.client.query(
    `INSERT INTO source_configs (id, name, adapter, enabled, lifecycle_status,
       rights_status, config_hash, version, created_at, updated_at)
     VALUES ($1, '授权来源', 'rss', 1, 'enabled', 'approved', 'cfg-hash-1', 1, $2, $2)
     ON CONFLICT (id) DO NOTHING`,
    [sourceId, now.toISOString()],
  );
  await db.client.query(
    `INSERT INTO source_rights_grants (id, source_config_id, principal, provider, purpose,
       usage_scope, evidence_ref, terms_version, verified_by, granted_at, verified_at,
       config_hash, created_at)
     VALUES ($1, $2, 'signal40', '授权来源', 'finance-editorial-ingestion',
       'normalized-metadata', 'ref', 'v1', 'admin-1', $3, $3, 'cfg-hash-1', $3)
     ON CONFLICT (id) DO NOTHING`,
    [`grant-${sourceId}`, sourceId, now.toISOString()],
  );
  await db.client.query(
    `INSERT INTO articles (id, source, source_type, author, title, summary, url, published_at,
       metrics_json, content_hash, embedding_source_hash, created_at)
     VALUES ($1, '授权来源', 'media', '', $2, $3, $4, $5, '{}', $6, $7, $5)`,
    [
      id,
      title,
      summary,
      `https://example.com/${id}`,
      now.toISOString(),
      `hash-${id}`,
      embeddingSourceHash({ title, summary }),
      ],
  );
  await db.client.query(
    `INSERT INTO source_item_origins (id, source_config_id, namespace, platform_item_id,
       article_id, ingestion_run_id, canonical_url_hash, fingerprint_version,
       content_fingerprint, first_seen_at, last_seen_at)
     VALUES ($1, $2, 'test', $3, $3, $4, $5, 1, $5, $6, $6)`,
    [`origin-${id}`, sourceId, id, `run-${id}`, `hash-${id}`, now.toISOString()],
  );
  return sourceId;
}

void test('向量作业能被 Render Worker 领出来——能力标识不再被白名单静默丢掉', async () => {
  const db = await createMemoryPg();
  await seedAuthorizedArticle(db, 'article-lease', '标题一', '摘要一');
  const pending = await pendingArticleEmbeddings(db, MODEL, EMBEDDING_VERSION, new Date(0));
  assert.equal(pending.length, 1);
  const enqueued = await enqueueEmbeddingJob(
    db,
    pending.map((article) => ({
      subject: 'article' as const,
      id: article.id,
      text: `${article.title} ${article.summary}`,
      sourceHash: article.sourceHash,
    })),
    MODEL,
    now,
    EMBEDDING_VERSION,
    pending[0].sourceConfigId,
  );
  assert.ok(enqueued);

  // 这正是上一版死在的地方：能力被过滤成空数组后，租约退化成
  // `required_capability = ''`，而向量作业写的是 'embedding:openai'。
  const leased = await leaseNextJob(
    db,
    {
      workerId: 'render-worker-one',
      kinds: ['embedding'],
      capabilities: [EMBEDDING_CAPABILITY],
      capabilityProtocolVersions: {
        [EMBEDDING_CAPABILITY]: EMBEDDING_CAPABILITY_PROTOCOL_VERSION,
      },
      leaseSeconds: 300,
    },
    new Date(now.valueOf() + 1000),
  );
  assert.ok(leased, '向量作业必须能被申明了该能力的 Worker 领取');

  // 不申明能力的 Worker 领不到：能力门禁仍然有效。
  const withoutCapability = await leaseNextJob(
    db,
    { workerId: 'render-worker-two', kinds: ['embedding'], leaseSeconds: 300 },
    new Date(now.valueOf() + 2000),
  );
  assert.equal(withoutCapability, null);
});

void test('授权被撤销的来源，文章不进待嵌入队列也领不出作业', async () => {
  const db = await createMemoryPg();
  const sourceId = await seedAuthorizedArticle(db, 'article-revoked', '标题二', '摘要二');
  const pending = await pendingArticleEmbeddings(db, MODEL, EMBEDDING_VERSION, new Date(0));
  assert.equal(pending.length, 1);
  const enqueued = await enqueueEmbeddingJob(
    db,
    [
      {
        subject: 'article',
        id: 'article-revoked',
        text: '标题二 摘要二',
        sourceHash: pending[0].sourceHash,
      },
    ],
    MODEL,
    now,
    EMBEDDING_VERSION,
    sourceId,
  );
  assert.ok(enqueued);

  // 入队之后才撤销：租约边界必须复核，否则已排队的作业会把无权的内容发给第三方。
  await db.client.query(
    'UPDATE source_rights_grants SET revoked_at = $1 WHERE source_config_id = $2',
    [now.toISOString(), sourceId],
  );
  const leased = await leaseNextJob(
    db,
    {
      workerId: 'render-worker-one',
      kinds: ['embedding'],
      capabilities: [EMBEDDING_CAPABILITY],
      capabilityProtocolVersions: {
        [EMBEDDING_CAPABILITY]: EMBEDDING_CAPABILITY_PROTOCOL_VERSION,
      },
      leaseSeconds: 300,
    },
    new Date(now.valueOf() + 1000),
  );
  assert.equal(leased, null, '授权撤销后不得再领出向量作业');

  const stillPending = await pendingArticleEmbeddings(db, MODEL, EMBEDDING_VERSION, new Date(0));
  assert.equal(stillPending.length, 0, '撤销后也不该再选进待嵌入队列');
});

void test('写回必须落在作业载荷范围内，否则不能覆写任意领域中心向量', async () => {
  const db = await createMemoryPg();
  setRouteTestContext({ db, actor: null, config: { renderWorkerToken: renderToken } });
  await seedAuthorizedArticle(db, 'article-scope', '标题三', '摘要三');
  await db.client.query(
    `INSERT INTO topic_domains (id, name, description, description_hash, created_by, created_at, updated_at)
     VALUES ('domain-secret', '生产范围', '只做这个领域。', 'domain-hash', 'admin-1', $1, $1)`,
    [now.toISOString()],
  );
  const pending = await pendingArticleEmbeddings(db, MODEL, EMBEDDING_VERSION, new Date(0));
  const enqueued = await enqueueEmbeddingJob(
    db,
    [
      {
        subject: 'article',
        id: 'article-scope',
        text: '标题三 摘要三',
        sourceHash: pending[0].sourceHash,
      },
    ],
    MODEL,
    now,
    EMBEDDING_VERSION,
    pending[0].sourceConfigId,
  );
  const leased = (await leaseNextJob(
    db,
    {
      workerId: 'render-worker-one',
      kinds: ['embedding'],
      capabilities: [EMBEDDING_CAPABILITY],
      capabilityProtocolVersions: {
        [EMBEDDING_CAPABILITY]: EMBEDDING_CAPABILITY_PROTOCOL_VERSION,
      },
      leaseSeconds: 300,
    },
    new Date(now.valueOf() + 1000),
  )) as unknown as { id: string; lease_epoch: number };
  assert.ok(leased);

  const { POST } = await import('../app/api/v1/embeddings/route.ts');
  const post = (body: unknown) =>
    POST(
      new Request('http://local/api/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-worker-token': renderToken },
        body: JSON.stringify(body),
      }),
    );
  const base = {
    jobId: enqueued!.jobId,
    workerId: 'render-worker-one',
    leaseEpoch: leased.lease_epoch,
    model: MODEL,
    version: EMBEDDING_VERSION,
  };

  // 越界写入：领域中心向量不在这个作业的载荷里。
  const hijack = await post({
    ...base,
    results: [
      { subject: 'domain', id: 'domain-secret', sourceHash: 'domain-hash', embedding: vector(1) },
    ],
  });
  assert.equal(
    hijack.status,
    409,
    `不在载荷范围内的条目必须被拒绝：${await hijack.clone().text()}`,
  );
  const domains = await loadTopicDomains(db);
  assert.deepEqual(domains[0].centroid, [], '被拒绝的写入不得落库');

  // 范围内的写入正常。
  const ok = await post({
    ...base,
    results: [
      {
        subject: 'article',
        id: 'article-scope',
        sourceHash: pending[0].sourceHash,
        embedding: vector(2),
      },
    ],
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  const applied = (await ok.json()) as { written: number; skipped: number };
  assert.equal(applied.written, 1);
  assert.equal(applied.skipped, 0);
});

void test('内容在排队期间变过时写回被守卫挡下，并计入 skipped 而不是静默成功', async () => {
  const db = await createMemoryPg();
  await seedAuthorizedArticle(db, 'article-stale', '旧标题', '旧摘要');
  const staleHash = embeddingSourceHash({ title: '旧标题', summary: '旧摘要' });
  // 摘要改了——注意 content_hash 不含摘要，所以只有 embedding_source_hash 能发现这件事。
  await db.client.query(
    "UPDATE articles SET summary = '新摘要', embedding_source_hash = $1 WHERE id = 'article-stale'",
    [embeddingSourceHash({ title: '旧标题', summary: '新摘要' })],
  );
  const applied = await applyEmbeddingResults(
    db,
    [{ subject: 'article', id: 'article-stale', sourceHash: staleHash, embedding: vector(3) }],
    MODEL,
    EMBEDDING_VERSION,
    now,
  );
  assert.equal(applied.written, 0);
  assert.equal(applied.skipped, 1, '被守卫挡下的条数必须能被调用方看见');
  const row = await db.client.query(
    "SELECT embedding_json FROM articles WHERE id = 'article-stale'",
  );
  assert.equal((row.rows[0] as { embedding_json: string }).embedding_json, '');
});

void test('存量行的 embedding_source_hash 是空的，写回必须照样成功', async () => {
  // 迁移只加了列，SQL 里算不出标题摘要的 sha256，所以存量行这一列是空串。
  // 守卫如果照着这一列比，会把每一条都挡掉而作业仍然报成功——
  // 单元测试看不出来（种子会显式写这一列），真跑一次才暴露：skipped 24/25。
  const db = await createMemoryPg();
  await seedAuthorizedArticle(db, 'article-legacy', '存量标题', '存量摘要');
  await db.client.query(
    "UPDATE articles SET embedding_source_hash = '' WHERE id = 'article-legacy'",
  );
  const applied = await applyEmbeddingResults(
    db,
    [
      {
        subject: 'article',
        id: 'article-legacy',
        sourceHash: embeddingSourceHash({ title: '存量标题', summary: '存量摘要' }),
        embedding: vector(5),
      },
    ],
    MODEL,
    EMBEDDING_VERSION,
    now,
  );
  assert.equal(applied.written, 1, '存量行必须能写入');
  assert.equal(applied.skipped, 0);
  const row = await db.client.query(
    "SELECT embedding_json, embedding_source_hash FROM articles WHERE id = 'article-legacy'",
  );
  const stored = row.rows[0] as { embedding_json: string; embedding_source_hash: string };
  assert.ok(stored.embedding_json.length > 2);
  assert.equal(
    stored.embedding_source_hash,
    embeddingSourceHash({ title: '存量标题', summary: '存量摘要' }),
    '写入的同时要把来源哈希补齐，下次判定才不用再走这条兜底',
  );
});

void test('领域中心向量的写回真的落库，且带描述哈希守卫', async () => {
  const db = await createMemoryPg();
  await db.client.query(
    `INSERT INTO topic_domains (id, name, description, description_hash, created_by, created_at, updated_at)
     VALUES ('domain-write', '领域', '领域描述。', 'desc-hash', 'admin-1', $1, $1)`,
    [now.toISOString()],
  );
  const stale = await applyEmbeddingResults(
    db,
    [{ subject: 'domain', id: 'domain-write', sourceHash: 'old-hash', embedding: vector(4) }],
    MODEL,
    EMBEDDING_VERSION,
    now,
  );
  assert.equal(stale.written, 0, '描述哈希对不上时不得写入');

  const fresh = await applyEmbeddingResults(
    db,
    [{ subject: 'domain', id: 'domain-write', sourceHash: 'desc-hash', embedding: vector(4) }],
    MODEL,
    EMBEDDING_VERSION,
    now,
  );
  assert.equal(fresh.written, 1);
  const domains = await loadTopicDomains(db);
  assert.equal(domains[0].centroid.length, 8);
  assert.equal(domains[0].centroidModel, MODEL);
  assert.equal(domains[0].centroidSourceHash, 'desc-hash');
});

void test('死信的向量作业会被重新排队，不会把回填永久卡死', async () => {
  const db = await createMemoryPg();
  await seedAuthorizedArticle(db, 'article-dlq', '标题四', '摘要四');
  const pending = await pendingArticleEmbeddings(db, MODEL, EMBEDDING_VERSION, new Date(0));
  const items = [
    {
      subject: 'article' as const,
      id: 'article-dlq',
      text: '标题四 摘要四',
      sourceHash: pending[0].sourceHash,
    },
  ];
  const first = await enqueueEmbeddingJob(db, items, MODEL, now, EMBEDDING_VERSION, pending[0].sourceConfigId);
  assert.equal(first?.changes, 1);

  // 在途时不重复排：否则每个 tick 都会排一个高度重叠的新作业、重复付费。
  assert.equal(await embeddingJobInFlight(db), true);

  await db.client.query("UPDATE jobs SET status = 'dead_letter' WHERE kind = 'embedding'");
  assert.equal(await embeddingJobInFlight(db), false);

  // 幂等键不变，但对方已经死信——必须复位重排，否则这批文章再也拿不到向量。
  const again = await enqueueEmbeddingJob(db, items, MODEL, now, EMBEDDING_VERSION, pending[0].sourceConfigId);
  assert.equal(again?.changes, 1, '死信作业必须能被重新排队');
  const status = await db.client.query(
    "SELECT status, attempt FROM jobs WHERE kind = 'embedding'",
  );
  assert.equal((status.rows[0] as { status: string }).status, 'queued');
  assert.equal(Number((status.rows[0] as { attempt: number }).attempt), 0);
});
