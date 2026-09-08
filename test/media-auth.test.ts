import assert from 'node:assert/strict';
import test from 'node:test';
import { signMediaAccess, verifyMediaAccess } from '../lib/media-auth.ts';

void test('object-level media signatures are scoped, expiring, and tamper resistant', async () => {
  const secret = 'test-secret-with-enough-entropy';
  const objectKey = 'projects/project_1/assets/asset_1/video.mp4';
  const now = Date.parse('2026-09-08T00:00:00.000Z');
  const expires = Math.floor(now / 1000) + 300;
  const signature = await signMediaAccess(secret, objectKey, expires);
  assert.equal(await verifyMediaAccess(secret, objectKey, expires, signature, now), true);
  assert.equal(await verifyMediaAccess(secret, `${objectKey}.other`, expires, signature, now), false);
  assert.equal(await verifyMediaAccess(secret, objectKey, expires, signature, now + 301_000), false);
  assert.equal(await verifyMediaAccess(secret, objectKey, Math.floor(now / 1000) + 901, await signMediaAccess(secret, objectKey, Math.floor(now / 1000) + 901), now), false);
});
