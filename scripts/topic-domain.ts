/**
 * 主题领域管理：配置自动化允许生产的内容范围。
 *
 * 领域取代了写死在源码里的中文财经词表。词表要改领域就得改代码发版，
 * 而且英文语料必然命中 0 个中文词——「跑题」和「不是中文」被判成了同一件事。
 * 现在领域是一段自然语言描述，嵌成中心向量后与选题比余弦，语言无关。
 *
 * 中心向量不在这里算：算向量要 OPENAI_API_KEY，而它只有 Render Worker 持有。
 * 这个脚本只写描述，下一轮调度会排一个向量作业把中心向量补上——
 * 补上之前该领域不参与判定，选题会因为「领域相关性无法判定」而不自动化。
 *
 * 领域决定自动化能生产什么，所以每一次改动都要有审计、要有真实的人：
 * `--actor` 必填且必须是 `team_members` 里在职的 admin。
 * 不接受回落到自动化服务账号——那会把人的决定记在机器头上，
 * 正好是 CLAUDE.md「自动化不伪造身份」那条的反面。
 *
 * 用法：
 *   node --env-file-if-exists=.env --experimental-strip-types scripts/topic-domain.ts list
 *   ... scripts/topic-domain.ts add <名称> <描述> [相关性阈值] --actor <member-id>
 *   ... scripts/topic-domain.ts disable <名称> --actor <member-id>
 *   ... scripts/topic-domain.ts enable <名称> --actor <member-id>
 */

import { closeDatabase, db } from '../lib/runtime.ts';
import { sha256Hex } from '../lib/hash.ts';
import { EMBEDDING_INPUT_CHAR_LIMIT } from '../lib/embedding.ts';
import {
  DEFAULT_RELEVANCE_THRESHOLD,
  isCentroidCurrent,
  loadTopicDomains,
} from '../lib/topic-domains.ts';

const argv = process.argv.slice(2);
const actorIndex = argv.indexOf('--actor');
const actorId = actorIndex >= 0 ? argv[actorIndex + 1] : '';
const args = actorIndex >= 0 ? [...argv.slice(0, actorIndex), ...argv.slice(actorIndex + 2)] : argv;
const command = args.shift() ?? '';

/** 写操作必须落在一个在职 admin 头上，并且要能在 `team_members` 里查到。 */
async function requireAdminActor() {
  if (!actorId) throw new Error('写操作必须带 --actor <member-id>，且必须是在职 admin。');
  const member = await db
    .prepare("SELECT role, status FROM team_members WHERE user_id = ? LIMIT 1")
    .bind(actorId)
    .first<{ role: string; status: string }>();
  if (!member || member.status !== 'active' || member.role !== 'admin') {
    throw new Error(`${actorId} 不是在职 admin，不能修改主题领域。`);
  }
  return actorId;
}

/** 每一次领域改动都写审计：它决定自动化能生产什么，必须查得出是谁改的。 */
async function audit(action: string, domainId: string, detail: Record<string, unknown>) {
  await db
    .prepare(`
      INSERT INTO audit_events (id, actor_id, actor_role, action, entity_type, entity_id, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, 'admin', ?, 'topic_domain', ?, ?, ?, ?, ?)
    `)
    .bind(
      `audit_${crypto.randomUUID()}`,
      actorId,
      action,
      domainId,
      sha256Hex(JSON.stringify(detail)),
      JSON.stringify({ trigger: 'cli', ...detail }),
      crypto.randomUUID(),
      new Date().toISOString(),
    )
    .run();
}

function domainId(name: string) {
  return `domain_${sha256Hex(name).slice(0, 24)}`;
}

async function list() {
  const domains = await loadTopicDomains(db);
  if (!domains.length) {
    process.stdout.write(
      '还没有配置任何主题领域。没有领域时，所有选题都会因为「无法判断是否落在生产范围内」而不自动化。\n',
    );
    return;
  }
  for (const domain of domains) {
    const centroid = isCentroidCurrent(domain)
      ? `中心向量已就绪（${domain.centroidModel}/v${domain.centroidVersion}）`
      : '中心向量待计算';
    process.stdout.write(
      `${domain.enabled ? '启用' : '停用'}  ${domain.name}  阈值 ${domain.relevanceThreshold}  ${centroid}\n    ${domain.description}\n`,
    );
  }
}

async function add(name: string, description: string, threshold: string | undefined) {
  if (!name || !description) throw new Error('用法：add <名称> <描述> [相关性阈值] --actor <member-id>');
  const actor = await requireAdminActor();
  // 描述是嵌入输入，超长部分不会进向量，留在库里只会让人误以为它参与了判定。
  if (description.length > EMBEDDING_INPUT_CHAR_LIMIT) {
    throw new Error(`领域描述不能超过 ${EMBEDDING_INPUT_CHAR_LIMIT} 字——超出的部分不会进入中心向量。`);
  }
  const relevanceThreshold = threshold ? Number(threshold) : DEFAULT_RELEVANCE_THRESHOLD;
  if (!Number.isFinite(relevanceThreshold) || relevanceThreshold <= 0 || relevanceThreshold >= 1) {
    throw new Error('相关性阈值必须落在 (0, 1) 区间。');
  }
  const now = new Date().toISOString();
  const id = domainId(name);
  const descriptionHash = sha256Hex(description);
  await db
    .prepare(`
      INSERT INTO topic_domains
        (id, name, description, description_hash, relevance_threshold, enabled,
         created_by, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, 'true', ?, ?, ?, 1)
      ON CONFLICT (id) DO UPDATE SET
        description = excluded.description,
        description_hash = excluded.description_hash,
        relevance_threshold = excluded.relevance_threshold,
        updated_at = excluded.updated_at,
        version = topic_domains.version + 1,
        -- 描述变了，旧中心向量代表的是旧领域；清掉让调度器重算。
        centroid_json = CASE
          WHEN topic_domains.description_hash = excluded.description_hash
          THEN topic_domains.centroid_json ELSE '' END,
        centroid_source_hash = CASE
          WHEN topic_domains.description_hash = excluded.description_hash
          THEN topic_domains.centroid_source_hash ELSE '' END
    `)
    .bind(id, name, description, descriptionHash, String(relevanceThreshold), actor, now, now)
    .run();
  await audit('topic_domain.upserted', id, { name, descriptionHash, relevanceThreshold });
  process.stdout.write(
    `已写入领域「${name}」。中心向量由下一轮调度排作业计算；在那之前这个领域不参与判定。\n`,
  );
}

async function setEnabled(name: string, enabled: boolean) {
  if (!name) throw new Error(`用法：${enabled ? 'enable' : 'disable'} <名称> --actor <member-id>`);
  await requireAdminActor();
  const result = await db
    .prepare('UPDATE topic_domains SET enabled = ?, updated_at = ?, version = version + 1 WHERE id = ?')
    .bind(enabled ? 'true' : 'false', new Date().toISOString(), domainId(name))
    .run();
  if (!result.meta.changes) throw new Error(`没有名为「${name}」的领域。`);
  await audit('topic_domain.enablement_changed', domainId(name), { name, enabled });
  process.stdout.write(`领域「${name}」已${enabled ? '启用' : '停用'}。\n`);
}

try {
  if (command === 'list' || !command) await list();
  else if (command === 'add') await add(args[0], args[1], args[2]);
  else if (command === 'enable') await setEnabled(args[0], true);
  else if (command === 'disable') await setEnabled(args[0], false);
  else throw new Error(`未知命令：${command}。可用：list、add、enable、disable。`);
} finally {
  await closeDatabase();
}
