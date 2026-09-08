import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 本地脚本的输出路径来自 argv，限制在仓库目录内，
 * 避免一次手滑的 `..` 就把文件写到仓库外面去。
 */
export function resolveOutputPath(value: string) {
  const resolved = path.resolve(repoRoot, value);
  const relative = path.relative(repoRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`输出路径必须位于仓库目录内：${value}`);
  }
  return resolved;
}
