/**
 * 模块解析钩子：让 `node --test` 能直接 import `app/api/**` 下的路由。
 *
 * 路由用 `@/lib/x` 这种 tsconfig path alias，Node 不认；`@/lib/runtime` 还会在
 * 加载时就连真库。这里把 alias 解析到仓库内的 `.ts`，并单独把 runtime 换成
 * `test/route-runtime.ts` 的替身，从而在 PGlite 上真正执行路由里的 SQL。
 */

import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeStub = pathToFileURL(path.join(repoRoot, 'test', 'route-runtime.ts')).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@/lib/runtime') return { url: runtimeStub, shortCircuit: true };
  if (specifier.startsWith('@/')) {
    const base = path.join(repoRoot, specifier.slice(2));
    for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
      if (fs.existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
