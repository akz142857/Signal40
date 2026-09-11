import type { TopicCandidate } from './domain.ts';
import { getVideoTemplate } from './templates.ts';
import { narrationBudget } from './script-duration.ts';
import { stableHash } from './workflow.ts';

export type EvidenceStance = 'supports' | 'refutes' | 'context';
export type RightsStatus = 'cleared' | 'restricted' | 'unknown';
export type ClaimKind = 'fact' | 'numeric' | 'comparison' | 'causal' | 'prediction' | 'analysis' | 'opinion' | 'disclaimer';

export type VideoProjectV2 = {
  schemaVersion: '2.0';
  identity: {
    projectId: string;
    topicId: string;
    title: string;
    locale: string;
    brand: string;
    createdAt: string;
  };
  research: {
    snapshotId: string;
    algorithmVersion: string;
    claims: Array<{
      id: string;
      text: string;
      kind: ClaimKind;
      quantity: {
        value: number;
        unit: string;
        currency: string | null;
        timeRange: string;
        basis: string;
        entity: string;
        uncertainty: string | null;
      } | null;
      evidence: Array<{
        sourceId: string;
        articleRevisionId: string | null;
        url: string;
        stance: EvidenceStance;
        quote: string;
        observedAt: string;
        locator: {
          type: 'page' | 'paragraph' | 'table' | 'timecode' | 'section' | 'url';
          value: string;
        };
      }>;
    }>;
    conflicts: Array<{ claimId: string; description: string; resolution: string | null }>;
    approvedHash: string;
  };
  script: {
    version: number;
    title: string;
    targetDurationSeconds: number;
    disclaimer: string;
    modelVersion: string;
    promptVersion: string;
    humanModifiedBy: string | null;
    humanModifiedAt: string | null;
    lines: Array<{
      id: string;
      text: string;
      screenText: string;
      claimIds: string[];
      pronunciationHints: Record<string, string>;
      locked?: boolean;
      comment?: string;
    }>;
  };
  timeline: Array<{
    id: string;
    startFrame: number;
    durationFrames: number;
    kind: 'hero-number' | 'comparison' | 'trend' | 'breakdown' | 'takeaway';
    narrationLineIds: string[];
    visualId: string | null;
    transition: 'cut' | 'fade' | 'slide' | 'zoom';
    visualIntent: string;
    screenText: string;
    sourceFootnote: string;
    motion: string;
  }>;
  visuals: Array<{
    id: string;
    type: 'chart' | 'text' | 'image' | 'source-card';
    spec: Record<string, unknown>;
  }>;
  assets: Array<{
    id: string;
    objectKey: string;
    mediaType: string;
    rightsStatus: RightsStatus;
    rightsNote: string;
    sha256: string;
    usageScope: string;
    provenance: {
      kind: 'uploaded' | 'generated' | 'derived';
      source: string;
      model: string | null;
      prompt: string | null;
      generatedAt: string | null;
    };
    retentionUntil: string | null;
    crop: { x: number; y: number; width: number; height: number } | null;
    derivedFromAssetId: string | null;
  }>;
  audio: {
    provider: string | null;
    voice: string | null;
    objectKey: string | null;
    durationMs: number | null;
    speed: number;
    pronunciationDictionary: Record<string, string>;
    sha256: string | null;
    fallbackProvider: string | null;
    estimatedCostMicros: number;
    music: {
      assetId: string;
      objectKey: string;
      volume: number;
      loop: boolean;
    } | null;
    mix: {
      voiceVolume: number;
      targetLufs: number;
      duckMusicUnderVoice: boolean;
    };
  };
  captions: Array<{
    startMs: number;
    endMs: number;
    text: string;
    lineId: string;
    granularity: 'sentence' | 'word';
    style: 'default' | 'emphasis' | 'disclaimer';
    safeArea: { left: number; right: number; top: number; bottom: number };
    manuallyEdited: boolean;
  }>;
  render: {
    compositionId: string;
    templateId: string;
    templateVersion: string;
    fps: 30;
    width: 1080;
    height: 1920;
    durationSeconds: number;
    snapshotHash: string;
  };
  distribution: {
    channelPreset: string | null;
    accountId: string | null;
    title: string;
    description: string;
    tags: string[];
    coverAssetId: string | null;
    scheduledAt: string | null;
    finalUrl: string | null;
  };
  provenance: {
    generatedBy: string;
    sourceProjectVersion: string;
    immutableInputsHash: string;
  };
};

type VideoProjectV1 = {
  version: '1.0';
  topic: { id: string; title: string; score: number };
  claims: Array<{ text: string; sourceIds: string[] }>;
  sources: Array<{ id: string; title: string; url: string; sourceType: string }>;
  scenes: Array<{
    id: string;
    startFrame: number;
    durationFrames: number;
    kind: VideoProjectV2['timeline'][number]['kind'];
    narration: string;
    data?: Record<string, unknown>;
  }>;
  brand: { name: string; locale: string };
  render: { fps: 30; width: 1080; height: 1920; durationSeconds: number };
};

export function upgradeProjectV2Defaults(project: VideoProjectV2) {
  const mutable = project as VideoProjectV2 & Record<string, unknown>;
  for (const claim of mutable.research.claims) {
    claim.quantity ??= null;
    for (const evidence of claim.evidence) {
      evidence.articleRevisionId ??= null;
      evidence.locator ??= { type: 'url', value: evidence.url };
    }
  }
  mutable.script.modelVersion ??= 'legacy-unspecified';
  mutable.script.promptVersion ??= 'legacy-unspecified';
  mutable.script.humanModifiedBy ??= null;
  mutable.script.humanModifiedAt ??= null;
  for (const line of mutable.script.lines) line.screenText ??= line.text;
  for (const [index, scene] of mutable.timeline.entries()) {
    scene.transition ??= index === 0 ? 'cut' : 'fade';
    scene.visualIntent ??= `场景 ${scene.kind} 的信息表达`;
    scene.screenText ??= mutable.script.lines.find((line) => scene.narrationLineIds.includes(line.id))?.screenText ?? '';
    if (!scene.sourceFootnote?.trim()) {
      scene.sourceFootnote = scene.narrationLineIds.some((lineId) => mutable.script.lines.find((line) => line.id === lineId)?.claimIds.length)
        ? mutable.research.claims.flatMap((claim) => claim.evidence).at(0)?.url ?? ''
        : '';
    }
    scene.motion ??= 'default';
  }
  for (const asset of mutable.assets) {
    asset.usageScope ??= 'current-project-and-configured-channels';
    asset.provenance ??= { kind: 'uploaded', source: 'legacy-import', model: null, prompt: null, generatedAt: null };
    asset.retentionUntil ??= null;
    asset.crop ??= null;
    asset.derivedFromAssetId ??= null;
  }
  mutable.audio.speed ??= 1;
  mutable.audio.pronunciationDictionary ??= Object.assign({}, ...mutable.script.lines.map((line) => line.pronunciationHints));
  mutable.audio.sha256 ??= null;
  mutable.audio.fallbackProvider ??= null;
  mutable.audio.estimatedCostMicros ??= 0;
  for (const caption of mutable.captions) {
    caption.granularity ??= 'sentence';
    caption.style ??= caption.lineId.includes('takeaway') ? 'disclaimer' : 'default';
    caption.safeArea ??= { left: 72, right: 72, top: 160, bottom: 280 };
    caption.manuallyEdited ??= false;
  }
  const template = getVideoTemplate(mutable.render.templateId);
  mutable.render.templateId = template.id;
  mutable.render.templateVersion = template.version;
  mutable.distribution.accountId ??= null;
  mutable.distribution.tags ??= [];
  mutable.distribution.coverAssetId ??= null;
  mutable.distribution.finalUrl ??= null;
  return mutable;
}

export function computeRenderSnapshotHash(project: VideoProjectV2) {
  return stableHash({
    identity: project.identity,
    research: project.research,
    script: project.script,
    timeline: project.timeline,
    visuals: project.visuals,
    assets: project.assets,
    audio: project.audio,
    captions: project.captions,
    render: {
      compositionId: project.render.compositionId,
      templateId: project.render.templateId ?? 'signal40-editorial',
      templateVersion: project.render.templateVersion,
      fps: project.render.fps,
      width: project.render.width,
      height: project.render.height,
      durationSeconds: project.render.durationSeconds,
    },
  });
}

export function createProjectV2(topic: TopicCandidate, now = new Date()): VideoProjectV2 {
  if (!topic.gate.passed || topic.verificationStatus !== 'verified') {
    throw new Error('选题必须通过自动证据门禁和编辑批准后才能创建项目。');
  }
  const projectId = `project_${topic.id.replace(/^topic_/, '')}`;
  const claims = topic.articles
    .filter((article) => ['filing', 'company', 'market'].includes(article.sourceType))
    .slice(0, 3)
    .map((article, index) => ({
      id: `claim_${index + 1}`,
      text: article.summary || article.title,
      kind: 'fact' as const,
      quantity: null,
      evidence: topic.articles.map((source) => ({
        sourceId: source.id,
        articleRevisionId: null,
        url: source.url,
        stance: 'supports' as const,
        quote: source.summary || source.title,
        observedAt: source.publishedAt,
        locator: { type: 'url' as const, value: source.url },
      })),
  }));
  if (!claims.length) throw new Error('项目没有可冻结的原始声明。');
  const targetDurationSeconds = 45;
  const lineCount = claims.length + 2;
  const characterBudget = narrationBudget(targetDurationSeconds, lineCount).characters;
  const clip = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
  const hookBudget = Math.max(24, Math.floor(characterBudget * 0.2));
  const takeawayBudget = Math.max(42, Math.floor(characterBudget * 0.3));
  const evidenceBudget = Math.max(20, Math.floor((characterBudget - hookBudget - takeawayBudget) / claims.length));
  const lines = [
    { id: 'line_hook', text: clip(`今天关注${topic.title}。接下来只依据已核验来源，拆解这件事的关键信号。`, hookBudget), screenText: topic.title, claimIds: [claims[0].id], pronunciationHints: {}, locked: false, comment: '' },
    ...claims.map((claim, index) => ({
      id: `line_evidence_${index + 1}`,
      text: clip(`第${index + 1}个已核验事实：${claim.text}。这条信息由${claim.evidence.length}条来源记录支持。`, evidenceBudget),
      screenText: clip(claim.text, 36),
      claimIds: [claim.id],
      pronunciationHints: {},
      locked: false,
      comment: '',
    })),
    {
      id: 'line_takeaway',
      text: clip('把这些事实放在一起看，重点是事件本身以及后续变化。以上信息仅用于事实解读，不构成任何投资建议。', takeawayBudget),
      screenText: '不构成投资建议',
      claimIds: [],
      pronunciationHints: {},
      locked: false,
      comment: '',
    },
  ];
  const researchCore = { claims, conflicts: [] as VideoProjectV2['research']['conflicts'] };
  const timeline: VideoProjectV2['timeline'] = [
    { id: 'hook', startFrame: 0, durationFrames: 120, kind: 'hero-number', narrationLineIds: ['line_hook'], visualId: 'visual_hero', transition: 'cut', visualIntent: '在首屏建立事件与主体', screenText: topic.title, sourceFootnote: topic.articles[0]?.source ?? '', motion: '标题轻微上移并淡入' },
    { id: 'evidence', startFrame: 120, durationFrames: 600, kind: 'trend', narrationLineIds: lines.slice(1, -1).map((line) => line.id), visualId: 'visual_sources', transition: 'slide', visualIntent: '并列展示原始来源与核心事实', screenText: '权威来源交叉验证', sourceFootnote: topic.articles.slice(0, 2).map((article) => article.source).join(' · '), motion: '来源卡片依次进入' },
    { id: 'analysis', startFrame: 720, durationFrames: 450, kind: 'breakdown', narrationLineIds: [], visualId: 'visual_score', transition: 'fade', visualIntent: '解释为何该事件值得关注', screenText: '信号拆解', sourceFootnote: 'Signal 40 评分模型', motion: '条形图从零基线生长' },
    { id: 'takeaway', startFrame: 1170, durationFrames: 180, kind: 'takeaway', narrationLineIds: ['line_takeaway'], visualId: null, transition: 'fade', visualIntent: '明确非投资建议与信息边界', screenText: '不构成投资建议', sourceFootnote: '', motion: '免责声明保持静止以确保可读' },
  ];
  const base: VideoProjectV2 = {
    schemaVersion: '2.0' as const,
    identity: { projectId, topicId: topic.id, title: topic.title, locale: 'zh-CN', brand: 'Signal 40', createdAt: now.toISOString() },
    research: { snapshotId: `research_${stableHash(researchCore)}`, algorithmVersion: 'signal40-score/1.0.0', ...researchCore, approvedHash: stableHash(researchCore) },
    script: { version: 1, title: topic.title, targetDurationSeconds, disclaimer: '本内容仅供信息参考，不构成投资建议。', modelVersion: 'deterministic-template/1.1.0', promptVersion: 'signal40-script/1.1.0', humanModifiedBy: null, humanModifiedAt: null, lines },
    timeline,
    visuals: [
      { id: 'visual_hero', type: 'text' as const, spec: { title: topic.title } },
      { id: 'visual_sources', type: 'source-card' as const, spec: { sourceCount: topic.sourceCount } },
      { id: 'visual_score', type: 'chart' as const, spec: { chartType: 'bar', values: topic.scoreBreakdown, unit: 'score/100', transform: 'none', zeroBaseline: true, sourceClaimIds: claims.map((claim) => claim.id) } },
    ],
    assets: [],
    audio: { provider: null, voice: null, objectKey: null, durationMs: null, speed: 1, pronunciationDictionary: {}, sha256: null, fallbackProvider: 'macos-say-local', estimatedCostMicros: 0, music: null, mix: { voiceVolume: 1, targetLufs: -16, duckMusicUnderVoice: true } },
    captions: [],
    render: { compositionId: 'Signal40Vertical', templateId: 'signal40-editorial', templateVersion: getVideoTemplate('signal40-editorial').version, fps: 30 as const, width: 1080 as const, height: 1920 as const, durationSeconds: targetDurationSeconds, snapshotHash: '' },
    distribution: { channelPreset: null, accountId: null, title: topic.title, description: '事实解读。\n\n本内容不构成投资建议。', tags: [], coverAssetId: null, scheduledAt: null, finalUrl: null },
    provenance: { generatedBy: 'signal40-control-plane', sourceProjectVersion: '2.0', immutableInputsHash: '' },
  };
  const immutableInputsHash = computeRenderSnapshotHash(base);
  base.render.snapshotHash = immutableInputsHash;
  base.provenance.immutableInputsHash = immutableInputsHash;
  return base;
}

export function migrateProjectV1(input: VideoProjectV1, now = new Date()): VideoProjectV2 {
  if (input.version !== '1.0') throw new Error('仅支持迁移 1.0 项目。');
  const claims = input.claims.map((claim, index) => ({
    id: `claim_${index + 1}`,
    text: claim.text,
    kind: 'fact' as const,
    quantity: null,
    evidence: claim.sourceIds.flatMap((sourceId) => {
      const source = input.sources.find((candidate) => candidate.id === sourceId);
      return source ? [{ sourceId, articleRevisionId: null, url: source.url, stance: 'supports' as const, quote: source.title, observedAt: now.toISOString(), locator: { type: 'url' as const, value: source.url } }] : [];
    }),
  }));
  const lines = input.scenes.map((scene) => ({ id: `line_${scene.id}`, text: scene.narration, screenText: scene.narration, claimIds: claims.map((claim) => claim.id), pronunciationHints: {}, locked: false, comment: '' }));
  const core = { claims, conflicts: [] as VideoProjectV2['research']['conflicts'] };
  const migrated: VideoProjectV2 = {
    schemaVersion: '2.0',
    identity: { projectId: `project_${input.topic.id.replace(/^topic_/, '')}`, topicId: input.topic.id, title: input.topic.title, locale: input.brand.locale, brand: input.brand.name, createdAt: now.toISOString() },
    research: { snapshotId: `research_${stableHash(core)}`, algorithmVersion: 'legacy/1.0', ...core, approvedHash: stableHash(core) },
    script: { version: 1, title: input.topic.title, targetDurationSeconds: input.render.durationSeconds, disclaimer: '本内容仅供信息参考，不构成投资建议。', modelVersion: 'legacy/1.0', promptVersion: 'legacy/1.0', humanModifiedBy: null, humanModifiedAt: null, lines },
    timeline: input.scenes.map((scene, index) => ({ id: scene.id, startFrame: scene.startFrame, durationFrames: scene.durationFrames, kind: scene.kind, narrationLineIds: [`line_${scene.id}`], visualId: `visual_${scene.id}`, transition: index === 0 ? 'cut' : 'fade', visualIntent: `迁移自 1.0 场景 ${scene.id}`, screenText: scene.narration, sourceFootnote: '', motion: 'legacy-default' })),
    visuals: input.scenes.map((scene) => ({ id: `visual_${scene.id}`, type: scene.kind === 'hero-number' ? 'text' : 'chart', spec: scene.data ?? {} })),
    assets: [],
    audio: { provider: null, voice: null, objectKey: null, durationMs: null, speed: 1, pronunciationDictionary: {}, sha256: null, fallbackProvider: 'macos-say-local', estimatedCostMicros: 0, music: null, mix: { voiceVolume: 1, targetLufs: -16, duckMusicUnderVoice: true } },
    captions: [],
    render: { compositionId: 'Signal40Vertical', templateId: 'signal40-editorial', templateVersion: getVideoTemplate('signal40-editorial').version, fps: input.render.fps, width: input.render.width, height: input.render.height, durationSeconds: input.render.durationSeconds, snapshotHash: '' },
    distribution: { channelPreset: null, accountId: null, title: input.topic.title, description: '事实解读。\n\n本内容不构成投资建议。', tags: [], coverAssetId: null, scheduledAt: null, finalUrl: null },
    provenance: { generatedBy: 'signal40-v1-migrator', sourceProjectVersion: '1.0', immutableInputsHash: '' },
  };
  const hash = computeRenderSnapshotHash(migrated);
  migrated.render.snapshotHash = hash;
  migrated.provenance.immutableInputsHash = hash;
  return migrated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(errors: string[], value: unknown, allowed: readonly string[], path: string) {
  if (!isRecord(value)) return;
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) errors.push(`${path} 包含未知字段 ${key}`);
}

export function validateProjectV2(input: VideoProjectV2) {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ['项目必须是对象'] };
  rejectUnknownKeys(errors, input, ['schemaVersion', 'identity', 'research', 'script', 'timeline', 'visuals', 'assets', 'audio', 'captions', 'render', 'distribution', 'provenance'], 'project');
  const structuralChecks: Array<[unknown, string]> = [
    [input.identity, 'identity'], [input.research, 'research'], [input.script, 'script'], [input.audio, 'audio'],
    [input.render, 'render'], [input.distribution, 'distribution'], [input.provenance, 'provenance'],
  ];
  for (const [value, path] of structuralChecks) if (!isRecord(value)) errors.push(`${path} 必须是对象`);
  const arrayChecks: Array<[unknown, string]> = [
    [input.research?.claims, 'research.claims'], [input.research?.conflicts, 'research.conflicts'], [input.script?.lines, 'script.lines'],
    [input.timeline, 'timeline'], [input.visuals, 'visuals'], [input.assets, 'assets'], [input.captions, 'captions'],
  ];
  for (const [value, path] of arrayChecks) if (!Array.isArray(value)) errors.push(`${path} 必须是数组`);
  for (const [value, path] of arrayChecks) if (Array.isArray(value) && value.some((item) => !isRecord(item))) errors.push(`${path} 的每一项都必须是对象`);
  if (errors.length) return { valid: false, errors };
  rejectUnknownKeys(errors, input.identity, ['projectId', 'topicId', 'title', 'locale', 'brand', 'createdAt'], 'identity');
  rejectUnknownKeys(errors, input.research, ['snapshotId', 'algorithmVersion', 'claims', 'conflicts', 'approvedHash'], 'research');
  rejectUnknownKeys(errors, input.script, ['version', 'title', 'targetDurationSeconds', 'disclaimer', 'modelVersion', 'promptVersion', 'humanModifiedBy', 'humanModifiedAt', 'lines'], 'script');
  rejectUnknownKeys(errors, input.audio, ['provider', 'voice', 'objectKey', 'durationMs', 'speed', 'pronunciationDictionary', 'sha256', 'fallbackProvider', 'estimatedCostMicros', 'music', 'mix'], 'audio');
  rejectUnknownKeys(errors, input.audio.music, ['assetId', 'objectKey', 'volume', 'loop'], 'audio.music');
  rejectUnknownKeys(errors, input.audio.mix, ['voiceVolume', 'targetLufs', 'duckMusicUnderVoice'], 'audio.mix');
  rejectUnknownKeys(errors, input.render, ['compositionId', 'templateId', 'templateVersion', 'fps', 'width', 'height', 'durationSeconds', 'snapshotHash'], 'render');
  rejectUnknownKeys(errors, input.distribution, ['channelPreset', 'accountId', 'title', 'description', 'tags', 'coverAssetId', 'scheduledAt', 'finalUrl'], 'distribution');
  rejectUnknownKeys(errors, input.provenance, ['generatedBy', 'sourceProjectVersion', 'immutableInputsHash'], 'provenance');
  if (input.schemaVersion !== '2.0') errors.push('schemaVersion 必须为 2.0');
  if (!input.identity?.projectId || !input.identity?.topicId) errors.push('缺少项目身份');
  if (!input.research?.claims.length) errors.push('至少需要一条声明');
  for (const claim of input.research?.claims ?? []) {
    if (!isRecord(claim) || !Array.isArray(claim.evidence)) { errors.push('声明结构无效'); continue; }
    if (claim.evidence.some((evidence) => !isRecord(evidence))) { errors.push(`声明 ${String(claim.id ?? 'unknown')} 的证据结构无效`); continue; }
    rejectUnknownKeys(errors, claim, ['id', 'text', 'kind', 'quantity', 'evidence'], `claim.${String(claim.id ?? 'unknown')}`);
    rejectUnknownKeys(errors, claim.quantity, ['value', 'unit', 'currency', 'timeRange', 'basis', 'entity', 'uncertainty'], `claim.${String(claim.id ?? 'unknown')}.quantity`);
    for (const evidence of claim.evidence) {
      rejectUnknownKeys(errors, evidence, ['sourceId', 'articleRevisionId', 'url', 'stance', 'quote', 'observedAt', 'locator'], `claim.${String(claim.id ?? 'unknown')}.evidence`);
      if (isRecord(evidence)) rejectUnknownKeys(errors, evidence.locator, ['type', 'value'], `claim.${String(claim.id ?? 'unknown')}.evidence.locator`);
    }
    if (!['opinion', 'disclaimer'].includes(claim.kind) && !claim.evidence.some((item) => item.stance === 'supports')) errors.push(`可核验声明 ${claim.id} 缺少支持证据`);
    if (claim.kind === 'numeric' && (!claim.quantity || !claim.quantity.unit || !claim.quantity.timeRange || !claim.quantity.basis || !claim.quantity.entity)) errors.push(`数字声明 ${claim.id} 缺少值、单位、统计周期、比较基准或主体`);
    if (claim.evidence.some((item) => !item.locator?.type || !item.locator.value)) errors.push(`声明 ${claim.id} 的证据缺少定位信息`);
  }
  for (const conflict of input.research.conflicts) {
    if (!isRecord(conflict)) { errors.push('冲突记录结构无效'); continue; }
    rejectUnknownKeys(errors, conflict, ['claimId', 'description', 'resolution'], `conflict.${String(conflict.claimId ?? 'unknown')}`);
  }
  const claimIds = new Set(input.research?.claims.map((claim) => claim.id));
  for (const line of input.script?.lines ?? []) {
    if (!isRecord(line) || !Array.isArray(line.claimIds)) { errors.push('脚本行结构无效'); continue; }
    rejectUnknownKeys(errors, line, ['id', 'text', 'screenText', 'claimIds', 'pronunciationHints', 'locked', 'comment'], `script.line.${String(line.id ?? 'unknown')}`);
    if (!line.screenText?.trim()) errors.push(`脚本行 ${line.id} 缺少屏幕文字`);
    for (const claimId of line.claimIds) if (!claimIds.has(claimId)) errors.push(`脚本行 ${line.id} 引用了不存在的声明 ${claimId}`);
  }
  for (const visual of input.visuals ?? []) {
    if (!isRecord(visual) || !isRecord(visual.spec)) { errors.push('视觉对象结构无效'); continue; }
    rejectUnknownKeys(errors, visual, ['id', 'type', 'spec'], `visual.${String(visual.id ?? 'unknown')}`);
    if (visual.type !== 'chart') continue;
    if (visual.spec.zeroBaseline === false) errors.push(`图表 ${visual.id} 必须从零基线开始或提供专项比例尺说明`);
    if ('values' in visual.spec && (!visual.spec.unit || !Array.isArray(visual.spec.sourceClaimIds))) errors.push(`图表 ${visual.id} 缺少单位或声明来源`);
  }
  if (input.audio?.music) {
    if (input.audio.music.volume < 0 || input.audio.music.volume > 0.5) errors.push('背景音乐音量必须在 0–0.5 之间');
    if (!input.assets.some((asset) => asset.id === input.audio.music?.assetId && asset.objectKey === input.audio.music?.objectKey)) errors.push('背景音乐必须引用当前项目资产');
  }
  if (input.audio?.objectKey) {
    if (!/^([a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(input.audio.sha256 ?? '')) errors.push('配音对象缺少 SHA-256 内容哈希');
    if (!input.audio.durationMs || input.audio.durationMs < 500) errors.push('配音对象缺少有效时长');
    if (!input.captions.length) errors.push('配音对象缺少对齐字幕');
    const invalidCaption = input.captions.some((caption) => caption.startMs < 0 || caption.endMs <= caption.startMs || caption.endMs > (input.audio.durationMs ?? 0) + 250);
    if (invalidCaption) errors.push('字幕时间轴超出配音时长');
  }
  if (input.audio?.mix && (input.audio.mix.targetLufs < -24 || input.audio.mix.targetLufs > -10)) errors.push('目标响度必须在 -24 到 -10 LUFS 之间');
  const template = getVideoTemplate(input.render?.templateId);
  if (input.render?.templateId && template.id !== input.render.templateId) errors.push(`未知模板 ${input.render.templateId}`);
  if (input.render?.templateVersion !== template.version) errors.push(`模板版本必须为 ${template.version}`);
  let expectedFrame = 0;
  for (const scene of input.timeline ?? []) {
    if (!isRecord(scene) || !Array.isArray(scene.narrationLineIds)) { errors.push('场景结构无效'); continue; }
    rejectUnknownKeys(errors, scene, ['id', 'startFrame', 'durationFrames', 'kind', 'narrationLineIds', 'visualId', 'transition', 'visualIntent', 'screenText', 'sourceFootnote', 'motion'], `scene.${String(scene.id ?? 'unknown')}`);
    if (scene.startFrame !== expectedFrame) errors.push(`场景 ${scene.id} 与上一场景不连续`);
    expectedFrame = scene.startFrame + scene.durationFrames;
    if (!scene.visualIntent?.trim() || !scene.motion?.trim()) errors.push(`场景 ${scene.id} 缺少视觉意图或镜头运动`);
  }
  for (const asset of input.assets ?? []) {
    if (!isRecord(asset) || !isRecord(asset.provenance)) { errors.push('资产结构无效'); continue; }
    rejectUnknownKeys(errors, asset, ['id', 'objectKey', 'mediaType', 'rightsStatus', 'rightsNote', 'sha256', 'usageScope', 'provenance', 'retentionUntil', 'crop', 'derivedFromAssetId'], `asset.${String(asset.id ?? 'unknown')}`);
    rejectUnknownKeys(errors, asset.provenance, ['kind', 'source', 'model', 'prompt', 'generatedAt'], `asset.${String(asset.id ?? 'unknown')}.provenance`);
    rejectUnknownKeys(errors, asset.crop, ['x', 'y', 'width', 'height'], `asset.${String(asset.id ?? 'unknown')}.crop`);
    if (!asset.usageScope?.trim() || !asset.provenance?.source?.trim()) errors.push(`资产 ${asset.id} 缺少使用范围或来源溯源`);
    if (asset.provenance?.kind === 'generated' && (!asset.provenance.model || !asset.provenance.prompt || !asset.provenance.generatedAt)) errors.push(`生成资产 ${asset.id} 缺少模型、提示词或生成时间`);
  }
  for (const caption of input.captions ?? []) {
    if (!isRecord(caption) || !isRecord(caption.safeArea)) { errors.push('字幕结构无效'); continue; }
    rejectUnknownKeys(errors, caption, ['startMs', 'endMs', 'text', 'lineId', 'granularity', 'style', 'safeArea', 'manuallyEdited'], `caption.${String(caption.lineId ?? 'unknown')}`);
    rejectUnknownKeys(errors, caption.safeArea, ['left', 'right', 'top', 'bottom'], `caption.${String(caption.lineId ?? 'unknown')}.safeArea`);
  }
  if (input.render?.snapshotHash !== input.provenance?.immutableInputsHash) errors.push('渲染快照与溯源哈希不一致');
  if (input.render?.snapshotHash !== computeRenderSnapshotHash(input)) errors.push('渲染快照哈希与当前全部输入不一致');
  return { valid: errors.length === 0, errors };
}
