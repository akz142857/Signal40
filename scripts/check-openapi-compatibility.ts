import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { findOpenApiBreakingChanges, reconcileBreakingChangeApprovals } from '../lib/openapi-compatibility.ts';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string) => unknown };

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baselinePath = argument('--baseline');
const baselineGitRef = argument('--baseline-git-ref');
const currentPath = argument('--current') ?? 'contracts/openapi.yaml';
const allowlistPath = argument('--allowlist');

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
  let approvedChanges: string[] = [];
  if (allowlistPath) {
    const allowlist = yaml.load(await readFile(allowlistPath, 'utf8')) as {
      baseline?: { sha256?: unknown };
      approvals?: Array<{ changes?: unknown }>;
    };
    const expectedBaselineHash = allowlist?.baseline?.sha256;
    const actualBaselineHash = createHash('sha256').update(baselineText).digest('hex');
    if (typeof expectedBaselineHash !== 'string' || expectedBaselineHash !== actualBaselineHash) {
      console.error(`OpenAPI breaking-change allowlist 的 baseline SHA-256 不匹配：expected=${String(expectedBaselineHash)}, actual=${actualBaselineHash}`);
      process.exitCode = 2;
    } else if (!Array.isArray(allowlist.approvals)) {
      console.error('OpenAPI breaking-change allowlist 缺少 approvals 数组。');
      process.exitCode = 2;
    } else {
      approvedChanges = allowlist.approvals.flatMap((approval) =>
        Array.isArray(approval.changes)
          ? approval.changes.filter((change): change is string => typeof change === 'string')
          : []);
      if (new Set(approvedChanges).size !== approvedChanges.length) {
        console.error('OpenAPI breaking-change allowlist 包含重复项。');
        process.exitCode = 2;
      }
    }
  }

  if (process.exitCode !== 2) {
    const approval = reconcileBreakingChangeApprovals(changes, approvedChanges);
    if (approval.unapproved.length > 0 || approval.stale.length > 0) {
      if (approval.unapproved.length > 0) {
        console.error(`检测到 ${approval.unapproved.length} 项未经批准的 OpenAPI breaking change：`);
        for (const change of approval.unapproved) console.error(`- ${change}`);
      }
      if (approval.stale.length > 0) {
        console.error(`检测到 ${approval.stale.length} 项已失效的 OpenAPI breaking-change 豁免，请删除或更新：`);
        for (const change of approval.stale) console.error(`- ${change}`);
      }
      process.exitCode = 1;
    } else if (changes.length > 0) {
      console.log(`OpenAPI 兼容性检查通过：${changes.length} 项 breaking change 均与精确审批清单匹配。`);
    } else {
      console.log('OpenAPI 兼容性检查通过：未发现 breaking change。');
    }
  }
}
