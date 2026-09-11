import { FINANCE_TERMS, similarity, tokensFor, type Article, type TopicCandidate, type TopicQuality } from './domain.ts';

/**
 * 选题质量度量——自动建项目的前置条件。
 *
 * 实测发现当前聚类在英文来源上会把上百篇文章并成一个话题，
 * 三条声明的「证据」指向同一批文章、没有区分度。只看来源数看不出这一点：
 * 来源数越多分越高，恰恰是簇失效时最高。
 *
 * 因此这里度量三件事，任何一项不达标都判定为「不可自动化」：
 *
 * 1. 簇内主题一致性——文章两两之间的关键词重合度分布，而不是来源数；
 * 2. 声明与证据的对应唯一性——同一批证据同时支撑多条声明，说明证据没有真正绑定到声明；
 * 3. 语言与词表匹配度——`lib/domain.ts` 的分词与主题词表是按中文语料调的，
 *    英文簇上分词退化成裸词匹配，不能拿它的聚类结果去自动生产内容。
 *
 * 判定结果只决定「能不能自动建项目」。不达标的选题照常进人工待办箱，
 * 人依旧可以手工建项目——这是自动化的闸门，不是选题的判决。
 */

export const TOPIC_QUALITY_VERSION = 'signal40-topic-quality/1.0.0';

/** 簇内两两关键词重合度的中位数下限。 */
export const MIN_COHERENCE = 0.25;
/** 声明↔证据对应唯一性下限：1 表示每条声明各有一批独有证据。 */
export const MIN_EVIDENCE_DISTINCTNESS = 0.5;
/** 中文词表在簇文本上的最低覆盖率（命中词数 / 词表规模）。 */
export const MIN_LEXICON_COVERAGE = 0.05;
/** 超过这个规模又没有足够一致性的簇，基本可以确定是聚类失效而不是热点。 */
export const MAX_COHERENT_CLUSTER_SIZE = 25;
/** 一致性抽样上限：两两比较是 O(n²)，大簇只取最新的这些文章。 */
const COHERENCE_SAMPLE_SIZE = 40;

export type TopicLanguage = TopicQuality['language'];
export type { TopicQuality } from './domain.ts';

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function detectLanguage(text: string): TopicLanguage {
  const han = (text.match(/[\p{Script=Han}]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = han + latin;
  if (!total) return 'unknown';
  const hanRatio = han / total;
  if (hanRatio >= 0.6) return 'zh';
  if (hanRatio <= 0.1) return 'en';
  return 'mixed';
}

/**
 * 声明↔证据对应唯一性：1 减去两两声明证据集合的平均 Jaccard 相似度。
 * 只有一条声明时没有可比对象，按 1 处理。
 */
export function evidenceDistinctness(claims: ReadonlyArray<{ evidenceIds: readonly string[] }>) {
  const sets = claims.map((claim) => new Set(claim.evidenceIds));
  if (sets.length < 2) return sets.length === 1 && sets[0].size ? 1 : 0;
  const overlaps: number[] = [];
  for (let left = 0; left < sets.length; left += 1) {
    for (let right = left + 1; right < sets.length; right += 1) {
      const union = new Set([...sets[left], ...sets[right]]);
      if (!union.size) { overlaps.push(1); continue; }
      let intersection = 0;
      for (const value of sets[left]) if (sets[right].has(value)) intersection += 1;
      overlaps.push(intersection / union.size);
    }
  }
  return 1 - overlaps.reduce((sum, value) => sum + value, 0) / overlaps.length;
}

/**
 * 按 `createProjectV2` 的规则推演出候选声明与它们的证据集合。
 *
 * 建项目时声明取前 3 篇原始来源文章、证据挂上簇内全部文章——
 * 想知道「自动建出来的项目证据有没有区分度」，就必须按同一条规则推演，
 * 而不是另立一套评估口径。
 */
function candidateClaims(articles: readonly Article[]) {
  return articles
    .filter((article) => ['filing', 'company', 'market'].includes(article.sourceType))
    .slice(0, 3)
    .map((article, index) => ({
      id: `claim_${index + 1}`,
      sourceArticleId: article.id,
      evidenceIds: articles.map((source) => source.id),
    }));
}

export function assessTopicQuality(
  topic: Pick<TopicCandidate, 'articles' | 'sourceCount'>,
  now = new Date(),
): TopicQuality {
  const articles = topic.articles;
  const sample = articles.slice(0, COHERENCE_SAMPLE_SIZE);
  const tokens = sample.map((article) => tokensFor(article));
  const pairwise: number[] = [];
  for (let left = 0; left < tokens.length; left += 1) {
    for (let right = left + 1; right < tokens.length; right += 1) pairwise.push(similarity(tokens[left], tokens[right]));
  }
  const coherence = median(pairwise);
  const coherenceFloor = pairwise.length ? Math.min(...pairwise) : 0;
  const text = articles.map((article) => `${article.title} ${article.summary}`).join(' ').toLowerCase();
  const language = detectLanguage(text);
  const lexiconCoverage = FINANCE_TERMS.filter((term) => text.includes(term)).length / FINANCE_TERMS.length;
  const distinctness = evidenceDistinctness(candidateClaims(articles));
  const coherenceScore = Math.min(1, coherence / MIN_COHERENCE);
  const distinctnessScore = Math.min(1, distinctness / MIN_EVIDENCE_DISTINCTNESS);
  const languageScore = language === 'zh' ? Math.min(1, lexiconCoverage / MIN_LEXICON_COVERAGE) : 0;
  const qualityScore = Math.round(((coherenceScore + distinctnessScore + languageScore) / 3) * 100);

  const reasons: string[] = [];
  if (articles.length < 2) reasons.push('簇内只有一篇文章，无法度量主题一致性。');
  if (pairwise.length && coherence < MIN_COHERENCE) reasons.push(`簇内关键词重合度中位数 ${round(coherence)} 低于 ${MIN_COHERENCE}，聚类可能把不相关的报道并到了一起。`);
  if (articles.length > MAX_COHERENT_CLUSTER_SIZE && coherence < 0.4) reasons.push(`簇内有 ${articles.length} 篇文章但一致性只有 ${round(coherence)}，属于聚类失效而不是热点集中。`);
  if (distinctness < MIN_EVIDENCE_DISTINCTNESS) reasons.push(`声明与证据的对应唯一性 ${round(distinctness)} 低于 ${MIN_EVIDENCE_DISTINCTNESS}，同一批证据同时支撑多条声明。`);
  if (language !== 'zh') reasons.push(`簇文本语言判定为 ${language}，而分词与主题词表按中文语料调校，不能据此自动生产内容。`);
  else if (lexiconCoverage < MIN_LEXICON_COVERAGE) reasons.push(`主题词表覆盖率 ${round(lexiconCoverage)} 低于 ${MIN_LEXICON_COVERAGE}，选题与词表所描述领域的相关性不足。`);

  return {
    version: TOPIC_QUALITY_VERSION,
    assessedAt: now.toISOString(),
    articleCount: articles.length,
    sourceCount: topic.sourceCount,
    coherence: round(coherence),
    coherenceFloor: round(coherenceFloor),
    evidenceDistinctness: round(distinctness),
    language,
    lexiconCoverage: round(lexiconCoverage),
    score: qualityScore,
    automatable: reasons.length === 0,
    reasons,
  };
}
