import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  evaluateSocialEvidenceDataset,
  parseSocialEvidencePolicy,
  type SocialEvidenceLabelledCase,
} from '../lib/social-evidence.ts';

const filename = process.argv[2];
if (!filename) throw new Error('用法：npm run social-evidence:evaluate -- <dataset.json>');
const raw = await readFile(filename);
const parsed = JSON.parse(raw.toString('utf8')) as { policy?: unknown; cases?: unknown };
const policy = parseSocialEvidencePolicy(parsed.policy);
if (!policy) throw new Error('数据集 policy 未通过 Social Evidence 冻结约束。');
if (!Array.isArray(parsed.cases) || parsed.cases.length < 100) throw new Error('数据集至少需要 100 个标注案例。');
const cases = parsed.cases as SocialEvidenceLabelledCase[];
const ids = new Set<string>();
for (const item of cases) {
  if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.independent !== 'boolean' || typeof item.productionSample !== 'boolean' || !Array.isArray(item.origins)) {
    throw new Error('案例必须具有唯一 id、independent、productionSample 和 origins。');
  }
  ids.add(item.id);
}
process.stdout.write(`${JSON.stringify({
  datasetRef: filename,
  datasetSha256: createHash('sha256').update(raw).digest('hex'),
  caseCount: cases.length,
  policy,
  metrics: evaluateSocialEvidenceDataset(cases, policy),
}, null, 2)}\n`);
