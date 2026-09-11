import type { SqlDatabase, SqlStatement } from './sql.ts';
import {
  computeRenderSnapshotHash,
  validateProjectV2,
  type VideoProjectV2,
} from './project-v2.ts';
import type { ContentState, GateResult, Role } from './workflow.ts';
import { assertTransition, stableHash, WorkflowError } from './workflow.ts';
import {
  AUTHORIZED_RAW_SCOPE,
  INGESTION_RIGHTS_PURPOSE,
  NORMALIZED_METADATA_SCOPE,
} from './source-rights.ts';
import { sourceConnectorByPlatform } from './source-connectors/registry.ts';
import { raiseAttentionItem } from './attention.ts';
import { SourceBudgetExceededError, utcMonthStart } from './source-budget.ts';
import { effectiveConnectorRollout } from './source-release-control.ts';
import {
  independentEvidenceCount,
  loadApprovedEvidencePolicy,
  qualifiedEvidenceEdge,
  type EvidenceOrigin,
} from './social-evidence.ts';

export type Actor = { id: string; email: string; role: Role };

/**
 * 一次写入是人做的还是策略做的。审计读取方必须能一眼区分这两者，
 * 所以它进 metadata；同时它决定要不要把项目踢出自动化——
 * 人一改，自动就停，直到有人显式恢复。
 */
export type AutomationTrigger = 'human' | 'automation';

type ProjectRow = {
  id: string;
  topic_id: string;
  title: string;
  state: ContentState;
  version: number;
  owner_id: string;
  brand: string;
  locale: string;
  project_json: string;
  immutable_hash: string;
  automation_mode: 'auto' | 'manual';
  automation_paused_reason: string | null;
  automation_policy_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectRecord = {
  id: string;
  topicId: string;
  title: string;
  state: ContentState;
  version: number;
  ownerId: string;
  brand: string;
  locale: string;
  project: VideoProjectV2;
  immutableHash: string;
  automationMode: 'auto' | 'manual';
  automationPausedReason: string | null;
  automationPolicyId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * 读取存储行里的 JSON 列；无法当成对象使用时返回 null，由调用方决定隔离还是报错。
 *
 * jsonb 列由驱动解析好后直接是对象，text 列拿到的是字符串，两种都要接。
 * JSON 标量（`null`、数字、字符串）不是合法的 payload/metadata，按损坏处理。
 */
function parseJsonColumn<T>(value: unknown): T | null {
  if (value && typeof value === 'object') return value as T;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function parseProject(row: ProjectRow): ProjectRecord {
  const project = parseJsonColumn<VideoProjectV2>(row.project_json);
  if (!project)
    throw new Error(`项目 ${row.id} 的 project_json 已损坏，无法解析。`);
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    state: row.state,
    version: row.version,
    ownerId: row.owner_id,
    brand: row.brand,
    locale: row.locale,
    project,
    immutableHash: row.immutable_hash,
    automationMode: row.automation_mode ?? 'auto',
    automationPausedReason: row.automation_paused_reason ?? null,
    automationPolicyId: row.automation_policy_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditStatement(
  db: SqlDatabase,
  input: {
    projectId?: string | null;
    actor: Actor;
    action: string;
    entityType: string;
    entityId: string;
    beforeHash?: string | null;
    afterHash?: string | null;
    metadata?: unknown;
    requestId?: string;
    now: string;
  },
) {
  return db
    .prepare(`
      INSERT INTO audit_events
        (id, project_id, actor_id, actor_role, action, entity_type, entity_id,
         before_hash, after_hash, metadata_json, request_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      `audit_${crypto.randomUUID()}`,
      input.projectId ?? null,
      input.actor.id,
      input.actor.role,
      input.action,
      input.entityType,
      input.entityId,
      input.beforeHash ?? null,
      input.afterHash ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.requestId ?? crypto.randomUUID(),
      input.now,
    );
}

/**
 * 把项目踢出自动化并记下原因。不 bump version：自动化模式不属于内容快照，
 * 顺手加一的话会让调用方手上的 ETag 平白失效。
 */
export function pauseAutomationStatement(
  db: SqlDatabase,
  projectId: string,
  reason: string,
) {
  return db
    .prepare(
      "UPDATE content_projects SET automation_mode = 'manual', automation_paused_reason = ? WHERE id = ? AND automation_mode = 'auto'",
    )
    .bind(reason.slice(0, 500), projectId);
}

export async function pauseProjectAutomation(
  db: SqlDatabase,
  projectId: string,
  reason: string,
) {
  const updated = await pauseAutomationStatement(db, projectId, reason).run();
  return { paused: Number(updated.meta.changes ?? 0) > 0 };
}

/** 恢复自动化。必须是人显式做的动作，编排引擎自己不会调用它。 */
export async function resumeProjectAutomation(
  db: SqlDatabase,
  projectId: string,
  policyId: string | null = null,
) {
  const updated = await db
    .prepare(
      "UPDATE content_projects SET automation_mode = 'auto', automation_paused_reason = NULL, automation_policy_id = ? WHERE id = ?",
    )
    .bind(policyId, projectId)
    .run();
  return { resumed: Number(updated.meta.changes ?? 0) > 0 };
}

export async function createContentProject(
  db: SqlDatabase,
  project: VideoProjectV2,
  actor: Actor,
  now = new Date(),
  options: { trigger?: AutomationTrigger; policyId?: string | null } = {},
) {
  const id = project.identity.projectId;
  const existing = await loadContentProject(db, id);
  if (existing) return { project: existing, created: false };
  const createdAt = now.toISOString();
  const hash = stableHash(project);
  const statements: SqlStatement[] = [
    db
      .prepare(`
        INSERT INTO content_projects
          (id, topic_id, title, state, version, owner_id, brand, locale, project_json,
           immutable_hash, automation_policy_id, created_at, updated_at)
        VALUES (?, ?, ?, 'DRAFT', 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        project.identity.topicId,
        project.identity.title,
        actor.id,
        project.identity.brand,
        project.identity.locale,
        JSON.stringify(project),
        hash,
        options.policyId ?? null,
        createdAt,
        createdAt,
      ),
  ];
  for (const claim of project.research.claims) {
    statements.push(
      db
        .prepare(`
          INSERT INTO claims (id, project_id, logical_id, text, kind, quantity_json, status, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'supported', 1, ?, ?)
        `)
        .bind(
          `${id}_${claim.id}`,
          id,
          claim.id,
          claim.text,
          claim.kind,
          claim.quantity ? JSON.stringify(claim.quantity) : null,
          createdAt,
          createdAt,
        ),
    );
    for (const [index, evidence] of claim.evidence.entries()) {
      statements.push(
        db
          .prepare(`
            INSERT INTO evidence_links
              (id, claim_id, article_id, article_revision_id, source_url, stance, excerpt, locator_json, source_hash, observed_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            `${id}_${claim.id}_evidence_${index + 1}`,
            `${id}_${claim.id}`,
            evidence.sourceId,
            evidence.articleRevisionId,
            evidence.url,
            evidence.stance,
            evidence.quote,
            JSON.stringify(evidence.locator),
            stableHash(evidence),
            evidence.observedAt,
            createdAt,
          ),
      );
    }
  }
  statements.push(
    db
      .prepare(`
        INSERT INTO research_snapshots
          (id, project_id, version, snapshot_json, snapshot_hash, approved_by, approved_at, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?)
      `)
      .bind(
        project.research.snapshotId,
        id,
        JSON.stringify(project.research),
        project.research.approvedHash,
        actor.id,
        createdAt,
        createdAt,
      ),
    db
      .prepare(`
        INSERT INTO script_versions
          (id, project_id, version, script_json, content_hash, created_by, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `)
      .bind(
        `script_${crypto.randomUUID()}`,
        id,
        JSON.stringify(project.script),
        stableHash(project.script),
        actor.id,
        createdAt,
      ),
    db
      .prepare(`
        INSERT INTO storyboard_versions
          (id, project_id, version, storyboard_json, content_hash, created_by, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `)
      .bind(
        `storyboard_${crypto.randomUUID()}`,
        id,
        JSON.stringify(project.timeline),
        stableHash(project.timeline),
        actor.id,
        createdAt,
      ),
    auditStatement(db, {
      projectId: id,
      actor,
      action: 'project.created',
      entityType: 'content_project',
      entityId: id,
      afterHash: hash,
      metadata: {
        schemaVersion: '2.0',
        topicId: project.identity.topicId,
        trigger: options.trigger ?? 'human',
        policyId: options.policyId ?? null,
      },
      now: createdAt,
    }),
  );
  await db.batch(statements);
  return { project: (await loadContentProject(db, id))!, created: true };
}

export async function listContentProjects(db: SqlDatabase) {
  const result = await db
    .prepare(`
      SELECT id, topic_id, title, state, version, owner_id, brand, locale, project_json,
             immutable_hash, automation_mode, automation_paused_reason, automation_policy_id,
             created_at, updated_at
      FROM content_projects ORDER BY updated_at DESC LIMIT 100
    `)
    .all<ProjectRow>();
  return result.results.map(parseProject);
}

export async function loadContentProject(db: SqlDatabase, id: string) {
  const row = await db
    .prepare(`
      SELECT id, topic_id, title, state, version, owner_id, brand, locale, project_json,
             immutable_hash, automation_mode, automation_paused_reason, automation_policy_id,
             created_at, updated_at
      FROM content_projects WHERE id = ? LIMIT 1
    `)
    .bind(id)
    .first<ProjectRow>();
  return row ? parseProject(row) : null;
}

export async function transitionContentProject(
  db: SqlDatabase,
  input: {
    projectId: string;
    expectedVersion: number;
    to: ContentState;
    gates: GateResult[];
    note: string;
    actor: Actor;
    trigger?: AutomationTrigger;
    policyId?: string | null;
    requiredCapability?: string;
    payloadSchemaVersion?: number;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  if (project.version !== input.expectedVersion) {
    return {
      error: `版本冲突：当前版本为 ${project.version}。`,
      status: 409 as const,
      project,
    };
  }
  assertTransition({
    from: project.state,
    to: input.to,
    role: input.actor.role,
    gates: input.gates,
  });
  const updatedAt = now.toISOString();
  // 在事务里先写后判：更新没命中就抛错回滚，审计事件自然不会留下。
  // 这比让审计语句自己带一份 `WHERE EXISTS` 守卫更直接，也不用把版本条件写两遍。
  return db.transaction(async (tx) => {
    const updated = await tx
      .prepare(`
        UPDATE content_projects SET state = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `)
      .bind(input.to, updatedAt, input.projectId, input.expectedVersion)
      .run();
    if (!updated.meta.changes)
      throw new WorkflowError('项目已被其他用户修改。', 'VERSION_CONFLICT');
    await auditStatement(tx, {
      projectId: input.projectId,
      actor: input.actor,
      action: 'project.transitioned',
      entityType: 'content_project',
      entityId: input.projectId,
      beforeHash: stableHash({
        state: project.state,
        version: project.version,
      }),
      afterHash: stableHash({ state: input.to, version: project.version + 1 }),
      metadata: {
        from: project.state,
        to: input.to,
        gates: input.gates,
        note: input.note,
        trigger: input.trigger ?? 'human',
        policyId: input.policyId ?? null,
      },
      now: updatedAt,
    }).run();
    if ((input.trigger ?? 'human') === 'human') {
      await pauseAutomationStatement(
        tx,
        input.projectId,
        `人工把状态推进到 ${input.to}，自动化已暂停，需显式恢复。`,
      ).run();
    }
    return {
      project: (await loadContentProject(tx, input.projectId))!,
      status: 200 as const,
    };
  });
}

export async function saveProjectSection(
  db: SqlDatabase,
  input: {
    projectId: string;
    expectedVersion: number;
    section: 'script' | 'storyboard';
    value: VideoProjectV2['script'] | VideoProjectV2['timeline'];
    actor: Actor;
    trigger?: AutomationTrigger;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  if (project.version !== input.expectedVersion)
    return {
      error: `版本冲突：当前版本为 ${project.version}。`,
      status: 409 as const,
      project,
    };
  const editorRoles =
    input.section === 'script' ? ['editor', 'admin'] : ['producer', 'admin'];
  if (!editorRoles.includes(input.actor.role))
    return {
      error: `当前角色无权编辑 ${input.section}。`,
      status: 403 as const,
    };
  const allowedStates =
    input.section === 'script'
      ? ['SCRIPT_DRAFT', 'CHANGES_REQUESTED']
      : ['SCRIPT_APPROVED', 'CHANGES_REQUESTED'];
  if (!allowedStates.includes(project.state))
    return {
      error: `${input.section} 不能在 ${project.state} 状态编辑，请先按流程推进。`,
      status: 409 as const,
    };
  const nextProject = structuredClone(project.project);
  if (input.section === 'script') {
    const script = input.value as VideoProjectV2['script'];
    if (
      !script.title.trim() ||
      !script.lines.length ||
      script.lines.some((line) => !line.text.trim())
    )
      return { error: '脚本标题和每一行内容不能为空。', status: 422 as const };
    const changedLockedLine = project.project.script.lines.find(
      (line) =>
        line.locked &&
        (() => {
          const replacement = script.lines.find(
            (candidate) => candidate.id === line.id,
          );
          return (
            !replacement ||
            replacement.text !== line.text ||
            JSON.stringify(replacement.claimIds) !==
              JSON.stringify(line.claimIds)
          );
        })(),
    );
    if (changedLockedLine)
      return {
        error: `脚本行 ${changedLockedLine.id} 已锁定，需先解除锁定再修改。`,
        status: 409 as const,
      };
    const claimIds = new Set(
      nextProject.research.claims.map((claim) => claim.id),
    );
    if (
      script.lines.some((line) => line.claimIds.some((id) => !claimIds.has(id)))
    )
      return { error: '脚本引用了不存在的声明。', status: 422 as const };
    nextProject.script = {
      ...script,
      version: project.project.script.version + 1,
      humanModifiedBy: input.actor.id,
      humanModifiedAt: now.toISOString(),
    };
  } else {
    const timeline = input.value as VideoProjectV2['timeline'];
    if (!timeline.length || timeline.some((scene) => scene.durationFrames < 1))
      return { error: '分镜不能为空且时长必须为正数。', status: 422 as const };
    let cursor = 0;
    nextProject.timeline = timeline.map((scene) => {
      const next = { ...scene, startFrame: cursor };
      cursor += scene.durationFrames;
      return next;
    });
    if (cursor !== nextProject.render.durationSeconds * nextProject.render.fps)
      return {
        error: `分镜总帧数必须为 ${nextProject.render.durationSeconds * nextProject.render.fps}。`,
        status: 422 as const,
      };
  }
  const immutableHash = computeRenderSnapshotHash(nextProject);
  nextProject.render.snapshotHash = immutableHash;
  nextProject.provenance.immutableInputsHash = immutableHash;
  const validation = validateProjectV2(nextProject);
  if (!validation.valid)
    return {
      error: `项目协议校验失败：${validation.errors.join('；')}`,
      status: 422 as const,
    };
  const timestamp = now.toISOString();
  const nextState: ContentState =
    input.section === 'script' ? 'SCRIPT_DRAFT' : 'SCRIPT_APPROVED';
  const sectionValue =
    input.section === 'script' ? nextProject.script : nextProject.timeline;
  const sectionVersion =
    input.section === 'script'
      ? nextProject.script.version
      : Number(
          (
            await db
              .prepare(
                'SELECT MAX(version) AS version FROM storyboard_versions WHERE project_id = ?',
              )
              .bind(input.projectId)
              .first<{ version: number | null }>()
          )?.version ?? 0,
        ) + 1;
  const table =
    input.section === 'script' ? 'script_versions' : 'storyboard_versions';
  const jsonColumn =
    input.section === 'script' ? 'script_json' : 'storyboard_json';
  const nextProjectHash = stableHash(nextProject);
  return db.transaction(async (tx) => {
    const updated = await tx
      .prepare(
        'UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?',
      )
      .bind(
        JSON.stringify(nextProject),
        nextProjectHash,
        nextState,
        timestamp,
        input.projectId,
        input.expectedVersion,
      )
      .run();
    if (!updated.meta.changes)
      throw new WorkflowError('项目已被其他用户修改。', 'VERSION_CONFLICT');

    await tx
      .prepare(`
        INSERT INTO ${table} (id, project_id, version, ${jsonColumn}, content_hash, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        `${input.section}_${crypto.randomUUID()}`,
        input.projectId,
        sectionVersion,
        JSON.stringify(sectionValue),
        stableHash(sectionValue),
        input.actor.id,
        timestamp,
      )
      .run();

    await auditStatement(tx, {
      projectId: input.projectId,
      actor: input.actor,
      action: `${input.section}.version_created`,
      entityType: input.section,
      entityId: input.projectId,
      beforeHash: project.immutableHash,
      afterHash: immutableHash,
      metadata: {
        version: sectionVersion,
        approvalsInvalidated: true,
        trigger: input.trigger ?? 'human',
      },
      now: timestamp,
    }).run();
    if ((input.trigger ?? 'human') === 'human') {
      await pauseAutomationStatement(
        tx,
        input.projectId,
        `人工编辑了${input.section === 'script' ? '脚本' : '分镜'}，自动化已暂停，需显式恢复。`,
      ).run();
    }

    return {
      project: (await loadContentProject(tx, input.projectId))!,
      status: 200 as const,
    };
  });
}

export async function saveResearchSnapshot(
  db: SqlDatabase,
  input: {
    projectId: string;
    expectedVersion: number;
    research: VideoProjectV2['research'];
    actor: Actor;
    trigger?: AutomationTrigger;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  if (project.version !== input.expectedVersion)
    return {
      error: `版本冲突：当前版本为 ${project.version}。`,
      status: 409 as const,
      project,
    };
  if (!['researcher', 'editor', 'admin'].includes(input.actor.role))
    return { error: '当前角色无权编辑研究快照。', status: 403 as const };
  if (!['RESEARCHING', 'CHANGES_REQUESTED'].includes(project.state))
    return {
      error: `研究快照不能在 ${project.state} 状态编辑。`,
      status: 409 as const,
    };
  const claims = input.research.claims;
  if (!claims.length || claims.length > 50)
    return { error: '研究快照必须包含 1–50 条声明。', status: 422 as const };
  const ids = new Set<string>();
  for (const claim of claims) {
    if (
      !claim.id.trim() ||
      ids.has(claim.id) ||
      !claim.text.trim() ||
      claim.text.length > 2000
    )
      return {
        error: '声明 ID 必须唯一，文本不能为空且最多 2000 字。',
        status: 422 as const,
      };
    ids.add(claim.id);
    if (claim.evidence.length > 30)
      return {
        error: `${claim.id} 的证据不能超过 30 条。`,
        status: 422 as const,
      };
    for (const evidence of claim.evidence) {
      try {
        const url = new URL(evidence.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        return {
          error: `${claim.id} 包含无效证据 URL。`,
          status: 422 as const,
        };
      }
      if (
        !evidence.quote.trim() ||
        evidence.quote.length > 4000 ||
        Number.isNaN(new Date(evidence.observedAt).valueOf())
      )
        return {
          error: `${claim.id} 的证据摘录或观察时间无效。`,
          status: 422 as const,
        };
      if (!evidence.locator?.type || !evidence.locator.value?.trim())
        return {
          error: `${claim.id} 的证据必须包含页码、段落、表格、时间码、章节或 URL 定位。`,
          status: 422 as const,
        };
    }
    if (
      claim.kind === 'numeric' &&
      (!claim.quantity ||
        !claim.quantity.unit.trim() ||
        !claim.quantity.timeRange.trim() ||
        !claim.quantity.basis.trim() ||
        !claim.quantity.entity.trim())
    )
      return {
        error: `${claim.id} 的数字声明缺少单位、统计周期、比较基准或主体。`,
        status: 422 as const,
      };
  }
  if (
    input.research.conflicts.some(
      (conflict) => !ids.has(conflict.claimId) || !conflict.description.trim(),
    )
  )
    return { error: '冲突必须引用现有声明并提供描述。', status: 422 as const };
  const conflicts = [...input.research.conflicts];
  for (const claim of claims) {
    if (
      claim.evidence.some((evidence) => evidence.stance === 'refutes') &&
      !conflicts.some((conflict) => conflict.claimId === claim.id)
    ) {
      conflicts.push({
        claimId: claim.id,
        description: '存在反驳证据，需要编辑说明取舍依据。',
        resolution: null,
      });
    }
  }
  const core = { claims, conflicts };
  if (stableHash(core) === project.project.research.approvedHash)
    return { error: '研究内容没有变化。', status: 409 as const, project };
  const research = {
    ...input.research,
    conflicts,
    snapshotId: `research_${crypto.randomUUID()}`,
    approvedHash: stableHash(core),
  };
  const nextProject = structuredClone(project.project);
  nextProject.research = research;
  const immutableHash = computeRenderSnapshotHash(nextProject);
  nextProject.render.snapshotHash = immutableHash;
  nextProject.provenance.immutableInputsHash = immutableHash;
  const validation = validateProjectV2(nextProject);
  if (!validation.valid)
    return {
      error: `项目协议校验失败：${validation.errors.join('；')}`,
      status: 422 as const,
    };
  const timestamp = now.toISOString();
  const nextVersion =
    Number(
      (
        await db
          .prepare(
            'SELECT MAX(version) AS version FROM research_snapshots WHERE project_id = ?',
          )
          .bind(input.projectId)
          .first<{ version: number | null }>()
      )?.version ?? 0,
    ) + 1;
  const nextProjectHash = stableHash(nextProject);
  // 先写项目行并判定命中，再写其余内容；没命中就抛错回滚。
  // 之前每条语句都要挂一份 `WHERE EXISTS (...)` 守卫、多带 4 个绑定参数，
  // 旧实现缺少交互式事务时需要重复守卫条件；PostgreSQL 行锁下不再需要。
  return db.transaction(async (tx) => {
    const updated = await tx
      .prepare(
        "UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = 'RESEARCHING', version = version + 1, updated_at = ? WHERE id = ? AND version = ?",
      )
      .bind(
        JSON.stringify(nextProject),
        nextProjectHash,
        timestamp,
        input.projectId,
        input.expectedVersion,
      )
      .run();
    if (!updated.meta.changes)
      throw new WorkflowError('项目已被其他用户修改。', 'VERSION_CONFLICT');

    await tx
      .prepare(
        'DELETE FROM evidence_links WHERE claim_id IN (SELECT id FROM claims WHERE project_id = ?)',
      )
      .bind(input.projectId)
      .run();
    await tx
      .prepare('DELETE FROM claims WHERE project_id = ?')
      .bind(input.projectId)
      .run();
    await tx
      .prepare(`
        INSERT INTO research_snapshots (id, project_id, version, snapshot_json, snapshot_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(
        research.snapshotId,
        input.projectId,
        nextVersion,
        JSON.stringify(research),
        research.approvedHash,
        timestamp,
      )
      .run();

    for (const claim of claims) {
      const databaseClaimId = `${input.projectId}_${claim.id}`;
      const hasRefutation = claim.evidence.some(
        (evidence) => evidence.stance === 'refutes',
      );
      const conflict = research.conflicts.find(
        (item) => item.claimId === claim.id,
      );
      const verifiable = !['opinion', 'disclaimer'].includes(claim.kind);
      const status =
        hasRefutation && !conflict?.resolution
          ? 'conflicted'
          : verifiable &&
              claim.evidence.some((evidence) => evidence.stance === 'supports')
            ? 'supported'
            : 'draft';
      await tx
        .prepare(`
          INSERT INTO claims (id, project_id, logical_id, text, kind, quantity_json, status, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        `)
        .bind(
          databaseClaimId,
          input.projectId,
          claim.id,
          claim.text.trim(),
          claim.kind,
          claim.quantity ? JSON.stringify(claim.quantity) : null,
          status,
          timestamp,
          timestamp,
        )
        .run();
      for (const evidence of claim.evidence) {
        // article_id / article_revision_id 用子查询取：引用的文章可能已经被留存策略清掉，
        // 取不到就写 NULL，而不是让整条快照写入失败。
        await tx
          .prepare(`
            INSERT INTO evidence_links (id, claim_id, article_id, article_revision_id, source_url, stance, excerpt, locator_json, source_hash, observed_at, created_at)
            VALUES (?, ?, (SELECT id FROM articles WHERE id = ? LIMIT 1), (SELECT id FROM article_revisions WHERE id = ? LIMIT 1), ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            `evidence_${crypto.randomUUID()}`,
            databaseClaimId,
            evidence.sourceId,
            evidence.articleRevisionId,
            evidence.url,
            evidence.stance,
            evidence.quote.trim(),
            JSON.stringify(evidence.locator),
            stableHash(evidence),
            evidence.observedAt,
            timestamp,
          )
          .run();
      }
    }

    await auditStatement(tx, {
      projectId: input.projectId,
      actor: input.actor,
      action: 'research.version_created',
      entityType: 'research',
      entityId: research.snapshotId,
      beforeHash: project.project.research.approvedHash,
      afterHash: research.approvedHash,
      metadata: {
        version: nextVersion,
        approvalsInvalidated: true,
        trigger: input.trigger ?? 'human',
      },
      now: timestamp,
    }).run();
    if ((input.trigger ?? 'human') === 'human') {
      await pauseAutomationStatement(
        tx,
        input.projectId,
        '人工编辑了研究快照，自动化已暂停，需显式恢复。',
      ).run();
    }

    return {
      project: (await loadContentProject(tx, input.projectId))!,
      status: 200 as const,
    };
  });
}

export async function listProjectAudit(db: SqlDatabase, projectId: string) {
  const result = await db
    .prepare(`
      SELECT id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
             after_hash, metadata_json, request_id, created_at
      FROM audit_events WHERE project_id = ? ORDER BY created_at DESC, seq DESC LIMIT 200
    `)
    .bind(projectId)
    .all();
  return result.results.map((row) => {
    const metadata = parseJsonColumn<unknown>(row.metadata_json);
    if (metadata === null)
      console.warn(
        `审计事件 ${String(row.id)} 的 metadata_json 无法解析，已回退为空对象。`,
      );
    return { ...row, metadata: metadata ?? {}, metadata_json: undefined };
  });
}

export async function evaluateProjectGates(
  db: SqlDatabase,
  projectId: string,
): Promise<GateResult[]> {
  const project = await loadContentProject(db, projectId);
  if (!project) return [];
  const [evidence, assetsResult, approvalsResult, qc, metrics, evidencePolicy] =
    await Promise.all([
      db
        .prepare(`
      SELECT c.logical_id AS id, c.kind, e.stance, e.source_hash, e.source_url,
        a.source, a.source_type, a.content_hash,
        sc.platform, COALESCE(correction.relationship, o.relationship) AS relationship,
        COALESCE(correction.confidence, o.confidence) AS confidence,
        COALESCE(correction.evidence_family_id, o.evidence_family_id) AS evidence_family_id,
        COALESCE(correction.publisher_entity_id, o.publisher_entity_id) AS publisher_entity_id,
        COALESCE(cpe.ownership_group, pe.ownership_group, correction.publisher_entity_id, o.publisher_entity_id) AS publisher_ownership_group,
        (o.id IS NOT NULL) AS origin_managed,
        (correction.id IS NOT NULL) AS manually_corrected
      FROM claims c
      LEFT JOIN evidence_links e ON e.claim_id = c.id
      LEFT JOIN articles a ON a.id = e.article_id
      LEFT JOIN source_item_origins o ON o.article_id = a.id AND o.deleted_at IS NULL
      LEFT JOIN source_configs sc ON sc.id = o.source_config_id
      LEFT JOIN source_origin_corrections correction
        ON correction.origin_id = o.id AND correction.supersedes_correction_id IS NULL
      LEFT JOIN publisher_entities pe ON pe.id = o.publisher_entity_id
      LEFT JOIN publisher_entities cpe ON cpe.id = correction.publisher_entity_id
      WHERE c.project_id = ?
    `)
        .bind(projectId)
        .all<{
          id: string; kind: string; stance: string | null; source_hash: string | null;
          source_url: string | null; source: string | null; source_type: string | null;
          content_hash: string | null; platform: string | null; relationship: EvidenceOrigin['originRelationship'] | null;
          confidence: number | null; evidence_family_id: string | null; publisher_entity_id: string | null;
          publisher_ownership_group: string | null; origin_managed: boolean | null; manually_corrected: boolean | null;
        }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS total, SUM(CASE WHEN rights_status != 'cleared' THEN 1 ELSE 0 END) AS uncleared FROM assets WHERE project_id = ?`,
        )
        .bind(projectId)
        .first<{ total: number; uncleared: number | null }>(),
      db
        .prepare(
          `SELECT kind, decision, subject_hash, actor_id, created_at FROM approvals WHERE project_id = ? ORDER BY created_at DESC, seq DESC`,
        )
        .bind(projectId)
        .all<{
          kind: string;
          decision: string;
          subject_hash: string;
          actor_id: string;
          created_at: string;
        }>(),
      db
        .prepare(
          `SELECT status FROM qc_reports WHERE project_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1`,
        )
        .bind(projectId)
        .first<{ status: string }>(),
      db
        .prepare(
          'SELECT COUNT(*) AS total FROM metric_snapshots WHERE project_id = ?',
        )
        .bind(projectId)
        .first<{ total: number }>(),
      loadApprovedEvidencePolicy(db),
    ]);
  const latestApproval = new Map<
    string,
    (typeof approvalsResult.results)[number]
  >();
  for (const approval of approvalsResult.results)
    if (!latestApproval.has(approval.kind))
      latestApproval.set(approval.kind, approval);
  const allEvidenceUrlsValid = project.project.research.claims.every((claim) =>
    claim.evidence.every((item) => /^https?:\/\//.test(item.url)),
  );
  const evidenceOriginFor = (row: (typeof evidence.results)[number]) => ({
    source: row.source ?? row.source_url ?? 'external-evidence',
    sourceType: row.source_type ?? 'media',
    contentHash: row.content_hash ?? row.source_hash ?? stableHash(row.source_url ?? ''),
    platform: row.platform ?? undefined,
    evidenceFamilyId: row.evidence_family_id ?? undefined,
    publisherEntityId: row.publisher_entity_id ?? undefined,
    publisherOwnershipGroup: row.publisher_ownership_group ?? undefined,
    originRelationship: row.relationship ?? undefined,
    originConfidence: row.confidence ?? undefined,
    originManaged: row.origin_managed ?? false,
    originManuallyCorrected: row.manually_corrected ?? false,
  } satisfies EvidenceOrigin);
  const evidenceOrigins = evidence.results
    .filter((row) => row.stance === 'supports')
    .map(evidenceOriginFor);
  const distinctSources = independentEvidenceCount(evidenceOrigins, evidencePolicy);
  const claimRows = new Map<string, { id: string; kind: string; supports: number; refutes: number; qualifiedSupports: number }>();
  for (const row of evidence.results) {
    const current = claimRows.get(row.id) ?? { id: row.id, kind: row.kind, supports: 0, refutes: 0, qualifiedSupports: 0 };
    if (row.stance === 'supports') {
      current.supports += 1;
      if (qualifiedEvidenceEdge(evidenceOriginFor(row), evidencePolicy)) current.qualifiedSupports += 1;
    }
    if (row.stance === 'refutes') current.refutes += 1;
    claimRows.set(row.id, current);
  }
  const factualClaims = [...claimRows.values()].filter((claim) => !['opinion', 'disclaimer'].includes(claim.kind));
  const unsupported = factualClaims.filter((claim) => claim.supports < 1 || claim.qualifiedSupports < 1);
  const resolvedConflictIds = new Set(
    project.project.research.conflicts
      .filter((conflict) => conflict.resolution?.trim())
      .map((conflict) => conflict.claimId),
  );
  const conflicts = factualClaims.filter(
    (claim) => Number(claim.refutes) > 0 && !resolvedConflictIds.has(claim.id),
  );
  const scriptClaimIds = new Set(
    project.project.script.lines.flatMap((line) => line.claimIds),
  );
  const uncovered = project.project.research.claims.filter(
    (claim) =>
      !['opinion', 'disclaimer'].includes(claim.kind) &&
      !scriptClaimIds.has(claim.id),
  );
  const researchApproval = latestApproval.get('research');
  const scriptApproval = latestApproval.get('script');
  const qcApproval = latestApproval.get('qc');
  const publishApproval = latestApproval.get('publish');
  const targetDurationMs = project.project.render.durationSeconds * 1_000;
  const audioDurationMs = project.project.audio.durationMs ?? 0;
  const audioDurationRatio =
    targetDurationMs > 0 ? audioDurationMs / targetDurationMs : 0;
  const captionEndMs = Math.max(
    0,
    ...project.project.captions.map((caption) => caption.endMs),
  );
  const audioReady =
    Boolean(project.project.audio.objectKey) &&
    /^([a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(
      project.project.audio.sha256 ?? '',
    ) &&
    audioDurationRatio >= 0.6 &&
    audioDurationRatio <= 1.1 &&
    project.project.captions.length > 0 &&
    captionEndMs >= audioDurationMs - 1_000;
  return [
    {
      code: 'G0_SOURCE_RIGHTS',
      passed: allEvidenceUrlsValid && distinctSources >= 2,
      reasons:
        allEvidenceUrlsValid && distinctSources >= 2
          ? []
          : ['来源 URL 无效，或合格 evidence-family ↔ publisher-group 最大匹配少于 2 个'],
    },
    {
      code: 'G1_INPUT_QUALITY',
      passed: Boolean(project.title && project.project.identity.locale),
      reasons:
        project.title && project.project.identity.locale
          ? []
          : ['项目标题或语言缺失'],
    },
    {
      code: 'G2_AUTO_EVIDENCE',
      passed:
        factualClaims.length > 0 &&
        unsupported.length === 0 &&
        conflicts.length === 0,
      reasons: [
        ...unsupported.map((claim) => `${claim.id} 缺少合格的声明级支持证据`),
        ...conflicts.map((claim) => `${claim.id} 存在未解决反驳证据`),
      ],
    },
    {
      code: 'G3_MANUAL_RESEARCH',
      passed:
        researchApproval?.decision === 'approved' &&
        researchApproval.subject_hash === project.project.research.approvedHash,
      reasons:
        researchApproval?.decision === 'approved' &&
        researchApproval.subject_hash === project.project.research.approvedHash
          ? []
          : ['研究快照尚未由编辑批准或批准哈希已过期'],
    },
    {
      code: 'G4_SCRIPT_COVERAGE',
      passed:
        uncovered.length === 0 &&
        scriptApproval?.decision === 'approved' &&
        scriptApproval.subject_hash === stableHash(project.project.script),
      reasons: [
        ...uncovered.map((claim) => `${claim.id} 未被脚本覆盖`),
        ...(scriptApproval?.decision === 'approved' &&
        scriptApproval.subject_hash === stableHash(project.project.script)
          ? []
          : ['当前脚本版本尚未批准']),
      ],
    },
    {
      code: 'G5_ASSET_RIGHTS',
      passed: audioReady && Number(assetsResult?.uncleared ?? 0) === 0,
      reasons: [
        ...(audioReady
          ? []
          : ['配音、哈希、字幕或实际时长未达到成片时长的 60%–110%']),
        ...(Number(assetsResult?.uncleared ?? 0) === 0
          ? []
          : [`${assetsResult?.uncleared} 个资产版权未清除`]),
      ],
    },
    {
      code: 'G6_CONTENT_TECH_QC',
      passed:
        qc?.status === 'passed' &&
        qcApproval?.decision === 'approved' &&
        qcApproval.subject_hash === project.immutableHash,
      reasons:
        qc?.status === 'passed' &&
        qcApproval?.decision === 'approved' &&
        qcApproval.subject_hash === project.immutableHash
          ? []
          : ['自动 QC 或当前成片的人工终审未通过'],
    },
    {
      code: 'G7_PUBLISH_APPROVAL',
      passed:
        publishApproval?.decision === 'approved' &&
        publishApproval.subject_hash === project.immutableHash &&
        publishApproval.actor_id !== researchApproval?.actor_id,
      reasons:
        publishApproval?.decision === 'approved' &&
        publishApproval.subject_hash === project.immutableHash &&
        publishApproval.actor_id !== researchApproval?.actor_id
          ? []
          : ['当前成片尚未由独立发布人批准'],
    },
    {
      code: 'G8_POST_PUBLISH',
      passed: Number(metrics?.total ?? 0) > 0,
      reasons: Number(metrics?.total ?? 0) > 0 ? [] : ['尚无发布后指标快照'],
    },
  ];
}

export async function recordApproval(
  db: SqlDatabase,
  input: {
    projectId: string;
    kind: 'research' | 'script' | 'qc' | 'publish';
    decision: 'approved' | 'changes_requested' | 'rejected';
    subjectHash: string;
    note: string;
    actor: Actor;
    trigger?: AutomationTrigger;
    policyId?: string | null;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  const roles: Record<typeof input.kind, Role[]> = {
    research: ['editor', 'admin'],
    script: ['editor', 'admin'],
    qc: ['editor', 'producer', 'admin'],
    publish: ['publisher', 'admin'],
  };
  if (!roles[input.kind].includes(input.actor.role))
    return {
      error: `角色 ${input.actor.role} 无权执行 ${input.kind} 批准。`,
      status: 403 as const,
    };
  const expectedHash =
    input.kind === 'research'
      ? project.project.research.approvedHash
      : input.kind === 'script'
        ? stableHash(project.project.script)
        : project.immutableHash;
  if (input.subjectHash !== expectedHash)
    return {
      error: '批准对象哈希已过期，请刷新后重试。',
      status: 409 as const,
    };
  const timestamp = now.toISOString();
  const id = `approval_${crypto.randomUUID()}`;
  const trigger = input.trigger ?? 'human';
  await db.batch([
    db
      .prepare(`
      INSERT INTO approvals (id, project_id, kind, decision, subject_hash, actor_id, actor_role, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        id,
        input.projectId,
        input.kind,
        input.decision,
        input.subjectHash,
        input.actor.id,
        input.actor.role,
        input.note,
        timestamp,
      ),
    auditStatement(db, {
      projectId: input.projectId,
      actor: input.actor,
      action: `approval.${input.decision}`,
      entityType: input.kind,
      entityId: input.projectId,
      afterHash: input.subjectHash,
      metadata: {
        kind: input.kind,
        note: input.note,
        trigger,
        policyId: input.policyId ?? null,
      },
      now: timestamp,
    }),
    // 人工审批意味着有人接管了这个项目；自动化让位，直到有人显式恢复。
    ...(trigger === 'human'
      ? [
          pauseAutomationStatement(
            db,
            input.projectId,
            `人工完成了 ${input.kind} 审批，自动化已暂停，需显式恢复。`,
          ),
        ]
      : []),
  ]);
  return { approval: { id, ...input, actor: undefined }, status: 201 as const };
}

export async function enqueueJob(
  db: SqlDatabase,
  input: {
    kind:
      | 'ingestion'
      | 'voice'
      | 'preview'
      | 'render'
      | 'qc'
      | 'publish'
      | 'metrics';
    projectId?: string | null;
    payload: unknown;
    idempotencyKey: string;
    maxAttempts?: number;
    priority?: number;
    timeoutSeconds?: number;
    estimatedCostMicros?: number;
    availableAt?: string;
    requiredCapability?: string;
    requiredCapabilityProtocolVersion?: number;
    payloadSchemaVersion?: number;
    actor: Actor;
    trigger?: AutomationTrigger;
    policyId?: string | null;
  },
  now = new Date(),
) {
  const id = `job_${crypto.randomUUID()}`;
  const timestamp = now.toISOString();
  const availableAt =
    input.availableAt && !Number.isNaN(new Date(input.availableAt).valueOf())
      ? input.availableAt
      : timestamp;
  return db.transaction(async (tx) => {
    // ON CONFLICT DO NOTHING + RETURNING：插入成功就拿到行，撞上唯一索引就拿到空结果，
    // 幂等判定和写入是同一条语句，中间没有别的请求能插进来。
    const inserted = await tx
      .prepare(`
        INSERT INTO jobs
          (id, kind, project_id, automation_policy_id, required_capability, payload_schema_version,
           required_capability_protocol_version, payload_json, status, idempotency_key, attempt,
           max_attempts, priority, timeout_seconds, estimated_cost_micros, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind, idempotency_key) DO NOTHING
        RETURNING id, status
      `)
      .bind(
        id,
        input.kind,
        input.projectId ?? null,
        input.policyId ?? null,
        input.requiredCapability ?? '',
        input.payloadSchemaVersion ?? 1,
        input.requiredCapabilityProtocolVersion ?? 1,
        JSON.stringify(input.payload),
        input.idempotencyKey,
        input.maxAttempts ?? 5,
        input.priority ?? 50,
        input.timeoutSeconds ?? 900,
        input.estimatedCostMicros ?? 0,
        availableAt,
        timestamp,
        timestamp,
      )
      .first<{ id: string; status: string }>();
    if (!inserted) {
      const existing = await tx
        .prepare(
          'SELECT id, status, project_id, payload_json FROM jobs WHERE kind = ? AND idempotency_key = ? LIMIT 1',
        )
        .bind(input.kind, input.idempotencyKey)
        .first<{ id: string; status: string; project_id: string | null; payload_json: unknown }>();
      if (!existing)
        throw new Error(
          `作业 ${input.kind}/${input.idempotencyKey} 入队冲突但回读不到既有行。`,
        );
      const existingPayload = parseJsonColumn<unknown>(existing.payload_json);
      if (
        existing.project_id !== (input.projectId ?? null) ||
        existingPayload === null ||
        stableHash(existingPayload) !== stableHash(input.payload)
      ) throw new Error('IDEMPOTENCY_CONFLICT');
      return { id: existing.id, status: existing.status, created: false };
    }
    await auditStatement(tx, {
      projectId: input.projectId,
      actor: input.actor,
      action: 'job.enqueued',
      entityType: 'job',
      entityId: id,
      afterHash: stableHash(input.payload),
      metadata: {
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        trigger: input.trigger ?? 'human',
        policyId: input.policyId ?? null,
        requiredCapability: input.requiredCapability ?? '',
        requiredCapabilityProtocolVersion:
          input.requiredCapabilityProtocolVersion ?? 1,
        payloadSchemaVersion: input.payloadSchemaVersion ?? 1,
      },
      now: timestamp,
    }).run();
    return { id: inserted.id, status: inserted.status, created: true };
  });
}

export async function enqueueIngestionRun(
  db: SqlDatabase,
  input: {
    sourceConfigId: string;
    checkpoint?: string | null;
    idempotencyKey: string;
    actor: Actor;
    trigger?: AutomationTrigger;
    policyId?: string | null;
    runTrigger?: 'schedule' | 'manual' | 'backfill';
    scheduledFor?: string | null;
    checkpointJson?: unknown;
    sourceVersion?: number;
  },
  now = new Date(),
) {
  const id = `job_${crypto.randomUUID()}`;
  const ingestionRunId = `ingestion_${crypto.randomUUID()}`;
  const timestamp = now.toISOString();
  const payloadSchemaVersion = 2;
  const transactionResult = await db.transaction(async (tx) => {
    const replay = await tx
      .prepare(
        "SELECT j.id, j.status, ir.id AS ingestion_run_id FROM jobs j LEFT JOIN ingestion_runs ir ON ir.job_id = j.id WHERE j.kind = 'ingestion' AND j.idempotency_key = ? LIMIT 1",
      )
      .bind(input.idempotencyKey)
      .first<{ id: string; status: string; ingestion_run_id: string | null }>();
    if (replay)
      return {
        id: replay.id,
        status: replay.status,
        ingestionRunId: replay.ingestion_run_id,
        created: false,
        budgetWarning: null,
      };

    const source = await tx
      .prepare(`
        SELECT name, version, adapter, platform, config_hash,
          COALESCE(NULLIF(rights_config_hash, ''), config_hash) AS rights_config_hash,
          checkpoint, checkpoint_json, backfill_checkpoint_json,
          active_run_id, enabled, lifecycle_status, rights_status,
          cost_micros_per_request, estimated_requests_per_run, monthly_budget_micros,
          budget_soft_limit_percent,
          (SELECT COUNT(DISTINCT origin.article_id) FROM source_item_origins origin
            WHERE origin.source_config_id = source_configs.id AND origin.deleted_at IS NULL) AS affected_article_count,
          (SELECT COUNT(DISTINCT topic_article.topic_id)
            FROM source_item_origins origin
            JOIN topic_articles topic_article ON topic_article.article_id = origin.article_id
            WHERE origin.source_config_id = source_configs.id AND origin.deleted_at IS NULL) AS affected_topic_count
        FROM source_configs WHERE id = ? FOR UPDATE
      `)
      .bind(input.sourceConfigId)
      .first<{
        name: string;
        version: number;
        adapter: string;
        platform: string;
        config_hash: string;
        rights_config_hash: string;
        checkpoint: string | null;
        checkpoint_json: unknown;
        backfill_checkpoint_json: unknown;
        active_run_id: string | null;
        enabled: number;
        lifecycle_status: string;
        rights_status: string;
        cost_micros_per_request: number;
        estimated_requests_per_run: number;
        monthly_budget_micros: number | string;
        budget_soft_limit_percent: number;
        affected_article_count: number | string;
        affected_topic_count: number | string;
      }>();
    if (!source) throw new Error('来源不存在。');
    if (
      !source.enabled ||
      !['enabled', 'degraded'].includes(source.lifecycle_status) ||
      source.rights_status !== 'approved'
    ) {
      throw new Error('来源尚未启用，或当前权利状态不允许采集。');
    }
    const connector = sourceConnectorByPlatform(source.platform);
    if (!connector || connector.availability !== 'available') {
      throw new Error(connector?.unavailableReason ?? '来源连接器不可用。');
    }
    const release = await tx
      .prepare(`
      SELECT connector_id, connector_version, rollout_mode, canary_enabled,
        canary_percent FROM source_connector_releases
      WHERE connector_id = ? AND connector_version = ?
      LIMIT 1
      FOR UPDATE
    `)
      .bind(connector.id, connector.version)
      .first<{
        connector_id: string; connector_version: string;
        rollout_mode: 'disabled' | 'shadow' | 'enabled';
        canary_enabled: number; canary_percent: number;
      }>();
    if (!release || release.rollout_mode === 'disabled') {
      throw new Error(
        `连接器 ${connector.id}@${connector.version} 已被发布控制停用。`,
      );
    }
    const effectiveRelease = effectiveConnectorRollout({
      connectorId: release.connector_id,
      connectorVersion: release.connector_version,
      rolloutMode: release.rollout_mode,
      canaryEnabled: Boolean(release.canary_enabled),
      canaryPercent: release.canary_percent,
    }, input.sourceConfigId);
    if (source.active_run_id) {
      const active = await tx
        .prepare(
          "SELECT id FROM ingestion_runs WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(source.active_run_id)
        .first<{ id: string }>();
      if (active) throw new Error(`来源已有活动采集运行 ${active.id}。`);
    }
    const reservationMicros = Math.max(
      0,
      source.cost_micros_per_request * source.estimated_requests_per_run,
    );
    const spendRow = await tx
      .prepare(`
      SELECT COALESCE(SUM(cost_micros), 0) AS spent
      FROM ingestion_runs
      WHERE source_config_id = ? AND created_at >= ? AND status <> 'cancelled'
    `)
      .bind(input.sourceConfigId, utcMonthStart(now))
      .first<{ spent: number | string }>();
    const spentMicros = Number(spendRow?.spent ?? 0);
    const budgetMicros = Number(source.monthly_budget_micros);
    const projectedMicros = spentMicros + reservationMicros;
    if (budgetMicros > 0 && projectedMicros > budgetMicros) {
      return {
        budgetBlocked: {
          sourceId: input.sourceConfigId,
          sourceName: source.name,
          spentMicros,
          reservationMicros,
          budgetMicros,
          affectedArticleCount: Number(source.affected_article_count || 0),
          affectedTopicCount: Number(source.affected_topic_count || 0),
        },
      };
    }
    const budgetWarning =
      budgetMicros > 0 &&
      projectedMicros >= (budgetMicros * source.budget_soft_limit_percent) / 100
        ? {
            sourceId: input.sourceConfigId,
            sourceName: source.name,
            spentMicros,
            reservationMicros,
            projectedMicros,
            budgetMicros,
            softLimitPercent: source.budget_soft_limit_percent,
            affectedArticleCount: Number(source.affected_article_count || 0),
            affectedTopicCount: Number(source.affected_topic_count || 0),
          }
        : null;
    const rightsGrant = await tx
      .prepare(`
      SELECT id, permitted_fields_json, purpose, usage_scope, source_version, config_hash
      FROM source_rights_grants
      WHERE source_config_id = ? AND config_hash = ? AND source_version <= ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY verified_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
    `)
      .bind(input.sourceConfigId, source.rights_config_hash, source.version, timestamp)
      .first<{
        id: string;
        permitted_fields_json: unknown;
        purpose: string;
        usage_scope: string;
        source_version: number;
        config_hash: string;
      }>();
    if (!rightsGrant || rightsGrant.purpose !== INGESTION_RIGHTS_PURPOSE) {
      throw new Error('来源没有当前有效的编辑采集授权。');
    }
    if (
      ![NORMALIZED_METADATA_SCOPE, AUTHORIZED_RAW_SCOPE].includes(
        rightsGrant.usage_scope,
      )
    ) {
      throw new Error('来源授权范围不允许写入规范化采集结果。');
    }
    const permittedFields = Array.isArray(rightsGrant.permitted_fields_json)
      ? new Set(
          rightsGrant.permitted_fields_json.filter(
            (value): value is string => typeof value === 'string',
          ),
        )
      : new Set<string>();
    if (
      ['title', 'url', 'publishedAt'].some(
        (field) => !permittedFields.has(field),
      )
    ) {
      throw new Error('来源授权未包含规范化采集所需的最小字段。');
    }
    const requiredCapability = connector.requiredCapability;
    const requiredCapabilityProtocolVersion =
      connector.capabilityProtocolVersion;
    const sourceVersion = input.sourceVersion ?? source.version;
    const runTrigger =
      input.runTrigger ??
      (input.trigger === 'automation' ? 'schedule' : 'manual');
    const checkpointScope = runTrigger === 'backfill' ? 'backfill' : 'live';
    const checkpoint =
      checkpointScope === 'live'
        ? (input.checkpoint ?? source.checkpoint ?? null)
        : null;
    const checkpointJson =
      input.checkpointJson ??
      (checkpointScope === 'backfill'
        ? source.backfill_checkpoint_json
        : source.checkpoint_json) ??
      {};
    const payload = {
      schemaVersion: payloadSchemaVersion,
      sourceConfigId: input.sourceConfigId,
      ingestionRunId,
      checkpoint,
      checkpointJson,
      checkpointScope,
      sourceVersion,
      rightsGrantId: rightsGrant.id,
      connectorId: connector.id,
      connectorVersion: connector.version,
      configuredRolloutMode: release.rollout_mode,
      rolloutMode: effectiveRelease.mode,
      canaryEnabled: Boolean(release.canary_enabled),
      canarySelected: effectiveRelease.canarySelected,
      canaryBucket: effectiveRelease.canaryBucket,
      canaryPercent: release.canary_percent,
      shadow: effectiveRelease.mode === 'shadow',
    };
    const inserted = await tx
      .prepare(`
      INSERT INTO jobs (id, kind, required_capability, required_capability_protocol_version, payload_schema_version, payload_json, status, idempotency_key, attempt, max_attempts, estimated_cost_micros, available_at, created_at, updated_at)
      VALUES (?, 'ingestion', ?, ?, ?, ?, 'queued', ?, 0, 5, ?, ?, ?, ?)
      ON CONFLICT (kind, idempotency_key) DO NOTHING
      RETURNING id, status
    `)
      .bind(
        id,
        requiredCapability,
        requiredCapabilityProtocolVersion,
        payloadSchemaVersion,
        JSON.stringify(payload),
        input.idempotencyKey,
        reservationMicros,
        timestamp,
        timestamp,
        timestamp,
      )
      .first<{ id: string; status: string }>();
    if (!inserted) {
      const existing = await tx
        .prepare(
          "SELECT j.id, j.status, ir.id AS ingestion_run_id FROM jobs j LEFT JOIN ingestion_runs ir ON ir.job_id = j.id WHERE j.kind = 'ingestion' AND j.idempotency_key = ? LIMIT 1",
        )
        .bind(input.idempotencyKey)
        .first<{
          id: string;
          status: string;
          ingestion_run_id: string | null;
        }>();
      if (!existing)
        throw new Error(
          `采集作业 ${input.idempotencyKey} 入队冲突但回读不到既有行。`,
        );
      return {
        id: existing.id,
        status: existing.status,
        ingestionRunId: existing.ingestion_run_id,
        created: false,
        budgetWarning: null,
      };
    }
    await tx
      .prepare(`
      INSERT INTO ingestion_runs
        (id, source_config_id, job_id, status, checkpoint_before, checkpoint_before_json, checkpoint_scope,
         source_version, rights_grant_id,
         scheduled_for, trigger, required_capability, connector_version,
         connector_id, payload_schema_version, shadow, cost_micros_per_request,
         cost_micros, created_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .bind(
        ingestionRunId,
        input.sourceConfigId,
        id,
        checkpoint,
        JSON.stringify(checkpointJson),
        checkpointScope,
        sourceVersion,
        rightsGrant.id,
        input.scheduledFor ?? null,
        runTrigger,
        requiredCapability,
        connector.version,
        connector.id,
        payloadSchemaVersion,
        effectiveRelease.mode === 'shadow' ? 1 : 0,
        source.cost_micros_per_request,
        reservationMicros,
        timestamp,
      )
      .run();
    await tx
      .prepare(
        'UPDATE source_configs SET active_run_id = ?, last_attempt_at = ?, updated_at = ? WHERE id = ?',
      )
      .bind(ingestionRunId, timestamp, timestamp, input.sourceConfigId)
      .run();
    await auditStatement(tx, {
      actor: input.actor,
      action: 'job.enqueued',
      entityType: 'job',
      entityId: id,
      afterHash: stableHash(payload),
      metadata: {
        kind: 'ingestion',
        idempotencyKey: input.idempotencyKey,
        ingestionRunId,
        trigger: input.trigger ?? 'human',
        policyId: input.policyId ?? null,
        requiredCapability,
        requiredCapabilityProtocolVersion,
        payloadSchemaVersion,
        rightsGrantId: rightsGrant.id,
        connectorId: connector.id,
        connectorVersion: connector.version,
        configuredRolloutMode: release.rollout_mode,
        rolloutMode: effectiveRelease.mode,
        canaryEnabled: Boolean(release.canary_enabled),
        canarySelected: effectiveRelease.canarySelected,
        canaryBucket: effectiveRelease.canaryBucket,
        canaryPercent: release.canary_percent,
      },
      now: timestamp,
    }).run();
    return {
      id,
      status: 'queued',
      ingestionRunId: ingestionRunId as string | null,
      created: true,
      budgetWarning,
    };
  });
  if (transactionResult.budgetBlocked) {
    const blocked = transactionResult.budgetBlocked;
    await raiseAttentionItem(
      db,
      {
        kind: 'source_budget',
        severity: 'critical',
        sourceConfigId: blocked.sourceId,
        dedupeKey: `source_budget:${blocked.sourceId}:${utcMonthStart(now).slice(0, 7)}`,
        reason: `来源「${blocked.sourceName}」月度采集预算已耗尽，新的采集没有入队。`,
        detail: blocked,
      },
      now,
    );
    throw new SourceBudgetExceededError(blocked);
  }
  if (transactionResult.budgetWarning) {
    const warning = transactionResult.budgetWarning;
    await raiseAttentionItem(
      db,
      {
        kind: 'source_budget',
        severity: 'warning',
        sourceConfigId: warning.sourceId,
        dedupeKey: `source_budget:${warning.sourceId}:${utcMonthStart(now).slice(0, 7)}`,
        reason: `来源「${warning.sourceName}」预计达到月预算的 ${warning.softLimitPercent}% 软阈值。`,
        detail: warning,
      },
      now,
    );
  }
  const { budgetWarning: _budgetWarning, ...result } = transactionResult;
  return result;
}

export async function leaseNextJob(
  db: SqlDatabase,
  input: {
    workerId: string;
    kinds: string[];
    capabilities?: string[];
    capabilityProtocolVersions?: Record<string, number>;
    maxPayloadSchemaVersion?: number;
    leaseSeconds?: number;
    renderConcurrencyLimit?: number;
  },
  now = new Date(),
) {
  if (!input.kinds.length) return null;
  const placeholders = input.kinds.map(() => '?').join(', ');
  const capabilityProtocols = (input.capabilities ?? []).map((capability) => [
    capability,
    input.capabilityProtocolVersions?.[capability] ?? 1,
  ] as const);
  const capabilityClause = capabilityProtocols.length
    ? `(required_capability = '' OR ${capabilityProtocols
        .map(
          () =>
            '(required_capability = ? AND required_capability_protocol_version <= ?)',
        )
        .join(' OR ')})`
    : "required_capability = ''";
  const timestamp = now.toISOString();
  const concurrencyLimit = input.renderConcurrencyLimit ?? 2;

  // 整个领取过程在一个事务里：FOR UPDATE SKIP LOCKED 直接锁住选中的那一行，
  // 并发的其他 Worker 会跳过它去看下一条，不会撞在同一行上再靠守卫 UPDATE 淘汰。
  return db.transaction(async (tx) => {
    const row = await tx
      .prepare(`
      SELECT id, timeout_seconds, kind, project_id, payload_json FROM jobs
      WHERE kind IN (${placeholders})
        AND ${capabilityClause}
        AND payload_schema_version <= ?
        AND ((status IN ('queued', 'retrying') AND available_at <= ?)
          OR (status = 'leased' AND lease_expires_at <= ?))
        AND (kind != 'voice' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'SCRIPT_APPROVED'))
        AND (kind != 'preview' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'ASSETS_READY'))
        AND (kind != 'render' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'RENDER_QUEUED'))
        AND (kind != 'publish' OR payload_json ->> 'operation' = 'withdraw' OR (
          EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'PUBLISH_SCHEDULED')
          AND EXISTS (SELECT 1 FROM publish_jobs pj WHERE pj.id = jobs.payload_json ->> 'publishJobId' AND pj.status = 'scheduled')
        ))
        AND (kind != 'publish' OR payload_json ->> 'operation' IS DISTINCT FROM 'withdraw'
          OR payload_json ->> 'deletionRequestId' IS NULL OR EXISTS (
            SELECT 1
            FROM source_deletion_requests deletion_request
            JOIN source_deletion_items deletion_item
              ON deletion_item.request_id = deletion_request.id
             AND deletion_item.id = jobs.payload_json ->> 'deletionItemId'
            JOIN source_configs deletion_source
              ON deletion_source.id = deletion_request.source_config_id
            WHERE deletion_request.id = jobs.payload_json ->> 'deletionRequestId'
              AND deletion_request.status IN ('pending','deleting','awaiting_external')
              AND deletion_item.kind = 'external_publish'
              AND deletion_item.status = 'awaiting_external'
              AND CASE
                WHEN jsonb_typeof(jobs.payload_json -> 'legalHoldEpoch') = 'number'
                  THEN CAST(jobs.payload_json ->> 'legalHoldEpoch' AS integer)
                ELSE -1
              END = deletion_source.legal_hold_epoch
              AND NOT EXISTS (
                SELECT 1 FROM source_legal_holds active_hold
                WHERE active_hold.source_config_id = deletion_request.source_config_id
                  AND active_hold.status = 'active'
              )
          ))
        AND (kind != 'ingestion' OR payload_json ->> 'connectorId' IS NULL OR EXISTS (
          SELECT 1 FROM source_connector_releases release_control
          WHERE release_control.connector_id = jobs.payload_json ->> 'connectorId'
            AND release_control.connector_version = jobs.payload_json ->> 'connectorVersion'
            AND release_control.rollout_mode <> 'disabled'
        ))
        AND (kind != 'ingestion' OR payload_json ->> 'ingestionRunId' IS NULL OR EXISTS (
          SELECT 1
          FROM ingestion_runs rights_run
          JOIN source_configs rights_source ON rights_source.id = rights_run.source_config_id
          JOIN source_rights_grants rights_grant ON rights_grant.id = rights_run.rights_grant_id
          WHERE rights_run.id = jobs.payload_json ->> 'ingestionRunId'
            AND rights_run.status IN ('queued', 'running')
            AND rights_source.enabled = 1
            AND rights_source.lifecycle_status IN ('enabled', 'degraded')
            AND rights_source.rights_status = 'approved'
            AND rights_source.version = rights_run.source_version
            AND rights_grant.id = jobs.payload_json ->> 'rightsGrantId'
            AND rights_grant.config_hash = COALESCE(NULLIF(rights_source.rights_config_hash, ''), rights_source.config_hash)
            AND rights_grant.source_version <= rights_run.source_version
            AND rights_grant.purpose = 'finance-editorial-ingestion'
            AND rights_grant.usage_scope IN ('normalized-metadata', 'normalized-and-authorized-raw')
            AND rights_grant.revoked_at IS NULL
            AND (rights_grant.expires_at IS NULL OR rights_grant.expires_at > ?)
        ))
        AND (kind NOT IN ('preview', 'render') OR (SELECT COUNT(*) FROM jobs active WHERE active.kind IN ('preview', 'render') AND active.status = 'leased' AND active.lease_expires_at > ?) < ?)
      ORDER BY priority DESC, available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `)
      .bind(
        ...input.kinds,
        ...capabilityProtocols.flatMap(([capability, version]) => [
          capability,
          version,
        ]),
        input.maxPayloadSchemaVersion ?? 1,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        concurrencyLimit,
      )
      .first<{
        id: string;
        timeout_seconds: number;
        kind: string;
        project_id: string | null;
        payload_json: unknown;
      }>();
    if (!row) return null;

    const rowPayload = parseJsonColumn<Record<string, unknown>>(
      row.payload_json,
    );
    if (!rowPayload) {
      // 隔离读不出 payload 的作业：进 DLQ 并返回 null，否则一条坏行会让租约接口反复失败、整个队列卡死。
      await tx
        .prepare(
          "UPDATE jobs SET status = 'dead_letter', last_error = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(
          'payload_json 无法解析，作业已隔离到死信队列。',
          timestamp,
          row.id,
        )
        .run();
      console.error(
        `作业 ${row.id} 的 payload_json 已损坏，已标记 dead_letter。`,
      );
      return null;
    }

    const leaseExpiresAt = new Date(
      now.valueOf() +
        Math.min(input.leaseSeconds ?? 300, row.timeout_seconds) * 1000,
    ).toISOString();
    // 行已被锁住，这里不需要把上面的条件再抄一遍做守卫。
    await tx
      .prepare(`
        UPDATE jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
          lease_epoch = lease_epoch + 1, attempt = attempt + 1, updated_at = ?
        WHERE id = ?
      `)
      .bind(input.workerId, leaseExpiresAt, timestamp, row.id)
      .run();

    if (row.kind === 'render' && row.project_id) {
      await tx
        .prepare(
          "UPDATE content_projects SET state = 'RENDERING', version = version + 1, updated_at = ? WHERE id = ? AND state = 'RENDER_QUEUED'",
        )
        .bind(timestamp, row.project_id)
        .run();
    }
    if (row.kind === 'publish') {
      const payload = rowPayload as {
        publishJobId?: string;
        operation?: string;
      };
      if (payload.publishJobId && payload.operation !== 'withdraw') {
        await tx
          .prepare(
            "UPDATE publish_jobs SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'scheduled'",
          )
          .bind(timestamp, payload.publishJobId)
          .run();
      }
    }
    if (row.kind === 'ingestion') {
      const payload = rowPayload as {
        operation?: string;
        testId?: string;
        ingestionRunId?: string;
      };
      if (payload.operation === 'source_test' && payload.testId) {
        await tx
          .prepare(
            "UPDATE source_connection_tests SET status = 'running' WHERE id = ? AND status = 'queued'",
          )
          .bind(payload.testId)
          .run();
      } else if (payload.ingestionRunId) {
        await tx
          .prepare(
            "UPDATE ingestion_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'",
          )
          .bind(timestamp, payload.ingestionRunId)
          .run();
      }
    }

    const job = await tx
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .bind(row.id)
      .first<Record<string, unknown>>();
    return job
      ? { ...job, payload: rowPayload, payload_json: undefined }
      : null;
  });
}

/**
 * 续约：长任务（尤其是成片渲染）在执行期间周期性调用，避免租约到期后被另一个 Worker 重复领取。
 * 续约时长仍受作业自身 timeout_seconds 约束。
 */
export async function renewJobLease(
  db: SqlDatabase,
  input: { id: string; workerId: string; leaseEpoch: number; leaseSeconds?: number },
  now = new Date(),
) {
  const row = await db
    .prepare(
      "SELECT timeout_seconds FROM jobs WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_epoch = ? AND lease_expires_at > ?",
    )
    .bind(input.id, input.workerId, input.leaseEpoch, now.toISOString())
    .first<{ timeout_seconds: number }>();
  if (!row)
    return {
      error: '作业不存在、未租约、租约已过期或不属于该 Worker。',
      status: 409 as const,
    };
  const leaseExpiresAt = new Date(
    now.valueOf() +
      Math.min(input.leaseSeconds ?? 300, row.timeout_seconds) * 1000,
  ).toISOString();
  const updated = await db
    .prepare(
      "UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_epoch = ?",
    )
    .bind(leaseExpiresAt, now.toISOString(), input.id, input.workerId, input.leaseEpoch)
    .run();
  if (!updated.meta.changes)
    return {
      error: '作业租约已过期或已由其他 Worker 接管。',
      status: 409 as const,
    };
  return { id: input.id, leaseEpoch: input.leaseEpoch, leaseExpiresAt, status: 200 as const };
}

export async function finishJob(
  db: SqlDatabase,
  /**
   * terminal=true 表示失败不可重试（例如自动 QC 未通过）：直接进 DLQ，
   * 不要再烧一轮渲染成本去复现同一个确定性失败。
   */
  input: {
    id: string;
    workerId: string;
    leaseEpoch: number;
    succeeded: boolean;
    result?: unknown;
    error?: string;
    errorCode?: string;
    retryDelaySeconds?: number;
    terminal?: boolean;
  },
  now = new Date(),
) {
  const row = await db
    .prepare(
      "SELECT attempt, max_attempts, kind, payload_json, project_id FROM jobs WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_epoch = ?",
    )
    .bind(input.id, input.workerId, input.leaseEpoch)
    .first<{
      attempt: number;
      max_attempts: number;
      kind: string;
      payload_json: string;
      project_id: string | null;
    }>();
  if (!row)
    return {
      error: '作业不存在、未租约或租约不属于该 Worker。',
      status: 409 as const,
    };
  const timestamp = now.toISOString();
  const status = input.succeeded
    ? 'succeeded'
    : input.terminal || row.attempt >= row.max_attempts
      ? 'dead_letter'
      : 'retrying';
  const availableAt = new Date(
    now.valueOf() +
      (input.retryDelaySeconds ?? Math.min(900, 2 ** row.attempt * 15)) * 1000,
  ).toISOString();
  const errorCode =
    input.errorCode && /^[A-Z][A-Z0-9_]{1,79}$/.test(input.errorCode)
      ? input.errorCode
      : input.terminal
        ? 'SCHEMA_CHANGED'
        : 'NETWORK';
  const sourceHealthStatus = 'degraded';
  const costMicros =
    input.result &&
    typeof input.result === 'object' &&
    Number.isInteger((input.result as { costMicros?: unknown }).costMicros)
      ? Math.max(0, Number((input.result as { costMicros: number }).costMicros))
      : 0;
  const resultRecord =
    input.result && typeof input.result === 'object'
      ? (input.result as Record<string, unknown>)
      : {};
  const resultAsset =
    resultRecord.asset && typeof resultRecord.asset === 'object'
      ? (resultRecord.asset as Record<string, unknown>)
      : {};
  const outputObjectKey =
    typeof resultAsset.objectKey === 'string'
      ? resultAsset.objectKey
      : typeof resultRecord.outputObjectKey === 'string'
        ? resultRecord.outputObjectKey
        : null;
  const logObjectKey =
    typeof resultRecord.logObjectKey === 'string'
      ? resultRecord.logObjectKey
      : null;
  const durationMs =
    Number.isFinite(resultRecord.durationMs) &&
    Number(resultRecord.durationMs) >= 0
      ? Math.round(Number(resultRecord.durationMs))
      : null;
  const jobGuardSql = `EXISTS (
    SELECT 1 FROM jobs
    WHERE id = ? AND status = ? AND updated_at = ? AND lease_owner IS NULL
  )`;
  const jobGuardBindings = [input.id, status, timestamp] as const;
  const statements = [
    db
      .prepare(`
      UPDATE jobs SET status = ?, result_json = ?, output_object_key = ?, log_object_key = ?, duration_ms = ?, last_error = ?, cost_micros = ?, available_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ? AND lease_epoch = ?
    `)
      .bind(
        status,
        input.result === undefined ? null : JSON.stringify(input.result),
        outputObjectKey,
        logObjectKey,
        durationMs,
        input.error ?? null,
        costMicros,
        availableAt,
        timestamp,
        input.id,
        input.workerId,
        input.leaseEpoch,
      ),
  ];
  if (row.kind === 'ingestion') {
    const payload =
      parseJsonColumn<{
        operation?: string;
        testId?: string;
        ingestionRunId?: string;
        sourceConfigId?: string;
      }>(row.payload_json) ?? {};
    // 逐页 complete 可能已提交成功，但响应在回到 Worker 前丢失。此时 Worker
    // 报告失败只能让 job 重试，不能把已成功的 run/source 倒写成失败；下一租约
    // 会重放 complete 的持久结果并把 job 正常完成。
    const ingestionAlreadyCommitted = Boolean(
      !input.succeeded &&
      payload.ingestionRunId &&
      await db.prepare(`
        SELECT id FROM ingestion_runs
        WHERE id = ? AND status IN ('succeeded', 'partial')
        LIMIT 1
      `).bind(payload.ingestionRunId).first<{ id: string }>(),
    );
    if (
      payload.operation === 'source_test' &&
      payload.testId &&
      !input.succeeded
    ) {
      statements.push(
        db
          .prepare(`
        UPDATE source_connection_tests SET status = ?, error_code = ?,
          error_detail_redacted = ?, finished_at = ?
        WHERE id = ? AND ${jobGuardSql}
      `)
          .bind(
            status === 'dead_letter' ? 'failed' : 'queued',
            errorCode,
            (input.error ?? '连接测试失败').slice(0, 500),
            status === 'dead_letter' ? timestamp : null,
            payload.testId,
            ...jobGuardBindings,
          ),
      );
      if (payload.sourceConfigId) {
        statements.push(
          db
            .prepare(`
          UPDATE source_configs SET lifecycle_status = CASE WHEN enabled = 1 THEN 'degraded' ELSE ? END,
            health_status = ?, last_error = ?, last_error_code = ?,
            last_error_detail_redacted = ?, consecutive_failures = consecutive_failures + 1,
            retry_after = ?, backoff_until = ?,
            updated_at = ? WHERE id = ? AND ${jobGuardSql}
        `)
            .bind(
              status === 'dead_letter' ? 'draft' : 'connecting',
              sourceHealthStatus,
              input.error ?? '连接测试失败',
              errorCode,
              (input.error ?? '连接测试失败').slice(0, 500),
              status === 'retrying' ? availableAt : null,
              status === 'retrying' ? availableAt : null,
              timestamp,
              payload.sourceConfigId,
              ...jobGuardBindings,
            ),
        );
      }
    }
    if (payload.ingestionRunId && !input.succeeded && !ingestionAlreadyCommitted) {
      statements.push(
        db
          .prepare(
            `UPDATE ingestion_runs SET status = ?, error_code = ?, retryable = ?, retry_after = ?, error_json = ?, finished_at = ? WHERE id = ? AND ${jobGuardSql}`,
          )
          .bind(
            errorCode === 'RIGHTS_BLOCKED'
              ? 'rights_blocked'
              : status === 'dead_letter'
                ? 'failed'
                : 'queued',
            errorCode,
            status === 'retrying' ? 1 : 0,
            status === 'retrying' ? availableAt : null,
            JSON.stringify({
              code: errorCode,
              message: input.error ?? '采集失败',
              attempt: row.attempt,
            }),
            status === 'dead_letter' ? timestamp : null,
            payload.ingestionRunId,
            ...jobGuardBindings,
          ),
      );
    }
    if (payload.sourceConfigId && !input.succeeded && !ingestionAlreadyCommitted) {
      statements.push(
        db
          .prepare(`
        UPDATE source_configs SET
          enabled = CASE WHEN ? IN ('RIGHTS_BLOCKED', 'CONNECTOR_DISABLED') THEN 0 ELSE enabled END,
          lifecycle_status = CASE WHEN ? IN ('RIGHTS_BLOCKED', 'CONNECTOR_DISABLED') THEN 'paused' ELSE lifecycle_status END,
          next_run_at = CASE WHEN ? IN ('RIGHTS_BLOCKED', 'CONNECTOR_DISABLED') THEN NULL ELSE next_run_at END,
          last_error = ?, last_error_code = ?, health_status = ?,
          consecutive_failures = consecutive_failures + 1,
          retry_after = ?, backoff_until = ?,
          active_run_id = CASE WHEN ? = 'dead_letter' AND active_run_id = ? THEN NULL ELSE active_run_id END,
          updated_at = ?
        WHERE id = ? AND ${jobGuardSql}
      `)
          .bind(
            errorCode,
            errorCode,
            errorCode,
            input.error ?? '采集失败',
            errorCode,
            sourceHealthStatus,
            status === 'retrying' ? availableAt : null,
            status === 'retrying' ? availableAt : null,
            status,
            payload.ingestionRunId ?? '',
            timestamp,
            payload.sourceConfigId,
            ...jobGuardBindings,
          ),
      );
    }
  }
  if (row.kind === 'render' && row.project_id) {
    statements.push(
      db
        .prepare(
          `UPDATE content_projects SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'RENDERING' AND ${jobGuardSql}`,
        )
        .bind(
          input.succeeded
            ? 'QC_PENDING'
            : status === 'dead_letter'
              ? 'FAILED'
              : 'RENDER_QUEUED',
          timestamp,
          row.project_id,
          ...jobGuardBindings,
        ),
    );
  }
  if (row.kind === 'publish' && !input.succeeded) {
    const payload =
      parseJsonColumn<{
        publishJobId?: string;
        operation?: string;
        deletionRequestId?: string;
        deletionItemId?: string;
      }>(row.payload_json) ?? {};
    if (payload.publishJobId && payload.operation !== 'withdraw')
      statements.push(
        db
          .prepare(
            `UPDATE publish_jobs SET status = ?, updated_at = ? WHERE id = ? AND ${jobGuardSql}`,
          )
          .bind(
            status === 'dead_letter' ? 'failed' : 'scheduled',
            timestamp,
            payload.publishJobId,
            ...jobGuardBindings,
          ),
      );
    if (
      payload.operation === 'withdraw' &&
      payload.deletionItemId &&
      payload.deletionRequestId &&
      status === 'dead_letter'
    ) {
      statements.push(
        db
          .prepare(`
        UPDATE source_deletion_items SET status = 'failed', last_error_redacted = ?, updated_at = ?
        WHERE id = ? AND request_id = ? AND kind = 'external_publish' AND ${jobGuardSql}
      `)
          .bind(
            errorCode,
            timestamp,
            payload.deletionItemId,
            payload.deletionRequestId,
            ...jobGuardBindings,
          ),
      );
      statements.push(
        db
          .prepare(`
        UPDATE source_deletion_requests SET status = 'failed', last_error_redacted = 'EXTERNAL_DELETE_FAILED',
          lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status <> 'blocked' AND ${jobGuardSql}
      `)
          .bind(timestamp, payload.deletionRequestId, ...jobGuardBindings),
      );
    }
  }
  if (row.kind === 'publish' && input.succeeded) {
    const payload =
      parseJsonColumn<{
        publishJobId?: string;
        operation?: string;
        deletionRequestId?: string;
        deletionItemId?: string;
      }>(row.payload_json) ?? {};
    if (payload.operation === 'withdraw' && payload.publishJobId) {
      statements.push(
        db
          .prepare(
            `UPDATE publish_jobs SET status = 'withdrawn', updated_at = ? WHERE id = ? AND ${jobGuardSql}`,
          )
          .bind(timestamp, payload.publishJobId, ...jobGuardBindings),
      );
      if (payload.deletionItemId && payload.deletionRequestId) {
        const receiptHash = stableHash({
          deletionItemId: payload.deletionItemId,
          publishJobId: payload.publishJobId,
          result: resultRecord,
          completedAt: timestamp,
        });
        statements.push(
          db
            .prepare(`
          UPDATE source_deletion_items SET status = 'confirmed', receipt_hash = ?, receipt_json = ?,
            last_error_redacted = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND request_id = ? AND kind = 'external_publish'
            AND status = 'awaiting_external' AND ${jobGuardSql}
        `)
            .bind(
              receiptHash,
              JSON.stringify({
                outcome: 'withdrawn',
                publishJobId: payload.publishJobId,
                externalId: resultRecord.externalId ?? null,
              }),
              timestamp,
              timestamp,
              payload.deletionItemId,
              payload.deletionRequestId,
              ...jobGuardBindings,
            ),
        );
        statements.push(
          db
            .prepare(`
          UPDATE source_deletion_requests SET status = 'pending', updated_at = ?
          WHERE id = ? AND status IN ('pending','deleting','awaiting_external') AND ${jobGuardSql}
        `)
            .bind(timestamp, payload.deletionRequestId, ...jobGuardBindings),
        );
      }
    }
  }
  const [updated] = await db.batch(statements);
  if (!updated.meta.changes)
    return {
      error: '作业租约已过期或已由其他 Worker 完成。',
      status: 409 as const,
    };
  return {
    id: input.id,
    status,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
  };
}

/**
 * 创建发布任务：校验状态与 G7、绑定成片资产、写 publish_jobs 与 publish 作业。
 *
 * 路由和编排引擎共用这一份实现——发布是最不能有两套判定的地方，
 * 复制一份到引擎里迟早会和路由这边走偏。
 */
export async function schedulePublishJob(
  db: SqlDatabase,
  input: {
    projectId: string;
    channel: 'package' | 'youtube';
    title: string;
    description?: string;
    tags?: string[];
    coverAssetId?: string | null;
    accountId?: string | null;
    scheduledAt?: string | null;
    privacyStatus?: string;
    correctionOfId?: string | null;
    requestIdempotencyKey?: string;
    actor: Actor;
    trigger?: AutomationTrigger;
    policyId?: string | null;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  if (project.state !== 'PUBLISH_SCHEDULED')
    return {
      error: '项目必须先完成独立发布批准并进入 PUBLISH_SCHEDULED。',
      status: 409 as const,
    };
  const gates = await evaluateProjectGates(db, input.projectId);
  if (!gates.find((gate) => gate.code === 'G7_PUBLISH_APPROVAL')?.passed)
    return { error: '独立发布批准未通过或已过期。', status: 409 as const };
  const asset = await db
    .prepare(
      "SELECT id, object_key, byte_size, sha256 FROM assets WHERE project_id = ? AND media_type = 'video/mp4' AND asset_role = 'render-output' AND rights_status = 'cleared' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(input.projectId)
    .first<{
      id: string;
      object_key: string;
      byte_size: number;
      sha256: string;
    }>();
  if (!asset)
    return { error: '没有通过版权检查的 MP4 成片。', status: 409 as const };
  const accountId =
    input.accountId?.trim() ||
    project.project.distribution.accountId ||
    'default';
  const scheduledAt =
    input.scheduledAt ?? project.project.distribution.scheduledAt ?? null;
  const tags = input.tags ?? project.project.distribution.tags ?? [];
  const coverAssetId =
    input.coverAssetId ?? project.project.distribution.coverAssetId ?? null;
  const coverAsset = coverAssetId
    ? await db
        .prepare(
          "SELECT id, object_key, media_type, byte_size, sha256 FROM assets WHERE id = ? AND project_id = ? AND media_type LIKE 'image/%' AND rights_status = 'cleared'",
        )
        .bind(coverAssetId, input.projectId)
        .first<{
          id: string;
          object_key: string;
          media_type: string;
          byte_size: number;
          sha256: string;
        }>()
    : null;
  if (coverAssetId && !coverAsset)
    return {
      error: '封面资产不存在、不是图片或版权未清除。',
      status: 422 as const,
    };
  const logicalKey = stableHash({
    projectVersion: project.version,
    channel: input.channel,
    accountId,
    scheduledAt,
  });
  const existing = await db
    .prepare(
      'SELECT id, status FROM publish_jobs WHERE channel = ? AND logical_key = ? LIMIT 1',
    )
    .bind(input.channel, logicalKey)
    .first<{ id: string; status: string }>();
  if (existing)
    return {
      publishJob: existing,
      replayed: true as const,
      status: 200 as const,
    };
  if (input.correctionOfId) {
    const corrected = await db
      .prepare(
        "SELECT id FROM publish_jobs WHERE id = ? AND project_id = ? AND status IN ('published', 'withdrawn') LIMIT 1",
      )
      .bind(input.correctionOfId, input.projectId)
      .first();
    if (!corrected)
      return {
        error: 'correctionOfId 必须指向本项目已发布或已撤回的版本。',
        status: 422 as const,
      };
  }
  const publishJobId = `publish_${crypto.randomUUID()}`;
  const workerJobId = `job_${crypto.randomUUID()}`;
  const timestamp = now.toISOString();
  const title = input.title.trim();
  const description = input.description?.trim() ?? '';
  // 作业 payload 是跨进程契约，统一用驼峰：直接塞数据库行会把 object_key/byte_size
  // 这种列名泄进 payload 和发布包清单，Worker 侧读的却是 objectKey。
  const assetPayload = {
    id: asset.id,
    objectKey: asset.object_key,
    byteSize: asset.byte_size,
    sha256: asset.sha256,
  };
  const coverAssetPayload = coverAsset
    ? {
        id: coverAsset.id,
        objectKey: coverAsset.object_key,
        mediaType: coverAsset.media_type,
        byteSize: coverAsset.byte_size,
        sha256: coverAsset.sha256,
      }
    : null;
  const payload = {
    publishJobId,
    projectId: input.projectId,
    operation: 'publish',
    channel: input.channel,
    accountId,
    asset: assetPayload,
    coverAsset: coverAssetPayload,
    title,
    description,
    tags,
    scheduledAt,
    privacyStatus: input.privacyStatus ?? 'private',
    correctionOfId: input.correctionOfId ?? null,
    snapshotHash: project.project.render.snapshotHash,
    sources: project.project.research.claims.flatMap((claim) =>
      claim.evidence.map((evidence) => evidence.url),
    ),
  };
  const trigger = input.trigger ?? 'human';
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO publish_jobs (id, project_id, channel, logical_key, status, account_id, title, description, tags_json, cover_asset_id, scheduled_at, correction_of_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          publishJobId,
          input.projectId,
          input.channel,
          logicalKey,
          accountId,
          title,
          description,
          JSON.stringify(tags),
          coverAssetId,
          scheduledAt,
          input.correctionOfId ?? null,
          timestamp,
          timestamp,
        ),
      db
        .prepare(`
        INSERT INTO jobs
          (id, kind, project_id, automation_policy_id, payload_json, status, idempotency_key, attempt,
           max_attempts, priority, timeout_seconds, estimated_cost_micros, available_at, created_at, updated_at)
        VALUES (?, 'publish', ?, ?, ?, 'queued', ?, 0, 5, 50, 900, 0, ?, ?, ?)
      `)
        .bind(
          workerJobId,
          input.projectId,
          input.policyId ?? null,
          JSON.stringify(payload),
          `publish:${input.channel}:${logicalKey}`,
          scheduledAt ?? timestamp,
          timestamp,
          timestamp,
        ),
      auditStatement(db, {
        projectId: input.projectId,
        actor: input.actor,
        action: 'job.enqueued',
        entityType: 'job',
        entityId: workerJobId,
        afterHash: stableHash(payload),
        metadata: {
          kind: 'publish',
          idempotencyKey: `publish:${input.channel}:${logicalKey}`,
          requestIdempotencyKey: input.requestIdempotencyKey ?? null,
          trigger,
          policyId: input.policyId ?? null,
        },
        now: timestamp,
      }),
      auditStatement(db, {
        projectId: input.projectId,
        actor: input.actor,
        action: 'publish.scheduled',
        entityType: 'publish_job',
        entityId: publishJobId,
        afterHash: stableHash(payload),
        metadata: {
          channel: input.channel,
          accountId,
          scheduledAt,
          coverAssetId,
          correctionOfId: input.correctionOfId ?? null,
          trigger,
          policyId: input.policyId ?? null,
        },
        now: timestamp,
      }),
      ...(trigger === 'human'
        ? [
            pauseAutomationStatement(
              db,
              input.projectId,
              '人工创建了发布任务，自动化已暂停，需显式恢复。',
            ),
          ]
        : []),
    ]);
    return {
      publishJob: {
        id: publishJobId,
        status: 'scheduled',
        channel: input.channel,
      },
      job: { id: workerJobId, status: 'queued', created: true },
      status: 202 as const,
    };
  } catch {
    const replay = await db
      .prepare(
        'SELECT id, status FROM publish_jobs WHERE channel = ? AND logical_key = ? LIMIT 1',
      )
      .bind(input.channel, logicalKey)
      .first<{ id: string; status: string }>();
    if (replay)
      return {
        publishJob: replay,
        replayed: true as const,
        status: 200 as const,
      };
    return { error: '发布任务入队失败。', status: 503 as const };
  }
}
