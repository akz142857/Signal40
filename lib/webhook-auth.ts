import { sha256Hex } from './hash.ts';

function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) mismatch |= leftBytes[index] ^ rightBytes[index];
  return mismatch === 0;
}

export async function verifyWebhookSignature(input: { body: string; timestamp: string; signature: string; secret: string; now?: Date }) {
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isInteger(timestampSeconds) || Math.abs((input.now ?? new Date()).valueOf() / 1000 - timestampSeconds) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(input.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${input.timestamp}.${input.body}`));
  const expected = `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  return constantTimeEqual(expected, input.signature.toLowerCase());
}

export function webhookPayloadHash(body: string) {
  return `sha256:${sha256Hex(body)}`;
}
