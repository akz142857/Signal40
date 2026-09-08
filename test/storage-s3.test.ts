import assert from 'node:assert/strict';
import test from 'node:test';
import { createS3Client, createS3Storage } from '../lib/storage-s3.ts';

/**
 * 对真实对象存储端点跑一遍存储契约（生产与本地都是 Cloudflare R2）。
 *
 * 没配 `S3_ENDPOINT` / `S3_BUCKET` 时整组跳过，这样默认的 `npm test` 不依赖外部服务；
 * 但适配器吸收的那几处差异——list 不带用户元数据、complete 不返回对象大小、
 * 没有内建 SHA-256、以及 R2 拒绝 SDK 默认的 CRC32 校验和头——只有真跑才能验。
 *
 * 注意：R2 要求分片上传里除最后一片外每片大小相同（S3 只要求 ≥5 MB）。
 * 应用侧的分片大小固定为 10 MB，满足这个约束。
 */

const endpoint = process.env.S3_ENDPOINT;
const bucket = process.env.S3_BUCKET;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
// 凭据也要齐：.env.example 里的端点是带 <account_id> 的占位串，
// 只看端点非空会把「还没填凭据」误判成「已配置」，然后去连一个假地址。
const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey) && !endpoint!.includes('<');
const skip = configured ? false : '未配置对象存储凭据（S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY），跳过对象存储契约测试';

function storage() {
  // 和 lib/runtime.ts 走同一个构造函数，配置差异不会在测试和生产之间漂移。
  return createS3Storage({
    bucket: bucket!,
    client: createS3Client({
      endpoint,
      region: process.env.S3_REGION,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE ? process.env.S3_FORCE_PATH_STYLE === 'true' : undefined,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    }),
  });
}

async function readAll(body: ReadableStream) {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

void test('对象读写删与前缀列举', { skip }, async () => {
  const media = storage();
  const prefix = `test/${crypto.randomUUID()}/`;
  const key = `${prefix}note.json`;

  assert.equal(await media.get(`${prefix}missing`), null, '不存在的对象应返回 null 而不是抛错');

  await media.put(key, JSON.stringify({ hello: '世界' }), {
    contentType: 'application/json',
    customMetadata: { deleteAfter: '2026-09-09T00:00:00.000Z' },
  });

  const stored = await media.get(key);
  assert.ok(stored);
  assert.deepEqual(JSON.parse(await readAll(stored.body)), { hello: '世界' });

  const listed = await media.list({ prefix });
  assert.deepEqual(listed.objects.map((object) => object.key), [key]);
  assert.equal(listed.truncated, false);
  assert.equal(listed.objects[0].customMetadata, undefined, '不要元数据时不该额外发 HEAD');

  const withMetadata = await media.list({ prefix, includeMetadata: true });
  assert.equal(withMetadata.objects[0].customMetadata?.deleteafter ?? withMetadata.objects[0].customMetadata?.deleteAfter, '2026-09-09T00:00:00.000Z');

  await media.delete(key);
  assert.equal(await media.get(key), null);
});

void test('分片上传完成后能拿到大小，中止后对象不存在', { skip }, async () => {
  const media = storage();
  const prefix = `test/${crypto.randomUUID()}/`;
  const key = `${prefix}large.bin`;

  // S3 要求除最后一片外每片至少 5 MB。
  const partSize = 5 * 1024 * 1024;
  const first = new Uint8Array(partSize).fill(1);
  const second = new Uint8Array(1024).fill(2);

  const upload = await media.createMultipartUpload(key, { contentType: 'application/octet-stream' });
  assert.ok(upload.uploadId);
  // 故意乱序提交，验证适配器会按 PartNumber 排好再 complete。
  const partTwo = await upload.uploadPart(2, second);
  const partOne = await upload.uploadPart(1, first);
  const object = await upload.complete([partTwo, partOne]);

  assert.equal(object.key, key);
  assert.equal(object.size, partSize + second.byteLength, 'complete 不返回大小，适配器应补一次 HEAD');
  assert.ok(object.etag);
  assert.equal(object.sha256, null, 'S3 不提供内建 SHA-256，调用方回退到 etag');

  await media.delete(key);

  const aborted = await media.createMultipartUpload(`${prefix}aborted.bin`, {});
  await aborted.uploadPart(1, new Uint8Array(partSize).fill(3));
  await aborted.abort();
  assert.equal(await media.get(`${prefix}aborted.bin`), null);
});

void test('批量删除', { skip }, async () => {
  const media = storage();
  const prefix = `test/${crypto.randomUUID()}/`;
  const keys = ['a', 'b', 'c'].map((name) => `${prefix}${name}.txt`);
  for (const key of keys) await media.put(key, key, { contentType: 'text/plain' });

  assert.equal((await media.list({ prefix })).objects.length, 3);
  await media.delete(keys);
  assert.equal((await media.list({ prefix })).objects.length, 0);
});
