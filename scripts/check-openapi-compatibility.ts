import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { findOpenApiBreakingChanges } from '../lib/openapi-compatibility.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string) => unknown };

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baselinePath = argument('--baseline');
const baselineGitRef = argument('--baseline-git-ref');
const currentPath = argument('--current') ?? 'contracts/openapi.yaml';

if (!baselinePath && !baselineGitRef) {
  console.error('用法：check-openapi-compatibility --baseline <file> 或 --baseline-git-ref <git-ref> [--current <file>]');
  process.exitCode = 2;
} else if (baselineGitRef && /^0+$/.test(baselineGitRef)) {
  console.log('首次发布没有前序 Git SHA；跳过兼容比较，发布后的 SHA 必须保存为不可变 baseline。');
} else {
  const baselineText = baselinePath
    ? await readFile(baselinePath, 'utf8')
    : execFileSync('git', ['show', `${baselineGitRef}:${currentPath}`], { encoding: 'utf8' });
  const currentText = await readFile(currentPath, 'utf8');
  const changes = findOpenApiBreakingChanges(yaml.load(baselineText), yaml.load(currentText));
  if (changes.length > 0) {
    console.error(`检测到 ${changes.length} 项 OpenAPI breaking change：`);
    for (const change of changes) console.error(`- ${change}`);
    process.exitCode = 1;
  } else {
    console.log('OpenAPI 兼容性检查通过：未发现 breaking change。');
  }
}
