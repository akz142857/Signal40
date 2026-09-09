import { Buffer } from 'node:buffer';

export type SensitiveCanaryEncoding =
  | 'raw'
  | 'url'
  | 'base64'
  | 'base64url'
  | 'hex';

export type SensitiveCanarySurface = {
  label: string;
  value: unknown;
};

export type SensitiveCanaryFinding = {
  label: string;
  encoding: SensitiveCanaryEncoding;
};

const MIN_CANARY_LENGTH = 16;

export function validateSensitiveCanary(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_CANARY_LENGTH) {
    throw new Error(`敏感值 canary 必须至少 ${MIN_CANARY_LENGTH} 个字符。`);
  }
  if (value.includes('\r') || value.includes('\n') || value.includes('\u0000')) {
    throw new Error('敏感值 canary 不能包含换行或 NUL。');
  }
  return value;
}

export function sensitiveCanaryVariants(canaryInput: unknown) {
  const canary = validateSensitiveCanary(canaryInput);
  const bytes = Buffer.from(canary, 'utf8');
  const candidates: Array<[SensitiveCanaryEncoding, string]> = [
    ['raw', canary],
    ['url', encodeURIComponent(canary)],
    ['base64', bytes.toString('base64')],
    ['base64url', bytes.toString('base64url')],
    ['hex', bytes.toString('hex')],
  ];
  return candidates.map(([encoding, value]) => ({ encoding, value }));
}

function serializeSurface(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    const compressed =
      (bytes[0] === 0x1f && bytes[1] === 0x8b) ||
      (bytes[0] === 0x50 && bytes[1] === 0x4b) ||
      (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd);
    if (compressed || bytes.includes(0)) {
      throw new Error('敏感值扫描拒绝压缩或二进制制品；请先解包并导出为 UTF-8 文本。');
    }
    return bytes.toString('utf8');
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new Error('敏感值扫描制品必须可序列化。');
  }
}

export function scanSensitiveCanary(
  surfaces: SensitiveCanarySurface[],
  canaryInput: unknown,
): SensitiveCanaryFinding[] {
  const variants = sensitiveCanaryVariants(canaryInput);
  const findings: SensitiveCanaryFinding[] = [];
  for (const surface of surfaces) {
    if (!surface.label.trim()) throw new Error('敏感值扫描制品必须有非空标签。');
    const serialized = serializeSurface(surface.value);
    for (const variant of variants) {
      if (serialized.includes(variant.value)) {
        findings.push({ label: surface.label, encoding: variant.encoding });
      }
    }
  }
  return findings;
}

export function assertNoSensitiveCanary(
  surfaces: SensitiveCanarySurface[],
  canaryInput: unknown,
) {
  const findings = scanSensitiveCanary(surfaces, canaryInput);
  if (!findings.length) return;
  const locations = findings
    .map(({ label, encoding }) => `${label}(${encoding})`)
    .join(', ');
  throw new Error(`敏感值 canary 扫描失败：${locations}`);
}
