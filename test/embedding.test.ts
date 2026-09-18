import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparableEmbeddings,
  cosineSimilarity,
  embeddingInputText,
  EMBEDDING_INPUT_CHAR_LIMIT,
  EMBEDDING_VERSION,
  meanVector,
  pairwiseCosine,
  parseEmbedding,
  serializeEmbedding,
} from '../lib/embedding.ts';
import {
  DEFAULT_RELEVANCE_THRESHOLD,
  evaluateDomainRelevance,
  needsCentroidRefresh,
  rowToTopicDomain,
  type TopicDomain,
} from '../lib/topic-domains.ts';
import {
  assessTopicQuality,
  MIN_SEMANTIC_COHERENCE,
} from '../lib/topic-quality.ts';
import {
  clusterArticles,
  EMBEDDING_CLUSTER_THRESHOLD,
  normalizeArticles,
  type Article,
  type ArticleInput,
} from '../lib/domain.ts';

const MODEL = 'text-embedding-3-small';
const now = new Date('2026-09-17T00:00:00.000Z');
/** 聚类要知道当前口径才敢用向量——否则换模型后会拿旧空间的距离套新阈值。 */
const CONTEXT = { domains: [], embeddingModel: MODEL, embeddingVersion: EMBEDDING_VERSION };

/**
 * 造一个确定的单位向量：在 `dimension` 这一维上放 1，其余放 `noise`。
 * 不调用嵌入接口——测试必须离线确定，而向量本来就是从文章行上读的，
 * 这也正是「按文章落库」而不是「判定时现算」的另一个理由。
 */
function unitVector(dimension: number, noise = 0, size = 8): number[] {
  return Array.from({ length: size }, (_, index) =>
    index === dimension ? 1 : noise,
  );
}

function article(
  id: string,
  embedding: number[],
  overrides: Partial<ArticleInput> = {},
): ArticleInput {
  return {
    id,
    source: overrides.source ?? `来源 ${id}`,
    sourceType: overrides.sourceType ?? 'media',
    title: overrides.title ?? `标题 ${id}`,
    summary: overrides.summary ?? `摘要 ${id}`,
    url: overrides.url ?? `https://example.com/${id}`,
    publishedAt: overrides.publishedAt ?? now.toISOString(),
    embedding,
    embeddingModel: MODEL,
    embeddingVersion: EMBEDDING_VERSION,
    ...overrides,
  };
}

function semanticArticles(vectors: number[][]): Article[] {
  return normalizeArticles(
    vectors.map((vector, index) => article(`a${index}`, vector)),
  );
}

void test('余弦相似度：同向为 1，正交为 0，维度不同返回 0 而不是抛错', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  // 反向向量表示语义相反，对「是不是同一件事」没有意义，截到 0 而不是 -1。
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), 0);
});

void test('向量序列化保留足够精度，坏数据解析成「没算过」而不是错向量', () => {
  const vector = [0.1234567, -0.7654321];
  const restored = parseEmbedding(serializeEmbedding(vector));
  assert.equal(restored.length, 2);
  assert.ok(Math.abs(restored[0] - vector[0]) < 1e-6);
  for (const bad of ['', 'not json', '[]', '[1, "x"]', '[1, null]']) {
    assert.deepEqual(parseEmbedding(bad), [], bad);
  }
});

void test('可比性要求模型和口径版本都一致，缺一个就整组不可比', () => {
  const base = { embedding: [1, 0], embeddingModel: MODEL, embeddingVersion: 1 };
  assert.equal(comparableEmbeddings([base, { ...base }]), true);
  assert.equal(
    comparableEmbeddings([base, { ...base, embeddingModel: 'other' }]),
    false,
  );
  assert.equal(
    comparableEmbeddings([base, { ...base, embeddingVersion: 2 }]),
    false,
  );
  assert.equal(comparableEmbeddings([base, { ...base, embedding: [] }]), false);
  assert.equal(comparableEmbeddings([]), false);
});

void test('聚类：余弦达标的并进同一簇，不达标的各自成簇', () => {
  // 两两余弦 1、与第三条正交：前两条必须并簇，第三条必须独立。
  const articles = semanticArticles([
    unitVector(0),
    unitVector(0),
    unitVector(1),
  ]);
  const clusters = clusterArticles(articles, CONTEXT);
  assert.equal(clusters.length, 2);
  assert.equal(Math.max(...clusters.map((c) => c.articles.length)), 2);
});

void test('聚类阈值是把关的那条线：刚好低于阈值的不并簇', () => {
  // 构造一对余弦落在阈值两侧的向量，确认判定确实由阈值决定，
  // 而不是「只要有点像就并到一起」。
  const below = Math.cos(Math.acos(EMBEDDING_CLUSTER_THRESHOLD) + 0.05);
  const above = Math.cos(Math.acos(EMBEDDING_CLUSTER_THRESHOLD) - 0.05);
  assert.ok(below < EMBEDDING_CLUSTER_THRESHOLD);
  assert.ok(above > EMBEDDING_CLUSTER_THRESHOLD);
  const pair = (cosine: number) => [
    [1, 0],
    [cosine, Math.sqrt(1 - cosine * cosine)],
  ];
  assert.equal(clusterArticles(semanticArticles(pair(below)), CONTEXT).length, 2);
  assert.equal(clusterArticles(semanticArticles(pair(above)), CONTEXT).length, 1);
});

void test('缺向量时聚类退回词元口径，而不是把所有文章并成一簇', () => {
  const articles = normalizeArticles([
    { ...article('x0', []), embeddingModel: '', embeddingVersion: 0 },
    { ...article('x1', []), embeddingModel: '', embeddingVersion: 0 },
  ]);
  const clusters = clusterArticles(articles, CONTEXT);
  // 标题摘要各不相同，词元口径下不该并簇——退化的是分组质量，不是判据本身。
  assert.equal(clusters.length, 2);
});

void test('缺向量的文章只影响自己，不把整批语料拖回词元口径', () => {
  // 这是这次改动最容易错的地方：向量是异步算的，任何时刻都有刚采进来、还没算向量的文章。
  // 如果按整批判定，1 篇没向量就会让 1000 篇全部退回词元口径，语义聚类等于从不启用。
  const withVectors = [unitVector(0), unitVector(0)].map((vector, index) =>
    article(`v${index}`, vector, { title: `同一件事 ${index}`, summary: '同一件事的两家报道。' }),
  );
  const withoutVector: ArticleInput = {
    ...article('pending', []),
    embeddingModel: '',
    embeddingVersion: 0,
    title: '完全无关的另一条新闻',
    summary: '和上面两条没有任何共同词。',
  };
  const clusters = clusterArticles(
    normalizeArticles([...withVectors, withoutVector]),
    CONTEXT,
  );
  // 有向量的两篇仍然按余弦并簇；没向量的那篇自己成簇，没有拖累别人。
  assert.equal(clusters.length, 2);
  assert.equal(Math.max(...clusters.map((cluster) => cluster.articles.length)), 2);
});

/** 与 `[1,0]` 夹角给定余弦的单位向量，用来精确构造阈值两侧的样例。 */
function atCosine(cosine: number): number[] {
  return [cosine, Math.sqrt(1 - cosine * cosine)];
}

void test('贪心归属把同一件事切开时，簇间合并把它补回来', () => {
  // 复现真实语料上的那一例：OpenAI 官方公告、TechCrunch、Ars Technica 讲同一件事，
  // 两两余弦 0.645/0.678/0.745 全部高于阈值，却因为贪心归属的先后顺序落进两个簇——
  // 一个有一手来源没有交叉证据，另一个有交叉证据没有一手来源，门禁两个都不放行。
  const media = atCosine(0.98);
  const official = atCosine(0.66);
  // 先让两篇媒体报道成簇，官方公告最后到：它对簇质心达标，但如果只比「先到的那篇」
  // 就可能被挡在外面。合并那一趟保证结果与到达顺序无关。
  const clusters = clusterArticles(
    semanticArticles([[1, 0], media, official]),
    CONTEXT,
  );
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].articles.length, 3);
});

void test('合并只看质心会塌陷，所以跨簇每一对都要达标', () => {
  // A 与 B 达标、B 与 C 达标，但 A 与 C 不达标。只比质心的话 B 会把 A、C 串成一簇，
  // 虚增独立来源数——那正是证据门禁最不能出的错。全连接判据必须挡住它。
  const clusters = clusterArticles(
    semanticArticles([[1, 0], atCosine(0.66), atCosine(0.1)]),
    CONTEXT,
  );
  const sizes = clusters
    .map((cluster) => cluster.articles.length)
    .sort((left, right) => left - right);
  assert.deepEqual(sizes, [1, 2]);
});

void test('簇不会随着变大而漂移：新文章要对每个成员都达标，不只是对质心', () => {
  // 质心会被成员一点点拽走，几十篇之后已经离最初那件事很远却仍显得像。
  // 构造一条对质心达标、但对某个成员不达标的文章，它必须自己成簇。
  const members = [[1, 0], atCosine(0.64)];
  const drifter = atCosine(0.5);
  const clusters = clusterArticles(
    semanticArticles([...members, drifter]),
    CONTEXT,
  );
  const sizes = clusters
    .map((cluster) => cluster.articles.length)
    .sort((left, right) => left - right);
  assert.deepEqual(sizes, [1, 2]);
});

void test('合并后簇内仍按发布时间从新到旧，标题不会退回旧稿', () => {
  // `runPipeline` 拿 articles[0] 当选题标题和 updatedAt；合并是往后追加的，
  // 不重排就会把并进来的旧稿当成这个选题的最新状态。
  const older = article('old', [1, 0], {
    title: '旧稿',
    publishedAt: '2026-09-16T00:00:00.000Z',
  });
  const newer = article('new', atCosine(0.99), {
    title: '新稿',
    publishedAt: '2026-09-17T12:00:00.000Z',
  });
  const clusters = clusterArticles(normalizeArticles([older, newer]), CONTEXT);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].articles[0].title, '新稿');
});

void test('换模型之后旧向量不再用于聚类，而不是拿旧空间套新阈值', () => {
  const articles = semanticArticles([unitVector(0), unitVector(0)]);
  const clusters = clusterArticles(articles, {
    domains: [],
    embeddingModel: 'text-embedding-3-large',
    embeddingVersion: EMBEDDING_VERSION,
  });
  // 两篇余弦为 1，但向量是别的模型算的，不能参与语义判定；
  // 词元口径下标题摘要不同，于是各自成簇。
  assert.equal(clusters.length, 2);
});

function domain(overrides: Partial<TopicDomain> = {}): TopicDomain {
  return {
    id: 'domain_ai',
    name: 'AI 与算力',
    description: '人工智能模型、算力与相关公司动态。',
    descriptionHash: 'hash-ai',
    centroid: unitVector(0),
    centroidSourceHash: 'hash-ai',
    centroidModel: MODEL,
    centroidVersion: EMBEDDING_VERSION,
    relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
    enabled: true,
    ...overrides,
  };
}

void test('领域相关性取最相近的一个领域，并记下是哪一个', () => {
  const ai = domain();
  const finance = domain({
    id: 'domain_fin',
    name: '财经',
    centroid: unitVector(1),
    descriptionHash: 'hash-fin',
    centroidSourceHash: 'hash-fin',
  });
  const result = evaluateDomainRelevance(
    unitVector(1),
    [ai, finance],
    MODEL,
    EMBEDDING_VERSION,
  );
  assert.equal(result.status, 'evaluated');
  assert.equal(result.domainId, 'domain_fin');
  assert.equal(result.relevance, 1);
  assert.equal(result.inScope, true);
});

void test('判定不了时 fail closed，且与「判定为跑题」区分得开', () => {
  // 一个领域都没配
  const none = evaluateDomainRelevance([1, 0], [], MODEL, EMBEDDING_VERSION);
  assert.equal(none.status, 'no_domains');
  assert.equal(none.inScope, false);

  // 配了领域但中心向量还没算出来
  const stale = evaluateDomainRelevance(
    [1, 0],
    [domain({ centroid: [], centroidSourceHash: '' })],
    MODEL,
    EMBEDDING_VERSION,
  );
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.inScope, false);

  // 中心向量是别的模型算的：不是一个空间里的点，不能比余弦
  const otherModel = evaluateDomainRelevance(
    [1, 0],
    [domain({ centroidModel: 'other-model' })],
    MODEL,
    EMBEDDING_VERSION,
  );
  assert.equal(otherModel.status, 'unavailable');

  // 真的跑题：算过了，余弦低于阈值
  const offTopic = evaluateDomainRelevance(
    unitVector(1),
    [domain()],
    MODEL,
    EMBEDDING_VERSION,
  );
  assert.equal(offTopic.status, 'evaluated');
  assert.equal(offTopic.inScope, false);
});

void test('改过描述的领域，中心向量判定为过期', () => {
  assert.equal(
    needsCentroidRefresh(domain(), MODEL, EMBEDDING_VERSION),
    false,
  );
  assert.equal(
    needsCentroidRefresh(
      domain({ descriptionHash: 'hash-new' }),
      MODEL,
      EMBEDDING_VERSION,
    ),
    true,
  );
});

void test('数据库行里的非字符串值不会变成 "[object Object]"', () => {
  const parsed = rowToTopicDomain({
    id: 'domain_x',
    name: '领域',
    description: '描述',
    description_hash: null,
    centroid_json: null,
    relevance_threshold: 'not-a-number',
    enabled: 'true',
  });
  assert.equal(parsed.descriptionHash, '');
  assert.deepEqual(parsed.centroid, []);
  assert.equal(parsed.relevanceThreshold, DEFAULT_RELEVANCE_THRESHOLD);
});

void test('质量判定：有向量、同题、在领域内的簇可以自动化', () => {
  // 三篇原始来源文章，向量两两余弦为 1，落在领域中心上。
  const articles = normalizeArticles(
    [0, 1, 2].map((index) =>
      article(`f${index}`, unitVector(0), {
        sourceType: 'filing',
        title: `公告 ${index}`,
        summary: '同一件事的三家原始来源。',
      }),
    ),
  );
  const quality = assessTopicQuality(
    { articles, sourceCount: 3 },
    now,
    { domains: [domain()], embeddingModel: MODEL, embeddingVersion: EMBEDDING_VERSION },
  );
  assert.equal(quality.coherenceMode, 'semantic');
  assert.equal(quality.coherence, 1);
  assert.equal(quality.embeddingCoverage, 1);
  assert.equal(quality.domainId, 'domain_ai');
  assert.equal(quality.domainRelevance, 1);
  // 建项目规则把整簇文章挂给每条声明，三条声明的证据集合完全相同，
  // 区分度为 0——这条和向量无关，改了聚类也不会自动变好。
  assert.equal(quality.evidenceDistinctness, 0);
  assert.equal(quality.automatable, false);
  assert.ok(quality.reasons.some((reason) => reason.includes('对应唯一性')));
  assert.ok(!quality.reasons.some((reason) => reason.includes('语义向量')));
});

void test('一致性不达标时理由说的是语义余弦，不是语言', () => {
  const articles = semanticArticles([
    unitVector(0),
    unitVector(1),
    unitVector(2),
  ]);
  const quality = assessTopicQuality(
    { articles, sourceCount: 3 },
    now,
    { domains: [domain()], embeddingModel: MODEL, embeddingVersion: EMBEDDING_VERSION },
  );
  assert.equal(quality.coherenceMode, 'semantic');
  assert.ok(quality.coherence < MIN_SEMANTIC_COHERENCE);
  assert.equal(quality.automatable, false);
  assert.ok(quality.reasons.some((reason) => reason.includes('语义余弦中位数')));
  assert.ok(!quality.reasons.some((reason) => reason.includes('语言判定为')));
});

void test('模型换了之后旧向量不算数：判定回到「没算过」而不是继续用', () => {
  const articles = semanticArticles([unitVector(0), unitVector(0)]);
  const quality = assessTopicQuality({ articles, sourceCount: 2 }, now, {
    domains: [domain()],
    embeddingModel: 'text-embedding-3-large',
    embeddingVersion: EMBEDDING_VERSION,
  });
  assert.equal(quality.coherenceMode, 'token');
  assert.equal(quality.embeddingCoverage, 0);
  assert.equal(quality.automatable, false);
  assert.ok(quality.reasons.some((reason) => reason.includes('语义向量')));
});

void test('均值向量与两两余弦展开顺序与调用方的遍历一致', () => {
  assert.deepEqual(meanVector([[1, 0], [0, 1]]), [0.5, 0.5]);
  // 维度不一致的一组没有均值可言，返回空而不是一个悄悄截断的结果。
  assert.deepEqual(meanVector([[1, 0], [0, 1, 0]]), []);
  assert.deepEqual(pairwiseCosine([[1, 0], [1, 0], [0, 1]]), [1, 0, 0]);
});

void test('嵌入输入只取标题和摘要，超长按字符截断', () => {
  const text = embeddingInputText({ title: '标题', summary: '  摘要   正文  ' });
  assert.equal(text, '标题 摘要 正文');
  const long = embeddingInputText({ title: 'x'.repeat(10_000), summary: '' });
  assert.equal(long.length, EMBEDDING_INPUT_CHAR_LIMIT);
});
