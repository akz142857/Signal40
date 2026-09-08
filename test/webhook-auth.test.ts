import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWebhookSignature } from '../lib/webhook-auth.ts';

void test('webhook verification enforces HMAC and a five-minute replay window', async () => {
  const body = '{"event":"published"}';
  const timestamp = '1788832800';
  const timestampMs = Number(timestamp) * 1000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  const signature = `sha256=${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  assert.equal(await verifyWebhookSignature({ body, timestamp, signature, secret: 'secret', now: new Date(timestampMs) }), true);
  assert.equal(await verifyWebhookSignature({ body, timestamp, signature, secret: 'wrong', now: new Date(timestampMs) }), false);
  assert.equal(await verifyWebhookSignature({ body, timestamp, signature, secret: 'secret', now: new Date(timestampMs + 301_000) }), false);
});
