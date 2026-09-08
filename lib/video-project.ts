import type { TopicCandidate } from './domain';

export function createVideoProject(topic: TopicCandidate) {
  if (!topic.gate.passed)
    throw new Error(
      `Topic ${topic.id} has not passed the evidence gate: ${topic.gate.reason}`,
    );
  if (topic.verificationStatus !== 'verified')
    throw new Error(`Topic ${topic.id} has not been approved by an editor`);
  const primary = topic.articles.find((article) =>
    ['filing', 'company', 'market'].includes(article.sourceType),
  );
  if (!primary) throw new Error(`Topic ${topic.id} has no primary source`);

  return {
    version: '1.0' as const,
    topic: { id: topic.id, title: topic.title, score: topic.score },
    claims: [
      {
        text: primary.summary || primary.title,
        sourceIds: topic.articles.map((article) => article.id),
      },
    ],
    sources: topic.articles.map((article) => ({
      id: article.id,
      title: article.title,
      url: article.url,
      sourceType: article.sourceType,
    })),
    scenes: [
      {
        id: 'hook',
        startFrame: 0,
        durationFrames: 120,
        kind: 'hero-number' as const,
        narration: topic.title,
        data: { keywords: topic.keywords },
      },
      {
        id: 'evidence',
        startFrame: 120,
        durationFrames: 480,
        kind: 'trend' as const,
        narration: primary.summary || primary.title,
        data: { sourceCount: topic.sourceCount },
      },
      {
        id: 'breakdown',
        startFrame: 600,
        durationFrames: 480,
        kind: 'breakdown' as const,
        narration: '从供需、价格与收入结构三个层面解释变化。',
        data: topic.scoreBreakdown,
      },
      {
        id: 'takeaway',
        startFrame: 1080,
        durationFrames: 270,
        kind: 'takeaway' as const,
        narration: '下一步，继续观察原始数据是否延续。',
        data: {},
      },
    ],
    audio: null,
    captions: [],
    brand: { name: 'Signal 40', locale: 'zh-CN' as const },
    render: {
      fps: 30 as const,
      width: 1080 as const,
      height: 1920 as const,
      durationSeconds: 45,
    },
  };
}
