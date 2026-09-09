import { unlink, writeFile } from 'node:fs/promises';

const canary = process.env.SIGNAL40_IMAGE_SCAN_CANARY;
const cleanup = process.argv.includes('--cleanup');
const paths = ['.env.image-scan-canary', 'image-scan-canary.pem'] as const;

if (!canary || canary.length < 16) {
  throw new Error('SIGNAL40_IMAGE_SCAN_CANARY 必须是至少 16 字符的非生产测试值。');
}

if (cleanup) {
  await Promise.all(paths.map((path) => unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  })));
  process.stdout.write('镜像扫描 canary 文件已清理。\n');
} else {
  await writeFile(paths[0], `SIGNAL40_BUILD_CANARY=${canary}\n`, { mode: 0o600 });
  await writeFile(paths[1], `-----BEGIN TEST CANARY-----\n${canary}\n-----END TEST CANARY-----\n`, { mode: 0o600 });
  process.stdout.write('已创建受 .dockerignore 保护的镜像扫描 canary 文件。\n');
}
