/**
 * 语义向量：聚类、簇内一致性和领域相关性共用的唯一相似度口径。
 *
 * 取代原先的正则分词 + 中文词表。旧办法把三件事绑在了一起：
 * 「怎么切词」「这是什么语言」「这是不是我要做的领域」——中文按 2-gram 切、
 * 英文按裸词切、领域靠 18 个中文财经词命中，于是英文选题必然命中 0 个词，
 * 被判为跑题，而这跟它讲的是不是同一件事毫无关系。
 *
 * 向量把这三件事拆开：相似度只回答「这两段文本讲的是不是同一件事」，
 * 语言不再进入判定；「是不是我要做的领域」交给 `lib/topic-domains.ts` 的
 * 领域中心向量，用同一个余弦口径回答。
 *
 * 这个模块保持纯函数：不读 env、不发请求。向量由 Render Worker 算好写回数据库，
 * 判定时从文章行上读——`runPipeline` 是同步的，而且 `GET /api/topics` 每次
 * 打开首页都会调它，热路径里不能有网络调用。
 */

import { sha256Hex } from './hash.ts';

/**
 * 向量口径版本。
 *
 * 改 `embeddingInputText` 的文本构造方式必须 +1：同一篇文章用不同输入算出来的
 * 向量不能互相比余弦，而库里新旧向量会共存到回填跑完为止。版本随向量落库，
 * 「这两个向量可比吗」因此是查得出来的。
 */
export const EMBEDDING_VERSION = 1;

/** 默认嵌入模型。多语言，1536 维，成本足够低到可以对每篇文章都算。 */
export const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * 单次嵌入请求的输入字符数上限。
 *
 * 超长文本按字符截断而不是按 token：这里不引入 tokenizer 依赖。
 * 取 2000 而不是更大，是因为中文一个字大致就是一个 token——按 4000 字算，
 * 一批 64 条就逼近嵌入接口单请求约 30 万 token 的上限，一批长中文文章会直接 400。
 */
export const EMBEDDING_INPUT_CHAR_LIMIT = 2_000;

/**
 * 一次 API 调用里嵌入多少段文本。
 *
 * 32 × 2000 中文字 ≈ 6.4 万 token，离单请求上限有数倍余量。
 * 批量不是越大越好：一批里出现一条坏数据，整批都要重试（见 `embedTexts` 的逐条隔离）。
 */
export const EMBEDDING_BATCH_SIZE = 32;

export type EmbeddingSubject = {
  embedding: readonly number[];
  embeddingModel: string;
  embeddingVersion: number;
};

/**
 * 嵌入输入文本：标题 + 摘要。
 *
 * 不含来源名、URL、发布时间——那些是 `lib/domain.ts` 已经单独度量的事实
 * （来源独立性、时效性），混进向量只会让「同一家媒体的两条无关新闻」显得相似。
 */
export function embeddingInputText(
  article: Pick<{ title: string; summary?: string }, 'title' | 'summary'>,
) {
  const text = `${article.title}\n${article.summary ?? ''}`
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, EMBEDDING_INPUT_CHAR_LIMIT);
}

/**
 * 嵌入输入文本的哈希——「这个向量还代表当前文本吗」的唯一凭据。
 *
 * 不用 `article.contentHash`：那个是 shortHash(url|title)，不含摘要。
 * 同 URL 同标题只改写摘要的重发（聚合源很常见）在 contentHash 上看不出变化，
 * 而嵌入输入变了，旧向量代表的是已经不存在的文本。
 */
export function embeddingSourceHash(
  article: Pick<{ title: string; summary?: string }, 'title' | 'summary'>,
) {
  return sha256Hex(embeddingInputText(article));
}

export function serializeEmbedding(vector: readonly number[]) {
  return JSON.stringify(vector.map((value) => Math.round(value * 1e6) / 1e6));
}

/** 解析失败一律返回空向量：坏数据当成「没算过」，而不是当成一个错误的向量继续用。 */
export function parseEmbedding(value: string | null | undefined): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return [];
    const vector: number[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'number' || !Number.isFinite(entry)) return [];
      vector.push(entry);
    }
    return vector;
  } catch {
    return [];
  }
}

/**
 * 余弦相似度，返回 0–1。
 *
 * 维度不同（换过模型）直接返回 0 而不是抛错：调用方要么已经用
 * `comparableEmbeddings` 过滤过，要么就是在给「不可比」找一个安全的下界。
 */
export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  const cosine = dot / Math.sqrt(leftNorm * rightNorm);
  // 嵌入向量的余弦理论上落在 [-1, 1]，负值表示语义相反，对「是不是同一件事」
  // 没有意义，截到 0；浮点误差也可能让同一个向量算出略大于 1 的结果。
  return Math.min(1, Math.max(0, cosine));
}

/** 向量可用：非空、模型一致、口径版本一致。三者缺一就不是可比的向量。 */
export function isComparableEmbedding(
  subject: Partial<EmbeddingSubject> | null | undefined,
  model: string,
  version: number = EMBEDDING_VERSION,
) {
  return Boolean(
    subject?.embedding?.length &&
    subject.embeddingModel === model &&
    subject.embeddingVersion === version,
  );
}

/**
 * 一组向量是否两两可比：非空、维度一致、模型和版本一致。
 * 只要有一个不可比就返回 false——混着算出来的一致性不是一个可解释的数。
 */
export function comparableEmbeddings(
  subjects: ReadonlyArray<Partial<EmbeddingSubject> | null | undefined>,
  model?: string,
  version?: number,
): subjects is EmbeddingSubject[] {
  if (!subjects.length) return false;
  const first = subjects[0];
  if (!first?.embedding?.length) return false;
  // 给了当前口径就必须匹配它：只查组内自洽的话，换模型之后整批旧向量仍然"自洽"，
  // 于是会拿旧空间里的距离去套用为新模型标定的阈值——一个看起来正常的错误答案。
  if (model !== undefined && first.embeddingModel !== model) return false;
  if (version !== undefined && first.embeddingVersion !== version) return false;
  const { length } = first.embedding;
  const subjectModel = first.embeddingModel;
  const subjectVersion = first.embeddingVersion;
  return subjects.every(
    (subject) =>
      subject?.embedding?.length === length &&
      subject.embeddingModel === subjectModel &&
      subject.embeddingVersion === subjectVersion,
  );
}

/** 单个主体是否带有当前口径的可用向量。按对比较时用它，不要用整批的 `comparableEmbeddings`。 */
export function usableEmbedding(
  subject: Partial<EmbeddingSubject> | null | undefined,
  model: string,
  version: number,
) {
  return Boolean(
    subject?.embedding?.length &&
      subject.embeddingModel === model &&
      subject.embeddingVersion === version,
  );
}

/** 均值向量：领域中心向量由描述文本的向量（可以是多段）取平均得到。 */
export function meanVector(
  vectors: ReadonlyArray<readonly number[]>,
): number[] {
  const usable = vectors.filter((vector) => vector.length);
  if (!usable.length) return [];
  const { length } = usable[0];
  if (usable.some((vector) => vector.length !== length)) return [];
  const mean: number[] = Array.from({ length }, () => 0);
  for (const vector of usable) {
    for (let index = 0; index < length; index += 1)
      mean[index] += vector[index];
  }
  for (let index = 0; index < length; index += 1) mean[index] /= usable.length;
  return mean;
}

/**
 * 一组向量两两余弦的全部取值，按下标对顺序展开。
 * 簇内一致性用它的中位数，抽样上限由调用方控制——两两比较是 O(n²)。
 */
export function pairwiseCosine(vectors: ReadonlyArray<readonly number[]>) {
  const values: number[] = [];
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      values.push(cosineSimilarity(vectors[left], vectors[right]));
    }
  }
  return values;
}
