/**
 * 按清单批量接入来源：登记发布主体 → 建来源 → 提交并批准权利 → 连接测试 → 启用。
 *
 * 这条路径本来只有界面上一步步点，接入十几个来源要点上百次，而且每一步的前置条件
 * 都不在界面上写着——换台机器或重建数据库之后没人复现得出来。这个脚本把那份隐性
 * 知识写成可执行的形式，走的是和界面完全相同的 API，没有任何一步绕开授权或门禁。
 *
 * 三件必须在清单里写对、写错了系统不会报错只会静默失效的事：
 *
 * 1. `publisher.website` 的主机名必须与该来源**文章 URL** 的主机名一致。
 *    `lib/source-relationship-classifier.ts` 只在这两者相同时才判 `original`；
 *    判不出就是 `unknown`，而 `unknown` 在证据门禁里一份证据都不算。
 *    聚合器（Google News 之类）的文章 URL 在聚合器自己域名下，永远判不出 original，
 *    所以它能提供选题广度，但对「独立证据交叉印证」的贡献恒为 0。
 *    注意 feed 域名和文章域名可以不同：BBC 的 feed 在 bbci.co.uk，正文在 bbc.co.uk，
 *    这里要填后者。
 *
 * 2. `publisher.ownershipGroup` 决定独立性。`lib/social-evidence.ts` 求的是
 *    「证据族 ↔ 所有权集团」的最大匹配，同一集团的两家媒体只算一份独立证据。
 *    Wired 和 Ars Technica 同属 Condé Nast，Engadget 和 TechCrunch 同属 Yahoo——
 *    这类组合加进来不会提高 `resonance`，只会增加采集量。
 *
 * 3. `terms` 是权利证据的条款快照，**哈希必须来自真实取到的字节**。
 *    默认取该站的 robots.txt；取不到就跳过这个来源，不接入。
 *    不接受「取不到就按空内容算哈希」——那样 dossier 会声称取过快照，
 *    而哈希恰好证明什么都没取，等于把伪造的证据写进审计。要接入这类站点，
 *    必须由人把条款正文另存下来、自己算哈希，在清单里用 `mode: "manual"` 显式登记。
 *
 * 权利批准要求 `--actor` 是 `team_members` 里在职、且 `can_approve_source_rights = 1`
 * 的 admin。本机开发身份（local-developer）不在成员表里，批不了权利——
 * 这不是脚本的限制，是 `lib/source-rights-approval.ts` 的要求，这里只是提前报错。
 *
 * 脚本可重复执行：发布主体、建来源、权利请求都按幂等键重放，已启用的来源会跳过。
 *
 * 用法：
 *   node --env-file-if-exists=.env --experimental-strip-types \
 *     scripts/onboard-sources.ts <清单.json> --actor <member-id> [--only key1,key2] [--dry-run]
 *
 *   --dry-run  只抓 feed 和条款、报告能不能接入，不写任何数据
 *   --only     只处理清单里这几个 key
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { closeDatabase, db } from '../lib/runtime.ts';
import { SOURCE_TYPES, type SourceType } from '../lib/domain.ts';

const USER_AGENT = 'Signal40-Ingestion/1.0';
const REQUEST_TIMEOUT_MS = 25_000;
/** 连接测试是异步作业，由 Source Worker 领取执行；这里等它落定。 */
const TEST_POLL_ATTEMPTS = 30;
const TEST_POLL_INTERVAL_MS = 2_000;

type TermsSpec =
  | { mode: 'robots' }
  | { mode: 'manual'; version: string; sha256: string; reference: string };

type ManifestSource = {
  key: string;
  name: string;
  feed: string;
  sourceType: SourceType;
  scheduleCron: string;
  /** 采集范围，写进权利 dossier；不填按标题/链接/时间/摘要/作者。 */
  permittedFields?: string[];
  terms?: TermsSpec;
  publisher: {
    id: string;
    legalName: string;
    ownershipGroup: string;
    /** 必须是文章 URL 的域名，不是 feed 的域名。 */
    website: string;
  };
};

type Manifest = { version: number; sources: ManifestSource[] };

type Outcome =
  | '已启用'
  | '已是启用状态，跳过'
  | '可接入（dry-run 未写入）'
  | `跳过：${string}`
  | `失败：${string}`;

const DEFAULT_PERMITTED_FIELDS = [
  'title',
  'url',
  'publishedAt',
  'summary',
  'author',
];

const argv = process.argv.slice(2);

function flagValue(name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : '';
}

const dryRun = argv.includes('--dry-run');
const actorId = flagValue('--actor');
const onlyKeys = flagValue('--only')
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
const manifestPath = argv.find((value) => !value.startsWith('--') && value !== actorId && value !== flagValue('--only'));

const controlUrl = (process.env.SIGNAL40_CONTROL_URL || `http://127.0.0.1:${process.env.PORT || 3001}`).replace(/\/$/, '');
/** 每次运行一个新的幂等键前缀：重跑时连接测试必须真的重测，不能重放上一次的失败结果。 */
const runId = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
const today = new Date().toISOString().slice(0, 10);

/**
 * 权利批准必须落在一个能批准权利的真人头上。
 *
 * 本机请求可以用 `x-signal-*` 伪造角色，但 `actorCanApproveSourceRights` 查的是
 * `team_members`——伪造出来的身份查不到，批准会 403。提前在这里查一次，
 * 免得建完一半来源才在批准那步失败。
 */
async function requireRightsApprover() {
  if (!actorId) {
    throw new Error('必须带 --actor <member-id>：权利批准要记在真实成员头上。');
  }
  const member = await db
    .prepare(`
      SELECT email, role, status, can_approve_source_rights
      FROM team_members WHERE user_id = ? LIMIT 1
    `)
    .bind(actorId)
    .first<{ email: string; role: string; status: string; can_approve_source_rights: number }>();
  if (!member) throw new Error(`${actorId} 不在 team_members 里，不能批准来源权利。`);
  if (member.status !== 'active' || member.role !== 'admin') {
    throw new Error(`${actorId} 不是在职 admin，不能批准来源权利。`);
  }
  if (!member.can_approve_source_rights) {
    throw new Error(`${actorId} 没有 can_approve_source_rights，不能批准来源权利。`);
  }
  return { id: actorId, email: member.email };
}

type ApiResult = { status: number; body: Record<string, unknown> };

async function api(
  actor: { id: string; email: string },
  path: string,
  init: RequestInit & { idempotencyKey?: string } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-signal-role': 'admin',
    'x-signal-actor-id': actor.id,
    'x-signal-actor-email': actor.email,
  };
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const response = await fetch(`${controlUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* 非 JSON 响应保留原文，便于定位 */
  }
  return { status: response.status, body: (body ?? {}) as Record<string, unknown> };
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: { accept: '*/*', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * robots.txt 里通用 UA 是否被全站禁止。
 *
 * 只判 `Disallow: /` 这一种最明确的情形。更细的路径规则不在这里判——
 * 判得半懂不懂比不判更危险，会让人以为脚本替他做过合规审查。
 */
function disallowsEverything(robots: string) {
  let inWildcardGroup = false;
  for (const raw of robots.split('\n')) {
    const line = raw.trim().toLowerCase();
    if (line.startsWith('user-agent:')) {
      inWildcardGroup = line.slice('user-agent:'.length).trim() === '*';
    } else if (inWildcardGroup && line === 'disallow: /') {
      return true;
    }
  }
  return false;
}

/** 条款快照：要么真取到 robots.txt，要么由人在清单里登记，没有第三种。 */
async function resolveTerms(source: ManifestSource) {
  const terms = source.terms ?? { mode: 'robots' as const };
  if (terms.mode === 'manual') {
    if (!/^[a-f0-9]{64}$/.test(terms.sha256)) {
      return { error: `terms.sha256 必须是 64 位十六进制 SHA-256。` };
    }
    return {
      version: terms.version,
      sha256: terms.sha256,
      reference: terms.reference,
      blocked: false,
    };
  }
  const url = new URL('/robots.txt', source.publisher.website).toString();
  let body: string;
  try {
    body = await fetchText(url);
  } catch (error) {
    return {
      error: `取不到 ${url}（${error instanceof Error ? error.message : String(error)}）。条款快照不能凭空生成，请改用 terms.mode = "manual" 并登记人工取到的条款哈希。`,
    };
  }
  return {
    version: `robots-txt-${today}`,
    sha256: sha256(body),
    reference: `snapshot:robots-txt:${url}`,
    blocked: disallowsEverything(body),
  };
}

function readSourceId(body: Record<string, unknown>) {
  const nested = (body.source ?? body) as Record<string, unknown>;
  if (typeof nested.id === 'string') return nested.id;
  if (typeof nested.sourceId === 'string') return nested.sourceId;
  return '';
}

/** 只接受字符串字段；其他类型一律当作缺失，不做默认字符串化。 */
function text(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function apiError(result: ApiResult) {
  const message = typeof result.body.error === 'string' ? result.body.error : JSON.stringify(result.body);
  return `HTTP ${result.status} ${message}`.slice(0, 300);
}

async function onboard(
  actor: { id: string; email: string },
  source: ManifestSource,
): Promise<Outcome> {
  const feed = await fetchText(source.feed);
  const terms = await resolveTerms(source);
  if ('error' in terms) return `跳过：${terms.error}`;
  if (terms.blocked) return '跳过：robots.txt 对通用 UA 全站 Disallow';
  if (dryRun) return '可接入（dry-run 未写入）';

  // 1. 发布主体。已存在返回 409，视为幂等成功——主体是共享的，多个来源可以指同一个。
  const entity = await api(actor, '/api/v1/publisher-entities', {
    method: 'POST',
    body: JSON.stringify({
      id: source.publisher.id,
      legalName: source.publisher.legalName,
      ownershipGroup: source.publisher.ownershipGroup,
      entityType: 'company',
      identifiers: { website: source.publisher.website },
    }),
  });
  if (entity.status !== 201 && entity.status !== 409) {
    return `失败：登记发布主体 ${apiError(entity)}`;
  }

  // 2. 建来源。只能以 rightsStatus=pending 创建，批准是独立的一步。
  const created = await api(actor, '/api/v1/source-configs', {
    method: 'POST',
    idempotencyKey: `onboard-${source.key}-create`,
    body: JSON.stringify({
      name: source.name,
      adapter: 'rss',
      platform: 'rss',
      url: source.feed,
      sourceType: source.sourceType,
      publisherEntityId: source.publisher.id,
      rightsStatus: 'pending',
      publicUseConfirmed: true,
      businessOwnerId: actor.id,
      scheduleCron: source.scheduleCron,
      rateLimitPerMinute: 10,
      retention: { mode: 'metadata', days: 30 },
    }),
  });
  const sourceId = readSourceId(created.body);
  if (!sourceId) return `失败：建来源 ${apiError(created)}`;

  const readSource = async () => {
    const detail = await api(actor, `/api/v1/source-configs/${sourceId}`);
    return ((detail.body.source ?? detail.body) as Record<string, unknown>);
  };
  const current = await readSource();
  if (current.enabled === true) return '已是启用状态，跳过';

  // 3. 权利声明。建来源时已自动挂了一条 pending，没有才补提。
  let requests = await api(actor, `/api/v1/source-configs/${sourceId}/rights`);
  let pending = ((requests.body.requests ?? []) as Array<Record<string, unknown>>)
    .find((item) => item.status === 'pending');
  if (!pending) {
    const submitted = await api(actor, `/api/v1/source-configs/${sourceId}/rights`, {
      method: 'PUT',
      idempotencyKey: `onboard-${source.key}-rights`,
      body: JSON.stringify({
        expectedSourceVersion: Number(current.version),
        assertionRef: `snapshot:${source.key}-feed-${today}`,
        note: `公开 RSS feed，条款快照 ${terms.reference} 未禁止通用 UA 抓取；仅采集规范化元数据。`,
      }),
    });
    if (submitted.status >= 400) return `失败：提交权利声明 ${apiError(submitted)}`;
    requests = await api(actor, `/api/v1/source-configs/${sourceId}/rights`);
    pending = ((requests.body.requests ?? []) as Array<Record<string, unknown>>)
      .find((item) => item.status === 'pending');
  }

  // 4. 批准。证据哈希来自这次真实取到的 feed 与条款字节。
  if (pending) {
    const beforeDecision = await readSource();
    const decided = await api(actor, `/api/v1/source-configs/${sourceId}/rights`, {
      method: 'POST',
      idempotencyKey: `onboard-${source.key}-decision-${today}`,
      body: JSON.stringify({
        requestId: pending.id,
        expectedSourceVersion: Number(beforeDecision.version),
        decision: 'approve',
        note: `按清单接入：公开 feed，条款快照 ${terms.reference} 允许通用 UA，采集范围限于规范化元数据。`,
        dossier: {
          principal: source.publisher.legalName,
          sourceType: source.sourceType,
          territory: 'global',
          evidenceRef: `snapshot:${source.key}-feed-${today}`,
          evidenceSha256: sha256(feed),
          termsVersion: terms.version,
          termsSnapshotSha256: terms.sha256,
          grantedAt: new Date().toISOString(),
          expiresAt: null,
          permittedFields: source.permittedFields ?? DEFAULT_PERMITTED_FIELDS,
        },
      }),
    });
    if (decided.status >= 400) return `失败：批准权利 ${apiError(decided)}`;
  }

  // 5. 连接测试。幂等键带本次运行号：重跑必须真的重测，否则会重放上一次的失败。
  const test = await api(actor, `/api/v1/source-configs/${sourceId}/tests`, {
    method: 'POST',
    idempotencyKey: `onboard-${source.key}-test-${runId}`,
    body: JSON.stringify({}),
  });
  const testId = typeof test.body.testId === 'string' ? test.body.testId : '';
  if (!testId) return `失败：发起连接测试 ${apiError(test)}`;
  let testStatus = text(test.body.testStatus);
  for (
    let attempt = 0;
    attempt < TEST_POLL_ATTEMPTS && testStatus !== 'succeeded' && testStatus !== 'failed';
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, TEST_POLL_INTERVAL_MS));
    const polled = await api(actor, `/api/v1/source-configs/${sourceId}/tests/${testId}`);
    const row = (polled.body.test ?? polled.body) as Record<string, unknown>;
    testStatus = text(row.status, testStatus);
  }
  if (testStatus !== 'succeeded') {
    const failed = await readSource();
    const code = text(failed.lastErrorCode);
    // SSRF_BLOCKED 几乎总是本机网络环境的问题（代理把域名解析到保留网段），
    // 不是来源本身不可用——分开报，免得把环境问题当成来源问题去排查。
    const hint = code === 'SSRF_BLOCKED'
      ? '来源域名被解析到私有或保留网段，检查本机 DNS / 代理是否对该域名返回真实 IP'
      : text(failed.lastError, testStatus);
    return `失败：连接测试未通过（${hint}）`;
  }

  // 6. 启用。
  const beforeEnable = await readSource();
  const enabled = await api(actor, `/api/v1/source-configs/${sourceId}/enable`, {
    method: 'POST',
    body: JSON.stringify({ expectedVersion: Number(beforeEnable.version) }),
  });
  if (enabled.status >= 400) return `失败：启用 ${apiError(enabled)}`;
  return '已启用';
}

function validate(manifest: Manifest) {
  if (!Array.isArray(manifest.sources) || !manifest.sources.length) {
    throw new Error('清单里没有 sources。');
  }
  const keys = new Set<string>();
  for (const source of manifest.sources) {
    if (!source.key || keys.has(source.key)) throw new Error(`key 缺失或重复：${source.key}`);
    keys.add(source.key);
    if (!(SOURCE_TYPES as readonly string[]).includes(source.sourceType)) {
      throw new Error(`${source.key} 的 sourceType 无效：${source.sourceType}`);
    }
    for (const url of [source.feed, source.publisher.website]) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
      } catch {
        throw new Error(`${source.key} 的 URL 无效：${url}`);
      }
    }
  }
}

try {
  if (!manifestPath) {
    throw new Error('用法：scripts/onboard-sources.ts <清单.json> --actor <member-id> [--only k1,k2] [--dry-run]');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  validate(manifest);
  const actor = dryRun ? { id: 'dry-run', email: 'dry-run@local' } : await requireRightsApprover();
  const selected = onlyKeys.length
    ? manifest.sources.filter((source) => onlyKeys.includes(source.key))
    : manifest.sources;
  if (!selected.length) throw new Error('--only 没有匹配到任何来源。');

  const results: Array<{ key: string; group: string; outcome: Outcome }> = [];
  for (const source of selected) {
    let outcome: Outcome;
    try {
      outcome = await onboard(actor, source);
    } catch (error) {
      outcome = `失败：${error instanceof Error ? error.message : String(error)}`;
    }
    results.push({ key: source.key, group: source.publisher.ownershipGroup, outcome });
    process.stdout.write(`${source.key.padEnd(18)} ${source.publisher.ownershipGroup.padEnd(22)} ${outcome}\n`);
  }

  const ok = results.filter((row) => !row.outcome.startsWith('跳过') && !row.outcome.startsWith('失败'));
  const groups = new Set(ok.map((row) => row.group));
  process.stdout.write(
    `\n处理 ${results.length} 个来源，${dryRun ? '可接入' : '成功'} ${ok.length} 个，` +
      `覆盖 ${groups.size} 个独立所有权集团。\n` +
      `独立集团数直接决定 resonance 分项：同一件事被 n 个集团报道时得分为 100×(1−0.5^(n/2))。\n`,
  );
} finally {
  await closeDatabase();
}
