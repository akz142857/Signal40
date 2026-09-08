import { computeRenderSnapshotHash, validateProjectV2, type VideoProjectV2 } from './project-v2';
import type { ContentState, GateResult, Role } from './workflow';
import { assertTransition, stableHash, WorkflowError } from './workflow';

export type Actor = { id: string; email: string; role: Role };

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
  createdAt: string;
  updatedAt: string;
};

function parseProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    topicId: row.topic_id,
    title: row.title,
    state: row.state,
    version: row.version,
    ownerId: row.owner_id,
    brand: row.brand,
    locale: row.locale,
    project: JSON.parse(row.project_json) as VideoProjectV2,
    immutableHash: row.immutable_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function auditStatement(
  db: D1Database,
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
    projectGuard?: {
      projectId: string;
      version: number;
      updatedAt: string;
      state?: ContentState;
      immutableHash?: string;
    };
  },
) {
  const guardClauses = ['id = ?', 'version = ?', 'updated_at = ?'];
  const guardBindings: unknown[] = input.projectGuard
    ? [input.projectGuard.projectId, input.projectGuard.version, input.projectGuard.updatedAt]
    : [];
  if (input.projectGuard?.state) {
    guardClauses.push('state = ?');
    guardBindings.push(input.projectGuard.state);
  }
  if (input.projectGuard?.immutableHash) {
    guardClauses.push('immutable_hash = ?');
    guardBindings.push(input.projectGuard.immutableHash);
  }
  const guardSql = input.projectGuard
    ? ` WHERE EXISTS (SELECT 1 FROM content_projects WHERE ${guardClauses.join(' AND ')})`
    : '';
  return db
    .prepare(`
      INSERT INTO audit_events
        (id, project_id, actor_id, actor_role, action, entity_type, entity_id,
         before_hash, after_hash, metadata_json, request_id, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${guardSql}
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
      ...guardBindings,
    );
}

export async function createContentProject(
  db: D1Database,
  project: VideoProjectV2,
  actor: Actor,
  now = new Date(),
) {
  const id = project.identity.projectId;
  const existing = await loadContentProject(db, id);
  if (existing) return { project: existing, created: false };
  const createdAt = now.toISOString();
  const hash = stableHash(project);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(`
        INSERT INTO content_projects
          (id, topic_id, title, state, version, owner_id, brand, locale, project_json,
           immutable_hash, created_at, updated_at)
        VALUES (?, ?, ?, 'DRAFT', 1, ?, ?, ?, ?, ?, ?, ?)
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
        .bind(`${id}_${claim.id}`, id, claim.id, claim.text, claim.kind, claim.quantity ? JSON.stringify(claim.quantity) : null, createdAt, createdAt),
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
      .bind(`script_${crypto.randomUUID()}`, id, JSON.stringify(project.script), stableHash(project.script), actor.id, createdAt),
    db
      .prepare(`
        INSERT INTO storyboard_versions
          (id, project_id, version, storyboard_json, content_hash, created_by, created_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
      `)
      .bind(`storyboard_${crypto.randomUUID()}`, id, JSON.stringify(project.timeline), stableHash(project.timeline), actor.id, createdAt),
    auditStatement(db, {
      projectId: id,
      actor,
      action: 'project.created',
      entityType: 'content_project',
      entityId: id,
      afterHash: hash,
      metadata: { schemaVersion: '2.0', topicId: project.identity.topicId },
      now: createdAt,
    }),
  );
  await db.batch(statements);
  return { project: (await loadContentProject(db, id))!, created: true };
}

export async function listContentProjects(db: D1Database) {
  const result = await db
    .prepare(`
      SELECT id, topic_id, title, state, version, owner_id, brand, locale, project_json,
             immutable_hash, created_at, updated_at
      FROM content_projects ORDER BY updated_at DESC LIMIT 100
    `)
    .all<ProjectRow>();
  return result.results.map(parseProject);
}

export async function loadContentProject(db: D1Database, id: string) {
  const row = await db
    .prepare(`
      SELECT id, topic_id, title, state, version, owner_id, brand, locale, project_json,
             immutable_hash, created_at, updated_at
      FROM content_projects WHERE id = ? LIMIT 1
    `)
    .bind(id)
    .first<ProjectRow>();
  return row ? parseProject(row) : null;
}

export async function transitionContentProject(
  db: D1Database,
  input: {
    projectId: string;
    expectedVersion: number;
    to: ContentState;
    gates: GateResult[];
    note: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  if (project.version !== input.expectedVersion) {
    return { error: `版本冲突：当前版本为 ${project.version}。`, status: 409 as const, project };
  }
  assertTransition({ from: project.state, to: input.to, role: input.actor.role, gates: input.gates });
  const updatedAt = now.toISOString();
  const [result] = await db.batch([
    db
      .prepare(`
        UPDATE content_projects SET state = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `)
      .bind(input.to, updatedAt, input.projectId, input.expectedVersion),
    auditStatement(db, {
      projectId: input.projectId,
      actor: input.actor,
      action: 'project.transitioned',
      entityType: 'content_project',
      entityId: input.projectId,
      beforeHash: stableHash({ state: project.state, version: project.version }),
      afterHash: stableHash({ state: input.to, version: project.version + 1 }),
      metadata: { from: project.state, to: input.to, gates: input.gates, note: input.note },
      now: updatedAt,
      projectGuard: {
        projectId: input.projectId,
        version: input.expectedVersion + 1,
        updatedAt,
        state: input.to,
      },
    }),
  ]);
  if (!result.meta.changes) throw new WorkflowError('项目已被其他用户修改。', 'VERSION_CONFLICT');
  return { project: (await loadContentProject(db, input.projectId))!, status: 200 as const };
}

export async function saveProjectSection(
  db: D1Database,
  input: {
    projectId: string;
    expectedVersion: number;
    section: 'script' | 'storyboard';
    value: VideoProjectV2['script'] | VideoProjectV2['timeline'];
    actor: Actor;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  if (project.version !== input.expectedVersion) return { error: `版本冲突：当前版本为 ${project.version}。`, status: 409 as const, project };
  const editorRoles = input.section === 'script' ? ['editor', 'admin'] : ['producer', 'admin'];
  if (!editorRoles.includes(input.actor.role)) return { error: `当前角色无权编辑 ${input.section}。`, status: 403 as const };
  const allowedStates = input.section === 'script'
    ? ['SCRIPT_DRAFT', 'CHANGES_REQUESTED']
    : ['SCRIPT_APPROVED', 'CHANGES_REQUESTED'];
  if (!allowedStates.includes(project.state)) return { error: `${input.section} 不能在 ${project.state} 状态编辑，请先按流程推进。`, status: 409 as const };
  const nextProject = structuredClone(project.project);
  if (input.section === 'script') {
    const script = input.value as VideoProjectV2['script'];
    if (!script.title.trim() || !script.lines.length || script.lines.some((line) => !line.text.trim())) return { error: '脚本标题和每一行内容不能为空。', status: 422 as const };
    const changedLockedLine = project.project.script.lines.find((line) => line.locked && (() => {
      const replacement = script.lines.find((candidate) => candidate.id === line.id);
      return !replacement || replacement.text !== line.text || JSON.stringify(replacement.claimIds) !== JSON.stringify(line.claimIds);
    })());
    if (changedLockedLine) return { error: `脚本行 ${changedLockedLine.id} 已锁定，需先解除锁定再修改。`, status: 409 as const };
    const claimIds = new Set(nextProject.research.claims.map((claim) => claim.id));
    if (script.lines.some((line) => line.claimIds.some((id) => !claimIds.has(id)))) return { error: '脚本引用了不存在的声明。', status: 422 as const };
    nextProject.script = { ...script, version: project.project.script.version + 1, humanModifiedBy: input.actor.id, humanModifiedAt: now.toISOString() };
  } else {
    const timeline = input.value as VideoProjectV2['timeline'];
    if (!timeline.length || timeline.some((scene) => scene.durationFrames < 1)) return { error: '分镜不能为空且时长必须为正数。', status: 422 as const };
    let cursor = 0;
    nextProject.timeline = timeline.map((scene) => {
      const next = { ...scene, startFrame: cursor };
      cursor += scene.durationFrames;
      return next;
    });
    if (cursor !== nextProject.render.durationSeconds * nextProject.render.fps) return { error: `分镜总帧数必须为 ${nextProject.render.durationSeconds * nextProject.render.fps}。`, status: 422 as const };
  }
  const immutableHash = computeRenderSnapshotHash(nextProject);
  nextProject.render.snapshotHash = immutableHash;
  nextProject.provenance.immutableInputsHash = immutableHash;
  const validation = validateProjectV2(nextProject);
  if (!validation.valid) return { error: `项目协议校验失败：${validation.errors.join('；')}`, status: 422 as const };
  const timestamp = now.toISOString();
  const nextState: ContentState = input.section === 'script' ? 'SCRIPT_DRAFT' : 'SCRIPT_APPROVED';
  const sectionValue = input.section === 'script' ? nextProject.script : nextProject.timeline;
  const sectionVersion = input.section === 'script'
    ? nextProject.script.version
    : Number((await db.prepare('SELECT MAX(version) AS version FROM storyboard_versions WHERE project_id = ?').bind(input.projectId).first<{ version: number | null }>())?.version ?? 0) + 1;
  const table = input.section === 'script' ? 'script_versions' : 'storyboard_versions';
  const jsonColumn = input.section === 'script' ? 'script_json' : 'storyboard_json';
  const nextProjectHash = stableHash(nextProject);
  const [updated] = await db.batch([
    db.prepare(`UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).bind(JSON.stringify(nextProject), nextProjectHash, nextState, timestamp, input.projectId, input.expectedVersion),
    db.prepare(`
      INSERT INTO ${table} (id, project_id, version, ${jsonColumn}, content_hash, created_by, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM content_projects
        WHERE id = ? AND version = ? AND updated_at = ? AND state = ? AND immutable_hash = ?
      )
    `).bind(
      `${input.section}_${crypto.randomUUID()}`,
      input.projectId,
      sectionVersion,
      JSON.stringify(sectionValue),
      stableHash(sectionValue),
      input.actor.id,
      timestamp,
      input.projectId,
      input.expectedVersion + 1,
      timestamp,
      nextState,
      nextProjectHash,
    ),
    auditStatement(db, {
      projectId: input.projectId,
      actor: input.actor,
      action: `${input.section}.version_created`,
      entityType: input.section,
      entityId: input.projectId,
      beforeHash: project.immutableHash,
      afterHash: immutableHash,
      metadata: { version: sectionVersion, approvalsInvalidated: true },
      now: timestamp,
      projectGuard: {
        projectId: input.projectId,
        version: input.expectedVersion + 1,
        updatedAt: timestamp,
        state: nextState,
        immutableHash: nextProjectHash,
      },
    }),
  ]);
  if (!updated.meta.changes) throw new WorkflowError('项目已被其他用户修改。', 'VERSION_CONFLICT');
  return { project: (await loadContentProject(db, input.projectId))!, status: 200 as const };
}

export async function saveResearchSnapshot(
  db: D1Database,
  input: {
    projectId: string;
    expectedVersion: number;
    research: VideoProjectV2['research'];
    actor: Actor;
  },
  now = new Date(),
) {
  const project = await loadContentProject(db, input.projectId);
  if (!project) return { error: '项目不存在。', status: 404 as const };
  if (project.version !== input.expectedVersion) return { error: `版本冲突：当前版本为 ${project.version}。`, status: 409 as const, project };
  if (!['researcher', 'editor', 'admin'].includes(input.actor.role)) return { error: '当前角色无权编辑研究快照。', status: 403 as const };
  if (!['RESEARCHING', 'CHANGES_REQUESTED'].includes(project.state)) return { error: `研究快照不能在 ${project.state} 状态编辑。`, status: 409 as const };
  const claims = input.research.claims;
  if (!claims.length || claims.length > 50) return { error: '研究快照必须包含 1–50 条声明。', status: 422 as const };
  const ids = new Set<string>();
  for (const claim of claims) {
    if (!claim.id.trim() || ids.has(claim.id) || !claim.text.trim() || claim.text.length > 2000) return { error: '声明 ID 必须唯一，文本不能为空且最多 2000 字。', status: 422 as const };
    ids.add(claim.id);
    if (claim.evidence.length > 30) return { error: `${claim.id} 的证据不能超过 30 条。`, status: 422 as const };
    for (const evidence of claim.evidence) {
      try { const url = new URL(evidence.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
      catch { return { error: `${claim.id} 包含无效证据 URL。`, status: 422 as const }; }
      if (!evidence.quote.trim() || evidence.quote.length > 4000 || Number.isNaN(new Date(evidence.observedAt).valueOf())) return { error: `${claim.id} 的证据摘录或观察时间无效。`, status: 422 as const };
      if (!evidence.locator?.type || !evidence.locator.value?.trim()) return { error: `${claim.id} 的证据必须包含页码、段落、表格、时间码、章节或 URL 定位。`, status: 422 as const };
    }
    if (claim.kind === 'numeric' && (!claim.quantity || !claim.quantity.unit.trim() || !claim.quantity.timeRange.trim() || !claim.quantity.basis.trim() || !claim.quantity.entity.trim())) return { error: `${claim.id} 的数字声明缺少单位、统计周期、比较基准或主体。`, status: 422 as const };
  }
  if (input.research.conflicts.some((conflict) => !ids.has(conflict.claimId) || !conflict.description.trim())) return { error: '冲突必须引用现有声明并提供描述。', status: 422 as const };
  const conflicts = [...input.research.conflicts];
  for (const claim of claims) {
    if (claim.evidence.some((evidence) => evidence.stance === 'refutes') && !conflicts.some((conflict) => conflict.claimId === claim.id)) {
      conflicts.push({ claimId: claim.id, description: '存在反驳证据，需要编辑说明取舍依据。', resolution: null });
    }
  }
  const core = { claims, conflicts };
  if (stableHash(core) === project.project.research.approvedHash) return { error: '研究内容没有变化。', status: 409 as const, project };
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
  if (!validation.valid) return { error: `项目协议校验失败：${validation.errors.join('；')}`, status: 422 as const };
  const timestamp = now.toISOString();
  const nextVersion = Number((await db.prepare('SELECT MAX(version) AS version FROM research_snapshots WHERE project_id = ?').bind(input.projectId).first<{ version: number | null }>())?.version ?? 0) + 1;
  const nextProjectHash = stableHash(nextProject);
  const projectGuardSql = `EXISTS (
    SELECT 1 FROM content_projects
    WHERE id = ? AND version = ? AND updated_at = ? AND state = 'RESEARCHING' AND immutable_hash = ?
  )`;
  const projectGuardBindings = [input.projectId, input.expectedVersion + 1, timestamp, nextProjectHash] as const;
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE content_projects SET project_json = ?, immutable_hash = ?, state = 'RESEARCHING', version = version + 1, updated_at = ? WHERE id = ? AND version = ?").bind(JSON.stringify(nextProject), nextProjectHash, timestamp, input.projectId, input.expectedVersion),
    db.prepare(`DELETE FROM evidence_links WHERE claim_id IN (SELECT id FROM claims WHERE project_id = ?) AND ${projectGuardSql}`).bind(input.projectId, ...projectGuardBindings),
    db.prepare(`DELETE FROM claims WHERE project_id = ? AND ${projectGuardSql}`).bind(input.projectId, ...projectGuardBindings),
    db.prepare(`
      INSERT INTO research_snapshots (id, project_id, version, snapshot_json, snapshot_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE ${projectGuardSql}
    `).bind(research.snapshotId, input.projectId, nextVersion, JSON.stringify(research), research.approvedHash, timestamp, ...projectGuardBindings),
  ];
  for (const claim of claims) {
    const databaseClaimId = `${input.projectId}_${claim.id}`;
    const hasRefutation = claim.evidence.some((evidence) => evidence.stance === 'refutes');
    const conflict = research.conflicts.find((item) => item.claimId === claim.id);
    const verifiable = !['opinion', 'disclaimer'].includes(claim.kind);
    const status = hasRefutation && !conflict?.resolution ? 'conflicted' : verifiable && claim.evidence.some((evidence) => evidence.stance === 'supports') ? 'supported' : 'draft';
    statements.push(db.prepare(`
      INSERT INTO claims (id, project_id, logical_id, text, kind, quantity_json, status, version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ? WHERE ${projectGuardSql}
    `).bind(databaseClaimId, input.projectId, claim.id, claim.text.trim(), claim.kind, claim.quantity ? JSON.stringify(claim.quantity) : null, status, timestamp, timestamp, ...projectGuardBindings));
    for (const evidence of claim.evidence) {
      statements.push(db.prepare(`
        INSERT INTO evidence_links (id, claim_id, article_id, article_revision_id, source_url, stance, excerpt, locator_json, source_hash, observed_at, created_at)
        SELECT ?, ?, (SELECT id FROM articles WHERE id = ? LIMIT 1), (SELECT id FROM article_revisions WHERE id = ? LIMIT 1), ?, ?, ?, ?, ?, ?, ? WHERE ${projectGuardSql}
      `).bind(`evidence_${crypto.randomUUID()}`, databaseClaimId, evidence.sourceId, evidence.articleRevisionId, evidence.url, evidence.stance, evidence.quote.trim(), JSON.stringify(evidence.locator), stableHash(evidence), evidence.observedAt, timestamp, ...projectGuardBindings));
    }
  }
  statements.push(auditStatement(db, {
    projectId: input.projectId,
    actor: input.actor,
    action: 'research.version_created',
    entityType: 'research',
    entityId: research.snapshotId,
    beforeHash: project.project.research.approvedHash,
    afterHash: research.approvedHash,
    metadata: { version: nextVersion, approvalsInvalidated: true },
    now: timestamp,
    projectGuard: {
      projectId: input.projectId,
      version: input.expectedVersion + 1,
      updatedAt: timestamp,
      state: 'RESEARCHING',
      immutableHash: nextProjectHash,
    },
  }));
  const [updated] = await db.batch(statements);
  if (!updated.meta.changes) throw new WorkflowError('项目已被其他用户修改。', 'VERSION_CONFLICT');
  return { project: (await loadContentProject(db, input.projectId))!, status: 200 as const };
}

export async function listProjectAudit(db: D1Database, projectId: string) {
  const result = await db
    .prepare(`
      SELECT id, actor_id, actor_role, action, entity_type, entity_id, before_hash,
             after_hash, metadata_json, request_id, created_at
      FROM audit_events WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200
    `)
    .bind(projectId)
    .all();
  return result.results.map((row) => ({
    ...row,
    metadata: JSON.parse(typeof row.metadata_json === 'string' ? row.metadata_json : '{}'),
    metadata_json: undefined,
  }));
}

export async function evaluateProjectGates(db: D1Database, projectId: string): Promise<GateResult[]> {
  const project = await loadContentProject(db, projectId);
  if (!project) return [];
  const [evidence, assetsResult, approvalsResult, qc, metrics] = await Promise.all([
    db.prepare(`
      SELECT c.logical_id AS id, c.kind,
        SUM(CASE WHEN e.stance = 'supports' THEN 1 ELSE 0 END) AS supports,
        SUM(CASE WHEN e.stance = 'refutes' THEN 1 ELSE 0 END) AS refutes
      FROM claims c LEFT JOIN evidence_links e ON e.claim_id = c.id
      WHERE c.project_id = ? GROUP BY c.id, c.kind
    `).bind(projectId).all<{ id: string; kind: string; supports: number; refutes: number }>(),
    db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN rights_status != 'cleared' THEN 1 ELSE 0 END) AS uncleared FROM assets WHERE project_id = ?`).bind(projectId).first<{ total: number; uncleared: number | null }>(),
    db.prepare(`SELECT kind, decision, subject_hash, actor_id, created_at FROM approvals WHERE project_id = ? ORDER BY created_at DESC, rowid DESC`).bind(projectId).all<{ kind: string; decision: string; subject_hash: string; actor_id: string; created_at: string }>(),
    db.prepare(`SELECT status FROM qc_reports WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(projectId).first<{ status: string }>(),
    db.prepare('SELECT COUNT(*) AS total FROM metric_snapshots WHERE project_id = ?').bind(projectId).first<{ total: number }>(),
  ]);
  const latestApproval = new Map<string, (typeof approvalsResult.results)[number]>();
  for (const approval of approvalsResult.results) if (!latestApproval.has(approval.kind)) latestApproval.set(approval.kind, approval);
  const allEvidenceUrlsValid = project.project.research.claims.every((claim) => claim.evidence.every((item) => /^https?:\/\//.test(item.url)));
  const distinctSources = new Set(project.project.research.claims.flatMap((claim) => claim.evidence.map((item) => item.sourceId))).size;
  const factualClaims = evidence.results.filter((claim) => !['opinion', 'disclaimer'].includes(claim.kind));
  const unsupported = factualClaims.filter((claim) => Number(claim.supports) < 1);
  const resolvedConflictIds = new Set(project.project.research.conflicts.filter((conflict) => conflict.resolution?.trim()).map((conflict) => conflict.claimId));
  const conflicts = factualClaims.filter((claim) => Number(claim.refutes) > 0 && !resolvedConflictIds.has(claim.id));
  const scriptClaimIds = new Set(project.project.script.lines.flatMap((line) => line.claimIds));
  const uncovered = project.project.research.claims.filter((claim) => !['opinion', 'disclaimer'].includes(claim.kind) && !scriptClaimIds.has(claim.id));
  const researchApproval = latestApproval.get('research');
  const scriptApproval = latestApproval.get('script');
  const qcApproval = latestApproval.get('qc');
  const publishApproval = latestApproval.get('publish');
  const targetDurationMs = project.project.render.durationSeconds * 1_000;
  const audioDurationMs = project.project.audio.durationMs ?? 0;
  const audioDurationRatio = targetDurationMs > 0 ? audioDurationMs / targetDurationMs : 0;
  const captionEndMs = Math.max(0, ...project.project.captions.map((caption) => caption.endMs));
  const audioReady = Boolean(project.project.audio.objectKey)
    && /^([a-f0-9]{64}|sha256:[a-f0-9]{64})$/.test(project.project.audio.sha256 ?? '')
    && audioDurationRatio >= 0.6
    && audioDurationRatio <= 1.1
    && project.project.captions.length > 0
    && captionEndMs >= audioDurationMs - 1_000;
  return [
    { code: 'G0_SOURCE_RIGHTS', passed: allEvidenceUrlsValid && distinctSources >= 2, reasons: allEvidenceUrlsValid && distinctSources >= 2 ? [] : ['来源 URL 无效或独立来源少于 2 个'] },
    { code: 'G1_INPUT_QUALITY', passed: Boolean(project.title && project.project.identity.locale), reasons: project.title && project.project.identity.locale ? [] : ['项目标题或语言缺失'] },
    { code: 'G2_AUTO_EVIDENCE', passed: factualClaims.length > 0 && unsupported.length === 0 && conflicts.length === 0, reasons: [...unsupported.map((claim) => `${claim.id} 缺少支持证据`), ...conflicts.map((claim) => `${claim.id} 存在未解决反驳证据`)] },
    { code: 'G3_MANUAL_RESEARCH', passed: researchApproval?.decision === 'approved' && researchApproval.subject_hash === project.project.research.approvedHash, reasons: researchApproval?.decision === 'approved' && researchApproval.subject_hash === project.project.research.approvedHash ? [] : ['研究快照尚未由编辑批准或批准哈希已过期'] },
    { code: 'G4_SCRIPT_COVERAGE', passed: uncovered.length === 0 && scriptApproval?.decision === 'approved' && scriptApproval.subject_hash === stableHash(project.project.script), reasons: [...uncovered.map((claim) => `${claim.id} 未被脚本覆盖`), ...(scriptApproval?.decision === 'approved' && scriptApproval.subject_hash === stableHash(project.project.script) ? [] : ['当前脚本版本尚未批准'])] },
    { code: 'G5_ASSET_RIGHTS', passed: audioReady && Number(assetsResult?.uncleared ?? 0) === 0, reasons: [...(audioReady ? [] : ['配音、哈希、字幕或实际时长未达到成片时长的 60%–110%']), ...(Number(assetsResult?.uncleared ?? 0) === 0 ? [] : [`${assetsResult?.uncleared} 个资产版权未清除`])] },
    { code: 'G6_CONTENT_TECH_QC', passed: qc?.status === 'passed' && qcApproval?.decision === 'approved' && qcApproval.subject_hash === project.immutableHash, reasons: qc?.status === 'passed' && qcApproval?.decision === 'approved' && qcApproval.subject_hash === project.immutableHash ? [] : ['自动 QC 或当前成片的人工终审未通过'] },
    { code: 'G7_PUBLISH_APPROVAL', passed: publishApproval?.decision === 'approved' && publishApproval.subject_hash === project.immutableHash && publishApproval.actor_id !== researchApproval?.actor_id, reasons: publishApproval?.decision === 'approved' && publishApproval.subject_hash === project.immutableHash && publishApproval.actor_id !== researchApproval?.actor_id ? [] : ['当前成片尚未由独立发布人批准'] },
    { code: 'G8_POST_PUBLISH', passed: Number(metrics?.total ?? 0) > 0, reasons: Number(metrics?.total ?? 0) > 0 ? [] : ['尚无发布后指标快照'] },
  ];
}

export async function recordApproval(
  db: D1Database,
  input: {
    projectId: string;
    kind: 'research' | 'script' | 'qc' | 'publish';
    decision: 'approved' | 'changes_requested' | 'rejected';
    subjectHash: string;
    note: string;
    actor: Actor;
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
  if (!roles[input.kind].includes(input.actor.role)) return { error: `角色 ${input.actor.role} 无权执行 ${input.kind} 批准。`, status: 403 as const };
  const expectedHash = input.kind === 'research'
    ? project.project.research.approvedHash
    : input.kind === 'script'
      ? stableHash(project.project.script)
      : project.immutableHash;
  if (input.subjectHash !== expectedHash)
    return { error: '批准对象哈希已过期，请刷新后重试。', status: 409 as const };
  const timestamp = now.toISOString();
  const id = `approval_${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`
      INSERT INTO approvals (id, project_id, kind, decision, subject_hash, actor_id, actor_role, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, input.projectId, input.kind, input.decision, input.subjectHash, input.actor.id, input.actor.role, input.note, timestamp),
    auditStatement(db, {
      projectId: input.projectId,
      actor: input.actor,
      action: `approval.${input.decision}`,
      entityType: input.kind,
      entityId: input.projectId,
      afterHash: input.subjectHash,
      metadata: { kind: input.kind, note: input.note },
      now: timestamp,
    }),
  ]);
  return { approval: { id, ...input, actor: undefined }, status: 201 as const };
}

export async function enqueueJob(
  db: D1Database,
  input: {
    kind: 'ingestion' | 'voice' | 'preview' | 'render' | 'qc' | 'publish' | 'metrics';
    projectId?: string | null;
    payload: unknown;
    idempotencyKey: string;
    maxAttempts?: number;
    priority?: number;
    timeoutSeconds?: number;
    estimatedCostMicros?: number;
    availableAt?: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const existing = await db
    .prepare('SELECT id, status FROM jobs WHERE kind = ? AND idempotency_key = ? LIMIT 1')
    .bind(input.kind, input.idempotencyKey)
    .first<{ id: string; status: string }>();
  if (existing) return { ...existing, created: false };
  const id = `job_${crypto.randomUUID()}`;
  const timestamp = now.toISOString();
  const availableAt = input.availableAt && !Number.isNaN(new Date(input.availableAt).valueOf()) ? input.availableAt : timestamp;
  await db.batch([
    db
      .prepare(`
        INSERT INTO jobs
          (id, kind, project_id, payload_json, status, idempotency_key, attempt,
           max_attempts, priority, timeout_seconds, estimated_cost_micros, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(id, input.kind, input.projectId ?? null, JSON.stringify(input.payload), input.idempotencyKey, input.maxAttempts ?? 5, input.priority ?? 50, input.timeoutSeconds ?? 900, input.estimatedCostMicros ?? 0, availableAt, timestamp, timestamp),
    auditStatement(db, {
      projectId: input.projectId,
      actor: input.actor,
      action: 'job.enqueued',
      entityType: 'job',
      entityId: id,
      afterHash: stableHash(input.payload),
      metadata: { kind: input.kind, idempotencyKey: input.idempotencyKey },
      now: timestamp,
    }),
  ]);
  return { id, status: 'queued', created: true };
}

export async function enqueueIngestionRun(
  db: D1Database,
  input: {
    sourceConfigId: string;
    checkpoint?: string | null;
    idempotencyKey: string;
    actor: Actor;
  },
  now = new Date(),
) {
  const existing = await db
    .prepare("SELECT j.id, j.status, ir.id AS ingestion_run_id FROM jobs j LEFT JOIN ingestion_runs ir ON ir.job_id = j.id WHERE j.kind = 'ingestion' AND j.idempotency_key = ? LIMIT 1")
    .bind(input.idempotencyKey)
    .first<{ id: string; status: string; ingestion_run_id: string | null }>();
  if (existing) return { id: existing.id, status: existing.status, ingestionRunId: existing.ingestion_run_id, created: false };
  const id = `job_${crypto.randomUUID()}`;
  const ingestionRunId = `ingestion_${crypto.randomUUID()}`;
  const timestamp = now.toISOString();
  const payload = { sourceConfigId: input.sourceConfigId, ingestionRunId, checkpoint: input.checkpoint ?? null };
  await db.batch([
    db.prepare(`
      INSERT INTO jobs (id, kind, payload_json, status, idempotency_key, attempt, max_attempts, available_at, created_at, updated_at)
      VALUES (?, 'ingestion', ?, 'queued', ?, 0, 5, ?, ?, ?)
    `).bind(id, JSON.stringify(payload), input.idempotencyKey, timestamp, timestamp, timestamp),
    db.prepare(`
      INSERT INTO ingestion_runs (id, source_config_id, job_id, status, checkpoint_before, created_at)
      VALUES (?, ?, ?, 'queued', ?, ?)
    `).bind(ingestionRunId, input.sourceConfigId, id, input.checkpoint ?? null, timestamp),
    auditStatement(db, {
      actor: input.actor,
      action: 'job.enqueued',
      entityType: 'job',
      entityId: id,
      afterHash: stableHash(payload),
      metadata: { kind: 'ingestion', idempotencyKey: input.idempotencyKey, ingestionRunId },
      now: timestamp,
    }),
  ]);
  return { id, status: 'queued', ingestionRunId, created: true };
}

export async function leaseNextJob(
  db: D1Database,
  input: { workerId: string; kinds: string[]; leaseSeconds?: number; renderConcurrencyLimit?: number },
  now = new Date(),
) {
  if (!input.kinds.length) return null;
  const placeholders = input.kinds.map(() => '?').join(', ');
  const timestamp = now.toISOString();
  const row = await db
    .prepare(`
      SELECT id, timeout_seconds, kind, project_id, payload_json FROM jobs
      WHERE kind IN (${placeholders})
        AND ((status IN ('queued', 'retrying') AND available_at <= ?)
          OR (status = 'leased' AND lease_expires_at <= ?))
        AND (kind != 'voice' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'SCRIPT_APPROVED'))
        AND (kind != 'preview' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'ASSETS_READY'))
        AND (kind != 'render' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'RENDER_QUEUED'))
        AND (kind != 'publish' OR json_extract(payload_json, '$.operation') = 'withdraw' OR (
          EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'PUBLISH_SCHEDULED')
          AND EXISTS (SELECT 1 FROM publish_jobs pj WHERE pj.id = json_extract(jobs.payload_json, '$.publishJobId') AND pj.status = 'scheduled')
        ))
        AND (kind NOT IN ('preview', 'render') OR (SELECT COUNT(*) FROM jobs active WHERE active.kind IN ('preview', 'render') AND active.status = 'leased' AND active.lease_expires_at > ?) < ?)
      ORDER BY priority DESC, available_at ASC, created_at ASC LIMIT 1
    `)
    .bind(...input.kinds, timestamp, timestamp, timestamp, input.renderConcurrencyLimit ?? 2)
    .first<{ id: string; timeout_seconds: number; kind: string; project_id: string | null; payload_json: string }>();
  if (!row) return null;
  const leaseExpiresAt = new Date(now.valueOf() + Math.min(input.leaseSeconds ?? 300, row.timeout_seconds) * 1000).toISOString();
  const statements: D1PreparedStatement[] = [db
    .prepare(`
      UPDATE jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
        attempt = attempt + 1, updated_at = ?
      WHERE id = ? AND ((status IN ('queued', 'retrying') AND available_at <= ?)
        OR (status = 'leased' AND lease_expires_at <= ?))
        AND (kind != 'preview' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'ASSETS_READY'))
        AND (kind != 'render' OR EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'RENDER_QUEUED'))
        AND (kind != 'publish' OR json_extract(payload_json, '$.operation') = 'withdraw' OR (
          EXISTS (SELECT 1 FROM content_projects cp WHERE cp.id = jobs.project_id AND cp.state = 'PUBLISH_SCHEDULED')
          AND EXISTS (SELECT 1 FROM publish_jobs pj WHERE pj.id = json_extract(jobs.payload_json, '$.publishJobId') AND pj.status = 'scheduled')
        ))
        AND (kind NOT IN ('preview', 'render') OR (SELECT COUNT(*) FROM jobs active WHERE active.id != jobs.id AND active.kind IN ('preview', 'render') AND active.status = 'leased' AND active.lease_expires_at > ?) < ?)
    `)
    .bind(input.workerId, leaseExpiresAt, timestamp, row.id, timestamp, timestamp, timestamp, input.renderConcurrencyLimit ?? 2)];
  if (row.kind === 'render' && row.project_id) {
    statements.push(db.prepare(`
      UPDATE content_projects SET state = 'RENDERING', version = version + 1, updated_at = ?
      WHERE id = ? AND state = 'RENDER_QUEUED'
        AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'leased' AND lease_owner = ?)
    `).bind(timestamp, row.project_id, row.id, input.workerId));
  }
  if (row.kind === 'publish') {
    const payload = JSON.parse(row.payload_json) as { publishJobId?: string; operation?: string };
    if (payload.publishJobId && payload.operation !== 'withdraw') {
      statements.push(db.prepare(`
        UPDATE publish_jobs SET status = 'publishing', updated_at = ?
        WHERE id = ? AND status = 'scheduled'
          AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'leased' AND lease_owner = ?)
      `).bind(timestamp, payload.publishJobId, row.id, input.workerId));
    }
  }
  const [updated] = await db.batch(statements);
  if (!updated.meta.changes) return null;
  const job = await db
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .bind(row.id)
    .first<Record<string, unknown>>();
  return job ? { ...job, payload: JSON.parse(String(job.payload_json)), payload_json: undefined } : null;
}

export async function finishJob(
  db: D1Database,
  input: { id: string; workerId: string; succeeded: boolean; result?: unknown; error?: string; retryDelaySeconds?: number },
  now = new Date(),
) {
  const row = await db
    .prepare('SELECT attempt, max_attempts, kind, payload_json, project_id FROM jobs WHERE id = ? AND status = \'leased\' AND lease_owner = ?')
    .bind(input.id, input.workerId)
    .first<{ attempt: number; max_attempts: number; kind: string; payload_json: string; project_id: string | null }>();
  if (!row) return { error: '作业不存在、未租约或租约不属于该 Worker。', status: 409 as const };
  const timestamp = now.toISOString();
  const status = input.succeeded ? 'succeeded' : row.attempt >= row.max_attempts ? 'dead_letter' : 'retrying';
  const availableAt = new Date(now.valueOf() + (input.retryDelaySeconds ?? Math.min(900, 2 ** row.attempt * 15)) * 1000).toISOString();
  const costMicros = input.result && typeof input.result === 'object' && Number.isInteger((input.result as { costMicros?: unknown }).costMicros)
    ? Math.max(0, Number((input.result as { costMicros: number }).costMicros))
    : 0;
  const resultRecord = input.result && typeof input.result === 'object' ? input.result as Record<string, unknown> : {};
  const resultAsset = resultRecord.asset && typeof resultRecord.asset === 'object' ? resultRecord.asset as Record<string, unknown> : {};
  const outputObjectKey = typeof resultAsset.objectKey === 'string' ? resultAsset.objectKey : typeof resultRecord.outputObjectKey === 'string' ? resultRecord.outputObjectKey : null;
  const logObjectKey = typeof resultRecord.logObjectKey === 'string' ? resultRecord.logObjectKey : null;
  const durationMs = Number.isFinite(resultRecord.durationMs) && Number(resultRecord.durationMs) >= 0 ? Math.round(Number(resultRecord.durationMs)) : null;
  const jobGuardSql = `EXISTS (
    SELECT 1 FROM jobs
    WHERE id = ? AND status = ? AND updated_at = ? AND lease_owner IS NULL
  )`;
  const jobGuardBindings = [input.id, status, timestamp] as const;
  const statements = [db.prepare(`
      UPDATE jobs SET status = ?, result_json = ?, output_object_key = ?, log_object_key = ?, duration_ms = ?, last_error = ?, cost_micros = ?, available_at = ?,
        lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'leased' AND lease_owner = ?
    `)
    .bind(status, input.result === undefined ? null : JSON.stringify(input.result), outputObjectKey, logObjectKey, durationMs, input.error ?? null, costMicros, availableAt, timestamp, input.id, input.workerId)];
  if (row.kind === 'ingestion') {
    const payload = JSON.parse(row.payload_json) as { ingestionRunId?: string; sourceConfigId?: string };
    if (payload.ingestionRunId && !input.succeeded) {
      statements.push(db.prepare(`UPDATE ingestion_runs SET status = ?, error_json = ?, finished_at = ? WHERE id = ? AND ${jobGuardSql}`).bind(
        status === 'dead_letter' ? 'failed' : 'queued',
        JSON.stringify({ message: input.error ?? '采集失败', attempt: row.attempt }),
        status === 'dead_letter' ? timestamp : null,
        payload.ingestionRunId,
        ...jobGuardBindings,
      ));
    }
    if (payload.sourceConfigId && !input.succeeded) {
      statements.push(db.prepare(`UPDATE source_configs SET last_error = ?, updated_at = ? WHERE id = ? AND ${jobGuardSql}`).bind(input.error ?? '采集失败', timestamp, payload.sourceConfigId, ...jobGuardBindings));
    }
  }
  if (row.kind === 'render' && row.project_id) {
    statements.push(db.prepare(`UPDATE content_projects SET state = ?, version = version + 1, updated_at = ? WHERE id = ? AND state = 'RENDERING' AND ${jobGuardSql}`).bind(input.succeeded ? 'QC_PENDING' : status === 'dead_letter' ? 'FAILED' : 'RENDER_QUEUED', timestamp, row.project_id, ...jobGuardBindings));
  }
  if (row.kind === 'publish' && !input.succeeded) {
    const payload = JSON.parse(row.payload_json) as { publishJobId?: string; operation?: string };
    if (payload.publishJobId && payload.operation !== 'withdraw') statements.push(db.prepare(`UPDATE publish_jobs SET status = ?, updated_at = ? WHERE id = ? AND ${jobGuardSql}`).bind(status === 'dead_letter' ? 'failed' : 'scheduled', timestamp, payload.publishJobId, ...jobGuardBindings));
  }
  const [updated] = await db.batch(statements);
  if (!updated.meta.changes) return { error: '作业租约已过期或已由其他 Worker 完成。', status: 409 as const };
  return { id: input.id, status, attempt: row.attempt, maxAttempts: row.max_attempts };
}
