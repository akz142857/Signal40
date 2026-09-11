import type { CSSProperties } from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, interpolate, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { VideoProjectV2 } from '../lib/project-v2.ts';
import { getVideoTemplate } from '../lib/templates.ts';

export type Signal40VideoProps = { project: VideoProjectV2 };

type Palette = ReturnType<typeof getVideoTemplate>['palette'];
type Scene = VideoProjectV2['timeline'][number];

const easeOutCubic = (value: number) => 1 - (1 - value) ** 3;

function resolveMediaSource(objectKey: string | null | undefined) {
  if (!objectKey) return null;
  if (objectKey.startsWith('data:') || /^https?:\/\//.test(objectKey)) return objectKey;
  if (objectKey.startsWith('projects/')) return `/api/v1/media?objectKey=${encodeURIComponent(objectKey)}`;
  return staticFile(objectKey);
}

function balancedTitle(value: string, maxPerLine = 11) {
  const clauses = value.match(/.*?[，。！？；：,!?;:]|.+$/g)?.map((clause) => clause.trim()).filter(Boolean) ?? [];
  if (clauses.length >= 2 && clauses.length <= 3 && clauses.every((clause) => Array.from(clause).length <= 15)) return clauses;
  const characters = Array.from(value.trim());
  if (characters.length <= maxPerLine) return [value];
  const lineCount = Math.ceil(characters.length / maxPerLine);
  const base = Math.floor(characters.length / lineCount);
  const remainder = characters.length % lineCount;
  const lines: string[] = [];
  let cursor = 0;
  for (let index = 0; index < lineCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    lines.push(characters.slice(cursor, cursor + size).join(''));
    cursor += size;
  }
  return lines;
}

function SceneFrame({ children, templateId, palette, accent = palette.primary }: { children: React.ReactNode; templateId: string; palette: Palette; accent?: string }) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 100 } });
  const isTerminal = templateId === 'signal40-terminal';
  const isBrief = templateId === 'signal40-brief';
  return (
    <AbsoluteFill style={{
      backgroundColor: palette.ink,
      backgroundImage: isTerminal
        ? `linear-gradient(${palette.paper}0a 1px, transparent 1px), linear-gradient(90deg, ${palette.paper}0a 1px, transparent 1px)`
        : isBrief ? `linear-gradient(145deg, ${palette.primary}10, transparent 42%)` : `radial-gradient(circle at 84% 12%, ${accent}12, transparent 30%)`,
      backgroundSize: isTerminal ? '54px 54px' : undefined,
      color: palette.paper,
      padding: isBrief ? '110px 84px 92px' : 92,
      fontFamily: isTerminal ? 'ui-monospace, SFMono-Regular, Menlo, PingFang SC, monospace' : 'Arial, PingFang SC, sans-serif',
      opacity: enter,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontSize: 25, letterSpacing: 4, textTransform: 'uppercase', color: palette.muted }}>
        <span style={{ width: 18, height: 18, borderRadius: isTerminal ? 2 : 20, background: accent, boxShadow: isBrief ? 'none' : `0 0 28px ${accent}` }} /> Signal 40 · Evidence first
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', transform: `translateY(${interpolate(enter, [0, 1], [48, 0])}px)` }}>{children}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `2px solid ${palette.paper}25`, paddingTop: 28, fontSize: 24, color: palette.muted }}><span>事实解读</span><span>不构成投资建议</span></div>
    </AbsoluteFill>
  );
}

function Hook({ project, scene }: Signal40VideoProps & { scene: Scene }) {
  const template = getVideoTemplate(project.render.templateId);
  const palette = template.palette;
  const frame = useCurrentFrame();
  const pulse = interpolate(Math.sin(frame / 7), [-1, 1], [0.75, 1]);
  const titleLines = balancedTitle(scene.screenText || project.identity.title);
  const longestLine = Math.max(...titleLines.map((line) => Array.from(line).length));
  const titleSize = longestLine > 12 ? 70 : longestLine > 10 ? 78 : 92;
  return <SceneFrame templateId={template.id} palette={palette}><p style={{ margin: 0, color: palette.primary, fontSize: 28, letterSpacing: 5 }}>TODAY&apos;S SIGNAL</p><h1 style={{ margin: '28px 0', fontSize: titleSize, lineHeight: 1.08, letterSpacing: -5 }}>{titleLines.map((line) => <span key={line} style={{ display: 'block' }}>{line}</span>)}</h1><div style={{ display: 'inline-flex', alignSelf: 'flex-start', padding: '18px 28px', borderRadius: template.id === 'signal40-terminal' ? 4 : 999, background: palette.primary, color: palette.ink, fontSize: 30, fontWeight: 700, transform: `scale(${pulse})` }}>{project.research.claims.length} 条声明 · {new Set(project.research.claims.flatMap((claim) => claim.evidence.map((evidence) => evidence.sourceId))).size} 个来源</div></SceneFrame>;
}

function Evidence({ project, scene }: Signal40VideoProps & { scene: Scene }) {
  const template = getVideoTemplate(project.render.templateId);
  const palette = template.palette;
  const frame = useCurrentFrame();
  return <SceneFrame templateId={template.id} palette={palette} accent={palette.blue}><p style={{ margin: 0, color: palette.blue, fontSize: 28, letterSpacing: 5 }}>WHAT THE SOURCES SAY</p><p style={{ margin: '24px 0 0', fontSize: 31, color: palette.muted }}>{scene.screenText}</p><div style={{ marginTop: 40, display: 'grid', gap: 22 }}>{project.research.claims.slice(0, 3).map((claim, index) => { const progress = interpolate(frame, [index * 14, index * 14 + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easeOutCubic }); const sourceLabels = [...new Set(claim.evidence.map((item) => { try { return new URL(item.url).hostname.replace(/^www\./, ''); } catch { return item.sourceId; } }))]; return <div key={claim.id} style={{ opacity: progress, transform: `translateX(${(1 - progress) * 70}px)`, border: `2px solid ${palette.paper}1d`, borderRadius: template.id === 'signal40-terminal' ? 4 : 28, padding: 34, background: `${palette.paper}0b` }}><p style={{ margin: 0, fontSize: 42, lineHeight: 1.35, fontWeight: 700 }}>{claim.text}</p><p style={{ margin: '22px 0 0', color: palette.muted, fontSize: 22 }}>{claim.evidence.length} 条证据 · {sourceLabels.slice(0, 3).join(' · ')}</p></div>; })}</div></SceneFrame>;
}

function Breakdown({ project, scene }: Signal40VideoProps & { scene: Scene }) {
  const template = getVideoTemplate(project.render.templateId);
  const palette = template.palette;
  const frame = useCurrentFrame();
  const breakdownVisualId = project.timeline.find((scene) => scene.kind === 'breakdown')?.visualId;
  const chart = project.visuals.find((visual) => visual.id === breakdownVisualId)
    ?? project.visuals.filter((visual) => visual.type === 'chart').sort((left, right) => Object.values(right.spec).filter((value) => typeof value === 'number').length - Object.values(left.spec).filter((value) => typeof value === 'number').length)[0];
  const source = chart?.spec.values && typeof chart.spec.values === 'object' ? chart.spec.values as Record<string, unknown> : chart?.spec ?? {};
  const translations: Record<string, string> = { resonance: '跨来源共振', velocity: '增长速度', numericImpact: '数字冲击力', sourceQuality: '来源质量', freshness: '时效性', explainability: '可解释性' };
  const dynamic = Object.entries(source).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])).slice(0, 4).map(([label, score]) => [translations[label] ?? label, Math.max(0, Math.min(100, score))] as const);
  const labels = dynamic.length ? dynamic : [['证据完整度', 96], ['来源独立性', 88], ['时效性', 92], ['可解释性', 90]] as const;
  return <SceneFrame templateId={template.id} palette={palette} accent={palette.secondary}><p style={{ margin: 0, color: palette.secondary, fontSize: 28, letterSpacing: 5 }}>WHY IT MATTERS</p><h2 style={{ margin: '26px 0 48px', fontSize: 76, lineHeight: 1.1 }}>{scene.screenText || '把热度拆回可核验的事实'}</h2><div style={{ display: 'grid', gap: 30 }}>{labels.map(([label, score], index) => { const width = interpolate(frame, [index * 10, index * 10 + 28], [0, score], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }); return <div key={label}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 28 }}><span>{label}</span><span>{Math.round(width)}</span></div><div style={{ marginTop: 12, height: 18, borderRadius: template.id === 'signal40-terminal' ? 0 : 20, background: `${palette.paper}18`, overflow: 'hidden' }}><div style={{ width: `${width}%`, height: '100%', borderRadius: template.id === 'signal40-terminal' ? 0 : 20, background: palette.secondary }} /></div></div>; })}</div></SceneFrame>;
}

function Takeaway({ project, scene }: Signal40VideoProps & { scene: Scene }) {
  const template = getVideoTemplate(project.render.templateId);
  const palette = template.palette;
  return <SceneFrame templateId={template.id} palette={palette}><p style={{ margin: 0, color: palette.primary, fontSize: 28, letterSpacing: 5 }}>THE TAKEAWAY</p><h2 style={{ margin: '30px 0', fontSize: 82, lineHeight: 1.12, letterSpacing: -5 }}>{scene.screenText || project.script.lines.at(-2)?.text || project.identity.title}</h2><p style={{ fontSize: 30, lineHeight: 1.6, color: palette.muted }}>{project.script.disclaimer}</p></SceneFrame>;
}

function SceneTransition({ scene, children }: { scene: Scene; children: React.ReactNode }) {
  const frame = useCurrentFrame();
  const duration = Math.max(1, Math.min(18, Math.floor(scene.durationFrames / 4)));
  const enter = interpolate(frame, [0, duration], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: easeOutCubic });
  const transform = scene.transition === 'slide' ? `translateX(${(1 - enter) * 90}px)` : scene.transition === 'zoom' ? `scale(${0.94 + enter * 0.06})` : undefined;
  return <AbsoluteFill style={{ opacity: scene.transition === 'cut' ? 1 : enter, transform }}>{children}</AbsoluteFill>;
}

export function Signal40Video({ project }: Signal40VideoProps) {
  const palette = getVideoTemplate(project.render.templateId).palette;
  const frame = useCurrentFrame();
  const timeMs = (frame / project.render.fps) * 1000;
  const caption = project.captions.find((item) => timeMs >= item.startMs && timeMs < item.endMs);
  const style: CSSProperties = { backgroundColor: palette.ink };
  const audioSource = resolveMediaSource(project.audio.objectKey);
  const musicSource = resolveMediaSource(project.audio.music?.objectKey);
  const voiceVolume = project.audio.mix?.voiceVolume ?? 1;
  const musicVolume = Math.min(0.5, Math.max(0, project.audio.music?.volume ?? 0.12));
  const activeScene = project.timeline.find((scene) => frame >= scene.startFrame && frame < scene.startFrame + scene.durationFrames);
  const sceneComponent = (scene: Scene) => {
    if (scene.kind === 'hero-number') return <Hook project={project} scene={scene} />;
    if (scene.kind === 'trend' || scene.kind === 'comparison') return <Evidence project={project} scene={scene} />;
    if (scene.kind === 'breakdown') return <Breakdown project={project} scene={scene} />;
    return <Takeaway project={project} scene={scene} />;
  };
  return <AbsoluteFill style={style}>
    {musicSource && <Audio src={musicSource} volume={musicVolume} loop={project.audio.music?.loop ?? true} />}
    {audioSource && <Audio src={audioSource} volume={voiceVolume} />}
    {project.timeline.map((scene) => <Sequence key={scene.id} from={scene.startFrame} durationInFrames={scene.durationFrames}><SceneTransition scene={scene}>{sceneComponent(scene)}</SceneTransition></Sequence>)}
    {activeScene?.sourceFootnote && <div style={{ position: 'absolute', left: 92, right: 92, bottom: 245, zIndex: 19, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: palette.muted, fontFamily: 'Arial, PingFang SC, sans-serif', fontSize: 19, letterSpacing: 0.4 }}>来源：{activeScene.sourceFootnote}</div>}
    {caption && <div style={{ position: 'absolute', left: 70, right: 70, bottom: 118, display: 'flex', justifyContent: 'center', zIndex: 20 }}><div style={{ maxWidth: 900, borderRadius: 22, background: '#050807dc', color: '#fff', padding: '18px 26px', fontFamily: 'Arial, PingFang SC, sans-serif', fontSize: 35, fontWeight: 700, lineHeight: 1.35, textAlign: 'center', boxShadow: '0 12px 44px #0008' }}>{caption.text}</div></div>}
  </AbsoluteFill>;
}
