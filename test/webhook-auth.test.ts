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

void test('webhook verification rejects missing, malformed and mismatched signatures', async () => {
  const body = '{"event":"published"}';
  const timestamp = '1788832800';
  const now = new Date(Number(timestamp) * 1000);
  const sign = async (payload: string) => {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    return `sha256=${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  };
  const signature = await sign(`${timestamp}.${body}`);

  // 缺失或格式非法的签名头
  for (const invalid of ['', 'sha256=', 'not-a-signature', signature.replace('sha256=', ''), `${signature}extra`]) {
    assert.equal(await verifyWebhookSignature({ body, timestamp, signature: invalid, secret: 'secret', now }), false);
  }
  // 缺失或非法的时间戳头
  for (const invalidTimestamp of ['', 'not-a-number', '1788832800.5']) {
    assert.equal(await verifyWebhookSignature({ body, timestamp: invalidTimestamp, signature, secret: 'secret', now }), false);
  }
  // 空 body：签名必须覆盖空 body 本身，不能拿非空 body 的签名冒充
  assert.equal(await verifyWebhookSignature({ body: '', timestamp, signature, secret: 'secret', now }), false);
  assert.equal(await verifyWebhookSignature({ body: '', timestamp, signature: await sign(`${timestamp}.`), secret: 'secret', now }), true);
});
