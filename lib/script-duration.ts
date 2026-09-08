/**
 * 旁白时长估算。
 *
 * 脚本长度与目标时长不匹配，本来要等到配音生成后才在 G5 或自动 QC 上失败——
 * 反馈链太长，改一次脚本要重新烧一次 TTS 才知道结果。这里用与语言相关的朗读速率
 * 在编辑阶段就给出估算，判定区间与 G5 的实测口径一致（60%–110%）。
 *
 * 估算永远只是估算：它用来提示和反推字数，不参与门禁判定，
 * 也绝不允许反过来去改 `render.durationSeconds` 迁就短旁白——那是发布阻断项。
 */

/** 中文朗读速率（字/秒）：按现有中文成片的实测旁白节奏取值。 */
export const CHINESE_CHARACTERS_PER_SECOND = 3.86;
/** 英文朗读速率（词/秒），约合 156 词/分钟。 */
export const ENGLISH_WORDS_PER_SECOND = 2.6;
/** 每行之间的换气停顿（秒）。 */
export const LINE_PAUSE_SECONDS = 0.25;

/** 与 G5 相同的判定区间：旁白实测时长必须落在成片时长的 60%–110%。 */
export const MIN_DURATION_RATIO = 0.6;
export const MAX_DURATION_RATIO = 1.1;

export type ScriptDurationStatus = 'ok' | 'too_short' | 'too_long';

export type ScriptDurationEstimate = {
  estimatedSeconds: number;
  targetSeconds: number;
  ratio: number;
  status: ScriptDurationStatus;
  reason: string;
  /** 按目标时长反推的字数/词数预算，供自动生成脚本时使用。 */
  budget: { characters: number; words: number };
};

type ScriptLine = { text: string };

function countHanCharacters(text: string) {
  return (text.match(/[\p{Script=Han}]/gu) ?? []).length;
}

function countLatinWords(text: string) {
  return (text.match(/[A-Za-z][A-Za-z'’-]*|\d+(?:[.,]\d+)?%?/g) ?? []).length;
}

/** 单行旁白的估算秒数（不含行间停顿）。 */
export function estimateLineSeconds(text: string, speed = 1) {
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? Math.min(2, Math.max(0.5, speed)) : 1;
  const seconds = countHanCharacters(text) / CHINESE_CHARACTERS_PER_SECOND
    + countLatinWords(text) / ENGLISH_WORDS_PER_SECOND;
  return seconds / safeSpeed;
}

/** 整段脚本的估算秒数，含行间停顿。 */
export function estimateNarrationSeconds(lines: readonly ScriptLine[], speed = 1) {
  const spoken = lines.reduce((sum, line) => sum + estimateLineSeconds(line.text, speed), 0);
  return spoken + Math.max(0, lines.length - 1) * LINE_PAUSE_SECONDS;
}

/** 目标时长对应的字数/词数预算：自动生成脚本时按它反推长度，而不是简单拼接标题。 */
export function narrationBudget(targetSeconds: number, lineCount = 1, speed = 1) {
  const safeSpeed = Number.isFinite(speed) && speed > 0 ? Math.min(2, Math.max(0.5, speed)) : 1;
  const spokenSeconds = Math.max(0, targetSeconds - Math.max(0, lineCount - 1) * LINE_PAUSE_SECONDS);
  return {
    characters: Math.floor(spokenSeconds * CHINESE_CHARACTERS_PER_SECOND * safeSpeed),
    words: Math.floor(spokenSeconds * ENGLISH_WORDS_PER_SECOND * safeSpeed),
  };
}

export function evaluateScriptDuration(input: {
  lines: readonly ScriptLine[];
  targetDurationSeconds: number;
  speed?: number;
}): ScriptDurationEstimate {
  const estimatedSeconds = estimateNarrationSeconds(input.lines, input.speed ?? 1);
  const targetSeconds = input.targetDurationSeconds;
  const ratio = targetSeconds > 0 ? estimatedSeconds / targetSeconds : 0;
  const budget = narrationBudget(targetSeconds, input.lines.length, input.speed ?? 1);
  const status: ScriptDurationStatus = ratio < MIN_DURATION_RATIO ? 'too_short' : ratio > MAX_DURATION_RATIO ? 'too_long' : 'ok';
  const shortfall = Math.max(0, Math.round((targetSeconds * MIN_DURATION_RATIO - estimatedSeconds) * CHINESE_CHARACTERS_PER_SECOND));
  const excess = Math.max(0, Math.round((estimatedSeconds - targetSeconds * MAX_DURATION_RATIO) * CHINESE_CHARACTERS_PER_SECOND));
  const reason = status === 'ok'
    ? `预计旁白 ${estimatedSeconds.toFixed(1)} 秒，落在目标 ${targetSeconds} 秒的 60%–110% 区间内。`
    : status === 'too_short'
      ? `预计旁白只有 ${estimatedSeconds.toFixed(1)} 秒，不足目标 ${targetSeconds} 秒的 60%。还需要约 ${shortfall} 字；不要通过缩短成片时长来迁就。`
      : `预计旁白 ${estimatedSeconds.toFixed(1)} 秒，超过目标 ${targetSeconds} 秒的 110%。需要删掉约 ${excess} 字。`;
  return { estimatedSeconds: Math.round(estimatedSeconds * 10) / 10, targetSeconds, ratio: Math.round(ratio * 1000) / 1000, status, reason, budget };
}
