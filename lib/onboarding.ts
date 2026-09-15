import {
  MINIMUM_INDEPENDENT_EVIDENCE,
  PRIMARY_EVIDENCE_SOURCE_TYPES,
} from './domain.ts';
import type { SqlDatabase } from './sql.ts';
import { WORKER_ONLINE_WINDOW_SECONDS } from './workers.ts';

/**
 * 上手清单：把「现在轮到谁做什么」从状态里算出来，而不是写死成教程。
 *
 * 这条流水线的每一步都由门禁决定能不能往下走（连接测试、独立权利审批、启用、采集、
 * 选题计算），但门禁只会在你撞上去的时候说不行。清单把同一批状态正着读一遍：
 * 哪些已经完成、当前卡在哪、为什么卡住、谁能解开、点哪里。
 *
 * 这里不新增任何判断标准，也不替用户做决定——每条结论都能在数据库里指到具体的行。
 */

export type OnboardingStepKey =
  | 'connect_source'
  | 'approve_rights'
  | 'enable_ingestion'
  | 'produce_topics'
  | 'pass_evidence_gate';

export type OnboardingStepStatus = 'done' | 'current' | 'blocked' | 'locked';

export type OnboardingStep = {
  key: OnboardingStepKey;
  title: string;
  status: OnboardingStepStatus;
  /** 当前这步的事实陈述：已完成的说完成了什么，未完成的说缺什么。 */
  detail: string;
  /** 需要人去别处处理时给出的落点。 */
  action?: { label: string; href: string };
};

export type OnboardingSourceState = {
  id: string;
  name: string;
  lifecycleStatus: string;
  rightsStatus: string;
  /** 治理后的内容类型；决定这个来源能不能给选题提供一手证据。 */
  sourceType: string;
  /**
   * 当前配置通过过连接测试。
   *
   * 不能用 lifecycleStatus 代替：改配置后来源会回到 paused/draft，但 paused 这个词
   * 在生命周期里排在 tested 之后，只看状态词会得出「已经测过了」，而启用接口比对的是
   * config_hash 与 last_tested_config_hash，照样拒绝。
   */
  testedCurrentConfig: boolean;
  enabled: boolean;
  /** 待审批权利请求的提交者；只用于展示是谁提的，不再限制由谁批。 */
  pendingRightsRequestedBy: string | null;
};

export type OnboardingApprover = { userId: string; email: string };

export type OnboardingState = {
  sources: OnboardingSourceState[];
  rightsApprovers: OnboardingApprover[];
  /** 库里的文章总数。注意它不等于雷达能用的语料——被丢弃批次的文章仍在这个数里。 */
  articleCount: number;
  /** 最近一次选题计算实际用到的语料篇数（pipeline_runs.article_count）。 */
  latestRunArticleCount: number;
  /**
   * 最近一次计算产出的候选数。雷达只读最近一次运行，
   * 所以这里必须是「雷达上真的能看到几条」，而不是历史累计。
   */
  latestRunTopicCount: number;
  /** 最近一次计算里通过自动证据门禁的候选数。 */
  latestRunGatePassedCount: number;
  /** 已被丢弃的采集批次数；丢弃会把该批次的 origin 摘掉，文章不再进入语料。 */
  discardedRunCount: number;
  ingestionWorkerOnline: boolean;
};

function describeSources(sources: OnboardingSourceState[]) {
  const names = sources.map((source) => source.name).filter(Boolean);
  if (!names.length) return '';
  return names.length <= 3
    ? names.join('、')
    : `${names.slice(0, 3).join('、')} 等 ${names.length} 个`;
}

/**
 * 谁能审批这条权利请求：有审批能力的在职管理员。
 *
 * 以前这里还要排除提交者本人——职责分离已按单人运营的决定移除，提交者自己也能批，
 * 所以不再排除任何人。签名保留 `requestedBy` 是为了不惊动所有调用点，值本身只用于展示。
 */
export function eligibleRightsApprovers(
  approvers: OnboardingApprover[],
  _requestedBy: string | null,
) {
  return approvers;
}

export function computeOnboardingChecklist(state: OnboardingState): OnboardingStep[] {
  const { sources } = state;
  const tested = sources.filter((source) => source.testedCurrentConfig);
  const approved = sources.filter((source) => source.rightsStatus === 'approved');
  const enabled = sources.filter((source) => source.enabled);
  const awaitingRights = sources.filter((source) => source.rightsStatus === 'pending');

  const connect: OnboardingStep = sources.length === 0
    ? {
      key: 'connect_source',
      title: '接入来源',
      status: 'current',
      detail: '还没有登记任何来源。先接入一个你有权使用的公开来源。',
      action: { label: '去接入来源', href: '/sources' },
    }
    : tested.length === 0
      ? {
        key: 'connect_source',
        title: '接入来源',
        status: 'blocked',
        detail: `${describeSources(sources)} 已登记，但当前配置还没有通过连接测试——改过配置的来源要重新测一次，旧测试结果对不上新配置。`,
        action: { label: '去测试连接', href: '/sources' },
      }
      : {
        key: 'connect_source',
        title: '接入来源',
        status: 'done',
        detail: `${describeSources(tested)} 已通过连接测试。`,
      };

  let rights: OnboardingStep;
  if (sources.length === 0) {
    rights = {
      key: 'approve_rights',
      title: '权利审批',
      status: 'locked',
      detail: '接入来源后，需要一名有「来源权利审批」能力的管理员核验使用权。',
    };
  } else if (approved.length > 0) {
    rights = {
      key: 'approve_rights',
      title: '权利审批',
      status: 'done',
      detail: `${describeSources(approved)} 的使用权已由独立审批者批准。`,
    };
  } else {
    const requestedBy = awaitingRights[0]?.pendingRightsRequestedBy ?? null;
    const eligible = eligibleRightsApprovers(state.rightsApprovers, requestedBy);
    rights = eligible.length
      ? {
        key: 'approve_rights',
        title: '权利审批',
        status: 'current',
        detail: `${describeSources(awaitingRights.length ? awaitingRights : sources)} 等待核验使用权。当前可审批：${eligible.map((approver) => approver.email).join('、')}。`,
        action: { label: '去审批权利', href: '/sources' },
      }
      : {
        key: 'approve_rights',
        title: '权利审批',
        status: 'blocked',
        detail: '团队里没有可审批来源权利的在职管理员，流程无法继续——先在治理页添加一位并授予「来源权利审批」能力。',
        action: { label: '去添加审批者', href: '/governance' },
      };
  }

  let enable: OnboardingStep;
  if (enabled.length > 0) {
    enable = {
      key: 'enable_ingestion',
      title: '启用采集',
      status: 'done',
      detail: state.ingestionWorkerOnline
        ? `${describeSources(enabled)} 已启用，采集 Worker 在线。`
        : `${describeSources(enabled)} 已启用，但没有在线的采集 Worker——作业会一直排队。`,
      ...(state.ingestionWorkerOnline
        ? {}
        : { action: { label: '查看 Worker 状态', href: '/operations' } }),
    };
  } else if (approved.length === 0) {
    enable = {
      key: 'enable_ingestion',
      title: '启用采集',
      status: 'locked',
      detail: '权利批准后才能启用采集。',
    };
  } else {
    enable = {
      key: 'enable_ingestion',
      title: '启用采集',
      status: 'current',
      detail: `${describeSources(approved)} 已获授权，启用后按计划采集。`,
      action: { label: '去启用来源', href: '/sources' },
    };
  }

  /**
   * 雷达只显示最近一次计算的结果，所以这里只认最近一次运行的数字。
   * 用历史累计的选题总数会得出「已完成」，而首页同时显示 0 条候选——
   * 界面绝不能显示引擎给不出的数。
   */
  let produce: OnboardingStep;
  if (state.latestRunTopicCount > 0) {
    produce = {
      key: 'produce_topics',
      title: '生成选题',
      status: 'done',
      detail: `最近一次计算从 ${state.latestRunArticleCount} 篇语料里算出 ${state.latestRunTopicCount} 个候选选题。`,
    };
  } else if (enabled.length === 0) {
    produce = {
      key: 'produce_topics',
      title: '生成选题',
      status: 'locked',
      detail: '采集出文章后自动计算选题。',
    };
  } else if (state.articleCount === 0) {
    produce = {
      key: 'produce_topics',
      title: '生成选题',
      status: 'current',
      detail: '来源已启用但还没有采集到文章。可以在来源卡片上「立即采集」，或等待调度。',
      action: { label: '去触发采集', href: '/sources' },
    };
  } else if (state.latestRunArticleCount === 0) {
    produce = {
      key: 'produce_topics',
      title: '生成选题',
      status: 'blocked',
      detail: state.discardedRunCount > 0
        ? `库里有 ${state.articleCount} 篇文章，但最近一次计算可用语料 0 篇：已有 ${state.discardedRunCount} 个采集批次被丢弃，丢弃不可恢复，这些条目不会再回到雷达。只有之后新采集到的条目才会重新出现。`
        : `库里有 ${state.articleCount} 篇文章，但最近一次计算可用语料 0 篇——这些文章都没有有效的来源归属记录，不能作为证据使用。`,
      action: { label: '去触发采集', href: '/sources' },
    };
  } else {
    produce = {
      key: 'produce_topics',
      title: '生成选题',
      status: 'current',
      detail: `最近一次计算用了 ${state.latestRunArticleCount} 篇语料，还没有产出候选选题。`,
      action: { label: '查看运行', href: '/operations' },
    };
  }

  /**
   * 证据门禁这步之前不在清单里，于是「四步全绿、雷达仍然 0 条可生成」成了常态：
   * 门禁要一手来源，而接入来源时「内容类型」默认是 media，全套媒体来源永远过不了。
   * 这条件不写在界面上，只能撞上去才知道。
   */
  /**
   * 只数真正能供稿的一手来源：已启用、且使用权已批准。
   *
   * 光按 `sourceType` 过滤会把停着、还没批权利的来源也算成「已有一手来源」，
   * 界面于是报出一个不存在的进展——那两个来源一篇文章都没采过，对证据毫无贡献。
   */
  const primaryTyped = sources.filter((source) =>
    (PRIMARY_EVIDENCE_SOURCE_TYPES as readonly string[]).includes(source.sourceType),
  );
  const primarySources = primaryTyped.filter(
    (source) => source.enabled && source.rightsStatus === 'approved',
  );
  const primaryTypeList = PRIMARY_EVIDENCE_SOURCE_TYPES.join(' / ');
  let gate: OnboardingStep;
  if (state.latestRunGatePassedCount > 0) {
    gate = {
      key: 'pass_evidence_gate',
      title: '通过证据门禁',
      status: 'done',
      detail: `${state.latestRunGatePassedCount} 个候选已通过自动证据门禁，可以进入人工核验。`,
    };
  } else if (state.latestRunTopicCount === 0) {
    gate = {
      key: 'pass_evidence_gate',
      title: '通过证据门禁',
      status: 'locked',
      detail: `有候选选题后还要过自动证据门禁：同一个选题里至少要有一篇一手来源（内容类型 ${primaryTypeList}），并有 ${MINIMUM_INDEPENDENT_EVIDENCE} 份独立证据。`,
    };
  } else if (primaryTyped.length === 0) {
    gate = {
      key: 'pass_evidence_gate',
      title: '通过证据门禁',
      status: 'blocked',
      detail: `${state.latestRunTopicCount} 个候选都没过门禁。门禁要求选题里至少有一篇一手来源（内容类型 ${primaryTypeList}），但现有 ${sources.length} 个来源的内容类型都不是一手来源——这样的候选不管采集多少次都过不了。内容类型在权利审批那一步可以改。`,
      action: { label: '去调整来源类型', href: '/sources' },
    };
  } else if (primarySources.length === 0) {
    gate = {
      key: 'pass_evidence_gate',
      title: '通过证据门禁',
      status: 'blocked',
      detail: `${state.latestRunTopicCount} 个候选都没过门禁。${describeSources(primaryTyped)} 登记的是一手来源，但还没启用或使用权还没批准，一篇文章都没供上——先把它们走完测试连接、权利审批、启用这三步。`,
      action: { label: '去启用一手来源', href: '/sources' },
    };
  } else {
    gate = {
      key: 'pass_evidence_gate',
      title: '通过证据门禁',
      status: 'current',
      detail: `${state.latestRunTopicCount} 个候选都还没过门禁：已有一手来源 ${describeSources(primarySources)}，但同一个选题还要凑够 ${MINIMUM_INDEPENDENT_EVIDENCE} 份独立证据交叉印证。`,
      action: { label: '去接入更多来源', href: '/sources' },
    };
  }

  return [connect, rights, enable, produce, gate];
}

export function onboardingComplete(steps: OnboardingStep[]) {
  return steps.every((step) => step.status === 'done');
}

/** 未完成的第一步；全部完成时返回 null。 */
export function currentOnboardingStep(steps: OnboardingStep[]) {
  return steps.find((step) => step.status !== 'done') ?? null;
}

/**
 * 单个来源卡片上的下一步动作。
 *
 * 卡片上原本只有状态词（「待配置」「待权利审批」），看得见卡在哪，看不出该谁动手。
 */
export function sourceNextStep(
  source: OnboardingSourceState,
  context: { approvers: OnboardingApprover[]; hasSucceededRun: boolean },
): { text: string; action?: { label: string; href: string } } | null {
  if (source.lifecycleStatus === 'archived') return null;
  if (source.rightsStatus === 'revoked' || source.rightsStatus === 'expired') {
    return { text: '下一步：使用权已失效，重新提交权利声明并核验。' };
  }
  if (!source.testedCurrentConfig) {
    return {
      text: source.lifecycleStatus === 'draft' || source.lifecycleStatus === 'connecting'
        ? '下一步：先测试连接，通过后才能进入权利审批。'
        : '下一步：配置改过之后要重新测试连接，旧的测试结果对不上当前配置。',
    };
  }
  if (source.rightsStatus !== 'approved') {
    const eligible = eligibleRightsApprovers(
      context.approvers,
      source.pendingRightsRequestedBy,
    );
    return eligible.length
      ? {
        text: `下一步：核验使用权（可审批：${eligible.map((approver) => approver.email).join('、')}）。`,
      }
      : {
        text: '下一步：团队里没有可审批来源权利的在职管理员，先去治理页添加一位。',
        action: { label: '去添加审批者', href: '/governance' },
      };
  }
  if (!source.enabled) return { text: '下一步：启用来源，开始按计划采集。' };
  if (!context.hasSucceededRun) {
    return { text: '下一步：等待调度，或点「立即采集」跑第一次。' };
  }
  return null;
}

/** 读取清单所需的状态；每个数字都对应数据库里的真实行。 */
export async function loadOnboardingState(
  db: SqlDatabase,
  now = new Date(),
): Promise<OnboardingState> {
  const sourceRows = await db
    .prepare(`
      SELECT source.id, source.name, source.lifecycle_status, source.rights_status,
        source.source_type, source.enabled,
        CASE WHEN source.last_tested_config_hash IS NOT NULL
          AND source.last_tested_config_hash = source.config_hash
          THEN 1 ELSE 0 END AS tested_current_config,
        (
          SELECT request.requested_by FROM source_rights_requests request
          WHERE request.source_config_id = source.id AND request.status = 'pending'
          ORDER BY request.created_at DESC LIMIT 1
        ) AS pending_rights_requested_by
      FROM source_configs source
      WHERE source.lifecycle_status <> 'archived'
      ORDER BY source.created_at
    `)
    .all<{
      id: string;
      name: string;
      lifecycle_status: string;
      rights_status: string;
      source_type: string;
      tested_current_config: number | boolean;
      enabled: number | boolean;
      pending_rights_requested_by: string | null;
    }>();
  const approverRows = await db
    .prepare(`
      SELECT user_id, email FROM team_members
      WHERE status = 'active' AND role = 'admin' AND can_approve_source_rights = 1
      ORDER BY email
    `)
    .all<{ user_id: string; email: string }>();
  const articleRow = await db
    .prepare('SELECT COUNT(*) AS count FROM articles')
    .first<{ count: number | string }>();
  // 雷达读的是最近一次运行，清单也只能读同一行，否则两边会给出互相矛盾的结论。
  // 门禁结果读 status 而不是解析 gate_json：runPipeline 里 status='ready' 与 gate.passed
  // 是同一个判断的两种写法，而 gate_json 是 text 列，解析它只会多一条出错路径。
  const latestRun = await db
    .prepare(
      'SELECT id, article_count FROM pipeline_runs ORDER BY created_at DESC LIMIT 1',
    )
    .first<{ id: string; article_count: number | string }>();
  const latestRunTopicRow = latestRun
    ? await db
      .prepare(`
        SELECT COUNT(*) AS count,
          COUNT(*) FILTER (WHERE status = 'ready') AS passed
        FROM topics WHERE run_id = ?
      `)
      .bind(latestRun.id)
      .first<{ count: number | string; passed: number | string }>()
    : null;
  const discardedRow = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM ingestion_runs WHERE quarantine_status = 'discarded'",
    )
    .first<{ count: number | string }>();
  const threshold = new Date(now.valueOf() - WORKER_ONLINE_WINDOW_SECONDS * 1000)
    .toISOString();
  const workerRow = await db
    .prepare(`
      SELECT COUNT(*) AS count FROM workers
      WHERE last_heartbeat_at >= ? AND kinds_json LIKE '%ingestion%'
    `)
    .bind(threshold)
    .first<{ count: number | string }>();

  return {
    sources: sourceRows.results.map((row) => ({
      id: row.id,
      name: row.name,
      lifecycleStatus: row.lifecycle_status,
      rightsStatus: row.rights_status,
      sourceType: row.source_type,
      testedCurrentConfig: Boolean(Number(row.tested_current_config)),
      enabled: Boolean(Number(row.enabled)),
      pendingRightsRequestedBy: row.pending_rights_requested_by,
    })),
    rightsApprovers: approverRows.results.map((row) => ({ userId: row.user_id, email: row.email })),
    articleCount: Number(articleRow?.count ?? 0),
    latestRunArticleCount: Number(latestRun?.article_count ?? 0),
    latestRunTopicCount: Number(latestRunTopicRow?.count ?? 0),
    latestRunGatePassedCount: Number(latestRunTopicRow?.passed ?? 0),
    discardedRunCount: Number(discardedRow?.count ?? 0),
    ingestionWorkerOnline: Number(workerRow?.count ?? 0) > 0,
  };
}
