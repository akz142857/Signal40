import { Composition } from 'remotion';
import type { VideoProjectV2 } from '../lib/project-v2.ts';
import { getVideoTemplate } from '../lib/templates.ts';
import { Signal40Video } from './Signal40Video.tsx';

const fallback = {
  schemaVersion: '2.0',
  identity: { projectId: 'preview', topicId: 'preview', title: 'Signal 40 事实视频', locale: 'zh-CN', brand: 'Signal 40', createdAt: '2026-09-08T00:00:00.000Z' },
  research: { snapshotId: 'preview', algorithmVersion: 'preview', claims: [{ id: 'claim_1', text: '每一条事实，都应该能够回到它的来源。', kind: 'fact', quantity: null, evidence: [{ sourceId: 'source_1', articleRevisionId: null, url: 'https://example.com', stance: 'supports', quote: 'Preview', observedAt: '2026-09-08T00:00:00.000Z', locator: { type: 'url', value: 'https://example.com' } }] }], conflicts: [], approvedHash: 'preview' },
  script: { version: 1, title: 'Signal 40', targetDurationSeconds: 45, disclaimer: '本内容仅供信息参考，不构成投资建议。', modelVersion: 'preview', promptVersion: 'preview', humanModifiedBy: null, humanModifiedAt: null, lines: [{ id: 'line_1', text: '每一条事实，都应该能够回到它的来源。', screenText: '事实可回溯', claimIds: ['claim_1'], pronunciationHints: {} }, { id: 'line_2', text: '继续观察原始数据是否延续。', screenText: '持续观察', claimIds: [], pronunciationHints: {} }] },
  timeline: [
    { id: 'hook', startFrame: 0, durationFrames: 150, kind: 'hero-number', narrationLineIds: ['line_1'], visualId: 'visual_hook', transition: 'cut', visualIntent: '建立证据优先主题', screenText: '每一条事实，都应回到来源', sourceFootnote: 'Signal 40 preview contract', motion: '标题淡入' },
    { id: 'evidence', startFrame: 150, durationFrames: 570, kind: 'trend', narrationLineIds: ['line_1'], visualId: 'visual_evidence', transition: 'slide', visualIntent: '展示声明和来源', screenText: '先核验，再表达', sourceFootnote: 'Signal 40 preview contract', motion: '证据卡片依次进入' },
    { id: 'analysis', startFrame: 720, durationFrames: 450, kind: 'breakdown', narrationLineIds: [], visualId: 'visual_score', transition: 'fade', visualIntent: '展示可解释评分', screenText: '把热度拆回可核验事实', sourceFootnote: 'Signal 40 scoring preview', motion: '评分条从零生长' },
    { id: 'takeaway', startFrame: 1170, durationFrames: 180, kind: 'takeaway', narrationLineIds: ['line_2'], visualId: null, transition: 'fade', visualIntent: '显示结论边界', screenText: '持续观察原始数据', sourceFootnote: '', motion: '免责声明保持静止' },
  ],
  visuals: [{ id: 'visual_hook', type: 'text', spec: {} }, { id: 'visual_evidence', type: 'source-card', spec: {} }, { id: 'visual_score', type: 'chart', spec: { resonance: 92, sourceQuality: 88, freshness: 90, explainability: 96 } }], assets: [], audio: { provider: null, voice: null, objectKey: null, durationMs: null, speed: 1, pronunciationDictionary: {}, sha256: null, fallbackProvider: null, estimatedCostMicros: 0, music: null, mix: { voiceVolume: 1, targetLufs: -16, duckMusicUnderVoice: true } }, captions: [],
  render: { compositionId: 'Signal40Vertical', templateId: 'signal40-editorial', templateVersion: getVideoTemplate('signal40-editorial').version, fps: 30, width: 1080, height: 1920, durationSeconds: 45, snapshotHash: 'preview' },
  distribution: { channelPreset: null, accountId: null, title: 'Signal 40', description: '', tags: [], coverAssetId: null, scheduledAt: null, finalUrl: null },
  provenance: { generatedBy: 'preview', sourceProjectVersion: '2.0', immutableInputsHash: 'preview' },
} satisfies VideoProjectV2;

export function RemotionRoot() {
  return <Composition id="Signal40Vertical" component={Signal40Video} durationInFrames={1350} fps={30} width={1080} height={1920} defaultProps={{ project: fallback }} calculateMetadata={({ props }) => ({ durationInFrames: props.project.render.durationSeconds * props.project.render.fps, fps: props.project.render.fps, width: props.project.render.width, height: props.project.render.height })} />;
}
