/**
 * 语义聚类阈值标定。
 *
 * `EMBEDDING_CLUSTER_THRESHOLD` 和 `MIN_SEMANTIC_COHERENCE` 是两个决定生产的数，
 * 不能凭感觉写。嵌入余弦没有「无关就接近 0」这个性质——任意两段自然语言之间
 * 都有一个不低的基线，基线高低随模型和语料变化，所以阈值必须在**本项目真实语料**
 * 上测出来，换模型或换语料都要重跑。
 *
 * 脚本做三件事：
 *
 * 1. 从库里抽一批真实文章，按线上完全相同的输入构造方式算向量；
 * 2. 打印两两余弦的分位数——基线在哪、尾部从哪里开始分离；
 * 3. 按余弦分档打印样例标题对，让「0.62 到底意味着什么」是能读出来的，
 *    而不是一个没人验证过的常量。
 *
 * 用法：SAMPLE=300 node --env-file-if-exists=.env --experimental-strip-types scripts/calibrate-embedding-threshold.ts
 */

import { Client } from 'pg';
import {
  DEFAULT_EMBEDDING_MODEL,
  embeddingInputText,
  pairwiseCosine,
} from '../lib/embedding.ts';
import { embedTexts } from '../lib/embedding-openai.ts';

const apiKey = process.env.OPENAI_API_KEY ?? '';
if (!apiKey) throw new Error('OPENAI_API_KEY 未配置，无法标定。');
const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl) throw new Error('DATABASE_URL 未配置。');

const model = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
const sampleSize = Number(process.env.SAMPLE || 200);

function percentile(sorted: readonly number[], fraction: number) {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * fraction)),
  );
  return Math.round(sorted[index] * 1000) / 1000;
}

const client = new Client({ connectionString: databaseUrl });
await client.connect();
const { rows } = await client.query<{
  id: string;
  title: string;
  summary: string;
}>(
  'SELECT id, title, summary FROM articles ORDER BY published_at DESC LIMIT $1',
  [sampleSize],
);
await client.end();
if (rows.length < 10)
  throw new Error(`语料只有 ${rows.length} 篇，不足以标定。`);

const texts = rows.map((row) =>
  embeddingInputText({ title: row.title, summary: row.summary }),
);
process.stderr.write(`嵌入 ${texts.length} 篇（模型 ${model}）…\n`);
const { vectors, tokens } = await embedTexts(apiKey, model, texts);

const values = pairwiseCosine(vectors);
const sorted = [...values].sort((left, right) => left - right);
const bands = [
  [0.85, 1.01],
  [0.75, 0.85],
  [0.65, 0.75],
  [0.55, 0.65],
  [0.45, 0.55],
] as const;

const samplesByBand = new Map<
  string,
  { cosine: number; left: string; right: string }[]
>();
// 分档取样：按下标对遍历一次，和 pairwiseCosine 的展开顺序一致。
let cursor = 0;
for (let left = 0; left < vectors.length; left += 1) {
  for (let right = left + 1; right < vectors.length; right += 1) {
    const cosine = values[cursor];
    cursor += 1;
    for (const [low, high] of bands) {
      if (cosine >= low && cosine < high) {
        const key = `${low}`;
        const bucket = samplesByBand.get(key) ?? [];
        if (bucket.length < 4) {
          bucket.push({
            cosine,
            left: rows[left].title,
            right: rows[right].title,
          });
          samplesByBand.set(key, bucket);
        }
      }
    }
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      model,
      articleCount: rows.length,
      pairCount: values.length,
      promptTokens: tokens,
      percentiles: {
        p05: percentile(sorted, 0.05),
        p25: percentile(sorted, 0.25),
        p50: percentile(sorted, 0.5),
        p75: percentile(sorted, 0.75),
        p90: percentile(sorted, 0.9),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        p999: percentile(sorted, 0.999),
        max: percentile(sorted, 1),
      },
      pairsAboveThreshold: Object.fromEntries(
        [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8].map((threshold) => [
          threshold,
          values.filter((value) => value >= threshold).length,
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);

for (const [low] of bands) {
  const bucket = samplesByBand.get(`${low}`) ?? [];
  process.stdout.write(`\n=== 余弦 ${low} 档样例 ===\n`);
  for (const sample of bucket) {
    process.stdout.write(
      `${sample.cosine.toFixed(3)}\n  A: ${sample.left.slice(0, 90)}\n  B: ${sample.right.slice(0, 90)}\n`,
    );
  }
}
