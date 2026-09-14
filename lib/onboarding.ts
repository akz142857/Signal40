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
  | 'produce_topics';

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
  enabled: boolean;
  /** 待审批权利请求的提交者；同一个人不能审批自己的请求。 */
  pendingRightsRequestedBy: string | null;
};

export type OnboardingApprover = { userId: string; email: string };

export type OnboardingState = {
  sources: OnboardingSourceState[];
  rightsApprovers: OnboardingApprover[];
  articleCount: number;
  topicCount: number;
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
 * 谁能审批这条权利请求：有审批能力、且不是提交者本人。
 * 提交者未知时不做排除——宁可多列一个人，也不要谎称没人能批。
 */
export function eligibleRightsApprovers(
  approvers: OnboardingApprover[],
  requestedBy: string | null,
) {
  return requestedBy
    ? approvers.filter((approver) => approver.userId !== requestedBy)
    : approvers;
}

export function computeOnboardingChecklist(state: OnboardingState): OnboardingStep[] {
  const { sources } = state;
  const testedOrLater = sources.filter((source) =>
    ['tested', 'enabled', 'degraded', 'paused'].includes(source.lifecycleStatus),
  );
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
    : testedOrLater.length === 0
      ? {
        key: 'connect_source',
        title: '接入来源',
        status: 'blocked',
        detail: `${describeSources(sources)} 已登记，但还没有通过连接测试。`,
        action: { label: '去测试连接', href: '/sources' },
      }
      : {
        key: 'connect_source',
        title: '接入来源',
        status: 'done',
        detail: `${describeSources(testedOrLater)} 已通过连接测试。`,
      };

  let rights: OnboardingStep;
  if (sources.length === 0) {
    rights = {
      key: 'approve_rights',
      title: '权利审批',
      status: 'locked',
      detail: '接入来源后，需要另一名管理员核验使用权。',
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
        detail: `${describeSources(awaitingRights.length ? awaitingRights : sources)} 等待独立审批。提交者不能批自己的请求，当前可审批：${eligible.map((approver) => approver.email).join('、')}。`,
        action: { label: '去审批权利', href: '/sources' },
      }
      : {
        key: 'approve_rights',
        title: '权利审批',
        status: 'blocked',
        detail: '团队里没有第二名可审批来源权利的在职管理员，流程无法继续——先在治理页添加一位并授予「来源权利审批」能力。',
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

  let produce: OnboardingStep;
  if (state.topicCount > 0) {
    produce = {
      key: 'produce_topics',
      title: '生成选题',
      status: 'done',
      detail: `已从 ${state.articleCount} 篇文章算出 ${state.topicCount} 个候选选题。`,
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
  } else {
    produce = {
      key: 'produce_topics',
      title: '生成选题',
      status: 'current',
      detail: `已采集 ${state.articleCount} 篇文章，选题还在计算或尚未产出候选。`,
      action: { label: '查看运行', href: '/operations' },
    };
  }

  return [connect, rights, enable, produce];
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
    return { text: '下一步：使用权已失效，重新提交权利声明并由另一名管理员核验。' };
  }
  if (!['tested', 'enabled', 'degraded', 'paused'].includes(source.lifecycleStatus)) {
    return { text: '下一步：先测试连接，通过后才能进入权利审批。' };
  }
  if (source.rightsStatus !== 'approved') {
    const eligible = eligibleRightsApprovers(
      context.approvers,
      source.pendingRightsRequestedBy,
    );
    return eligible.length
      ? {
        text: `下一步：等另一名管理员核验使用权（可审批：${eligible.map((approver) => approver.email).join('、')}）。提交者不能批自己的请求。`,
      }
      : {
        text: '下一步：团队里没有第二名可审批来源权利的在职管理员，先去治理页添加一位。',
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
      SELECT source.id, source.name, source.lifecycle_status, source.rights_status, source.enabled,
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
  const topicRow = await db
    .prepare('SELECT COUNT(*) AS count FROM topics')
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
      enabled: Boolean(Number(row.enabled)),
      pendingRightsRequestedBy: row.pending_rights_requested_by,
    })),
    rightsApprovers: approverRows.results.map((row) => ({ userId: row.user_id, email: row.email })),
    articleCount: Number(articleRow?.count ?? 0),
    topicCount: Number(topicRow?.count ?? 0),
    ingestionWorkerOnline: Number(workerRow?.count ?? 0) > 0,
  };
}
