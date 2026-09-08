import { createS3Client } from '../lib/storage-s3.ts';
import { ListBucketsCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

/**
 * 对象存储配置自检：先查值的形状，再查连通性与权限。
 *
 * R2 建 Token 的结果页会同时给出三个值，形状相近很容易拿错，
 * 而 S3 协议的报错（AccessDenied / Unauthorized）不会告诉你是哪一个拿错了。
 * 这里把「值填错」和「权限不足」分开判定，直接给出下一步。
 */

const endpointRaw = process.env.S3_ENDPOINT ?? '';
const bucket = process.env.S3_BUCKET ?? '';
const keyId = process.env.S3_ACCESS_KEY_ID ?? '';
const secret = process.env.S3_SECRET_ACCESS_KEY ?? '';

const problems: string[] = [];
const isHex = (value: string, length: number) => new RegExp(`^[0-9a-f]{${length}}$`, 'i').test(value);

if (!endpointRaw) problems.push('S3_ENDPOINT 未设置。');
if (!bucket) problems.push('S3_BUCKET 未设置。');

let accountId = '';
if (endpointRaw) {
  let url: URL | null = null;
  try { url = new URL(endpointRaw); } catch { problems.push(`S3_ENDPOINT 不是合法 URL：${endpointRaw}`); }
  if (url) {
    if (url.pathname !== '/' && url.pathname !== '') {
      problems.push(`S3_ENDPOINT 末尾多了路径 "${url.pathname}"。端点只能是 https://<account_id>.r2.cloudflarestorage.com，桶名走 S3_BUCKET。`);
    }
    accountId = url.hostname.split('.')[0];
  }
}

if (!isHex(keyId, 32)) {
  problems.push(`S3_ACCESS_KEY_ID 应为 32 位十六进制，实际是 ${keyId.length} 字符${/^cfat/i.test(keyId) ? '（这是 Token value，不是 Access Key ID）' : ''}。`);
} else if (accountId && keyId.toLowerCase() === accountId.toLowerCase()) {
  problems.push('S3_ACCESS_KEY_ID 与端点里的 Account ID 相同——你填的是 Account ID，不是 Access Key ID。两者都是 32 位十六进制，很容易拿错。');
}
if (!isHex(secret, 64)) {
  problems.push(`S3_SECRET_ACCESS_KEY 应为 64 位十六进制，实际是 ${secret.length} 字符${/^cfat/i.test(secret) ? '（这是 Token value，不是 Secret Access Key）' : ''}。`);
}

if (problems.length) {
  process.stdout.write('配置有问题：\n');
  for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
  process.stdout.write(`
R2 → Manage API Tokens → Create API Token（Permissions 选 Object Read & Write，
作用域选 Apply to all buckets 或明确包含 ${bucket || '目标桶'}）。
创建后的结果页有四个值，按下表取：

  Token value（cfat… 约 53 字符）   → 不用，这是给 Cloudflare REST API 的
  Access Key ID（32 位 hex）        → S3_ACCESS_KEY_ID
  Secret Access Key（64 位 hex）    → S3_SECRET_ACCESS_KEY
  S3 端点                           → S3_ENDPOINT（不带路径）

注意 Account ID 也是 32 位 hex 且显示在附近，别和 Access Key ID 弄混。
`);
  process.exitCode = 2;
} else {
  process.stdout.write('值的形状检查：全部通过\n');
  // 自检必须在有限时间内给出结论；挂住的诊断工具没有价值。
  const timeout = () => ({ abortSignal: AbortSignal.timeout(20_000) });
  const client = createS3Client({
    endpoint: new URL(endpointRaw).origin,
    region: process.env.S3_REGION,
    accessKeyId: keyId,
    secretAccessKey: secret,
  });
  // 用一个必然无效的 key 做对照：区分「key 不被识别」和「key 有效但无权限」。
  const control = createS3Client({
    endpoint: new URL(endpointRaw).origin,
    region: process.env.S3_REGION,
    accessKeyId: '0'.repeat(32),
    secretAccessKey: 'f'.repeat(64),
  });
  const nameOf = async (target: typeof client) => {
    try { await target.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }), timeout()); return 'OK'; }
    catch (error) { return (error as Error).name; }
  };
  const [mine, baseline] = [await nameOf(client), await nameOf(control)];

  if (mine === 'OK') {
    process.stdout.write('连通性：可以列举对象\n');
    const key = `signal40-selfcheck-${crypto.randomUUID()}.txt`;
    for (const [label, run] of [
      ['写入', () => client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'selfcheck', ContentType: 'text/plain' }), timeout())],
      ['读取', () => client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), timeout())],
      ['删除', () => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), timeout())],
    ] as const) {
      try {
        const result = await run() as { Body?: { transformToByteArray?: () => Promise<unknown> } };
        // 读完响应体，否则未消费的流会让连接一直挂着，进程不退出。
        await result?.Body?.transformToByteArray?.();
        process.stdout.write(`  ✓ ${label}\n`);
      }
      catch (error) { process.stdout.write(`  ✗ ${label} 失败：${(error as Error).name}\n`); process.exitCode = 2; }
    }
    try {
      const listed = await client.send(new ListBucketsCommand({}), timeout());
      process.stdout.write(`  可见的桶：${(listed.Buckets ?? []).map((item) => item.Name).join(', ') || '(无，Token 按桶授权时属正常)'}\n`);
    } catch { process.stdout.write('  可见的桶：无法列举（Token 按桶授权时属正常）\n'); }
    if (!process.exitCode) process.stdout.write('\n对象存储配置可用。\n');
  } else if (mine === baseline) {
    process.stdout.write(`连通性：${mine}\n\n这对 key 未被该账户识别（和一个伪造 key 的报错完全相同）。\n检查 Access Key ID 是否属于端点里的账户 ${accountId}。\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write(`连通性：${mine}（伪造 key 得到的是 ${baseline}）\n\nAccess Key ID 存在于该账户，但它的策略不覆盖桶 ${bucket}。\n通常是 Token 的 Permissions 选成了 Admin 档（只管桶，不管对象），\n或作用域绑在了别的桶上。需要 Object Read & Write，且作用域包含该桶。\n`);
    process.exitCode = 2;
  }
}
