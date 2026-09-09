import type { SqlDatabase } from './sql.ts';

/**
 * Worker 在线状态与队列积压。
 *
 * 界面点「生成配音」只是入队，真正执行的是 Render Worker。没有这张表时，
 * 「没人执行」和「正在排队」在界面上长得一模一样——用户只能干等。
 * Worker 空闲轮询时也上报心跳，因此「有没有人会执行这类作业」是可判定的。
 */

/** 超过这个时长没有心跳就算离线。Worker 每 15 秒上报一次，留足三次的余量。 */
export const WORKER_ONLINE_WINDOW_SECONDS = 90;
/** 超过这个时长没有心跳的行由编排引擎删除，避免历史 Worker 无限堆积。 */
export const WORKER_RETENTION_DAYS = 7;
/** 入队后超过这个时长仍没有能处理它的在线 Worker，就告警。 */
export const ORPHAN_JOB_SECONDS = 60;

export type WorkerRecord = {
  id: string;
  hostname: string;
  kinds: string[];
  capabilities: string[];
  capabilityProtocolVersions: Record<string, number>;
  version: string;
  lastHeartbeatAt: string;
  online: boolean;
};

function parseKinds(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseCapabilityProtocolVersions(
  value: string,
  capabilities: string[],
) {
  try {
    const parsed: unknown = JSON.parse(value);
    const source =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      capabilities.map((capability) => {
        const version = source[capability];
        return [
          capability,
          Number.isInteger(version) && Number(version) >= 1
            ? Number(version)
            : 1,
        ];
      }),
    );
  } catch {
    return Object.fromEntries(capabilities.map((capability) => [capability, 1]));
  }
}

export async function recordWorkerHeartbeat(
  db: SqlDatabase,
  input: {
    id: string;
    hostname?: string;
    kinds: string[];
    capabilities?: string[];
    capabilityProtocolVersions?: Record<string, number>;
    version?: string;
  },
  now = new Date(),
) {
  const timestamp = now.toISOString();
  await db
    .prepare(`
      INSERT INTO workers (id, hostname, kinds_json, capabilities_json, capability_protocol_versions_json, version, last_heartbeat_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        hostname = excluded.hostname, kinds_json = excluded.kinds_json,
        capabilities_json = excluded.capabilities_json,
        capability_protocol_versions_json = excluded.capability_protocol_versions_json,
        version = excluded.version, last_heartbeat_at = excluded.last_heartbeat_at
    `)
    .bind(
      input.id,
      input.hostname ?? '',
      JSON.stringify(input.kinds),
      JSON.stringify(input.capabilities ?? []),
      JSON.stringify(
        Object.fromEntries(
          (input.capabilities ?? []).map((capability) => [
            capability,
            input.capabilityProtocolVersions?.[capability] ?? 1,
          ]),
        ),
      ),
      input.version ?? '',
      timestamp,
      timestamp,
    )
    .run();
  return { id: input.id, lastHeartbeatAt: timestamp };
}

export async function listWorkers(db: SqlDatabase, now = new Date()): Promise<WorkerRecord[]> {
  const threshold = new Date(now.valueOf() - WORKER_ONLINE_WINDOW_SECONDS * 1000).toISOString();
  const result = await db
    .prepare('SELECT id, hostname, kinds_json, capabilities_json, capability_protocol_versions_json, version, last_heartbeat_at FROM workers ORDER BY last_heartbeat_at DESC LIMIT 200')
    .all<{ id: string; hostname: string; kinds_json: string; capabilities_json: string; capability_protocol_versions_json: string; version: string; last_heartbeat_at: string }>();
  return result.results.map((row) => {
    const capabilities = parseKinds(row.capabilities_json);
    return {
      id: row.id,
      hostname: row.hostname,
      kinds: parseKinds(row.kinds_json),
      capabilities,
      capabilityProtocolVersions: parseCapabilityProtocolVersions(
        row.capability_protocol_versions_json,
        capabilities,
      ),
      version: row.version,
      lastHeartbeatAt: row.last_heartbeat_at,
      online: row.last_heartbeat_at >= threshold,
    };
  });
}

export async function pruneStaleWorkers(db: SqlDatabase, now = new Date(), retentionDays = WORKER_RETENTION_DAYS) {
  const cutoff = new Date(now.valueOf() - retentionDays * 86_400_000).toISOString();
  const deleted = await db.prepare('DELETE FROM workers WHERE last_heartbeat_at < ?').bind(cutoff).run();
  return { deleted: Number(deleted.meta.changes ?? 0) };
}

/** 各类型作业的排队积压（含正在执行的租约）。 */
export async function queueBacklog(db: SqlDatabase) {
  const result = await db
    .prepare(`
      SELECT kind,
        SUM(CASE WHEN status IN ('queued', 'retrying') THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter
      FROM jobs GROUP BY kind ORDER BY kind
    `)
    .all<{ kind: string; waiting: number | null; leased: number | null; dead_letter: number | null }>();
  return result.results.map((row) => ({
    kind: row.kind,
    waiting: Number(row.waiting ?? 0),
    leased: Number(row.leased ?? 0),
    deadLetter: Number(row.dead_letter ?? 0),
  }));
}

/**
 * 找出「已经入队超过 60 秒、但没有任何在线 Worker 声明能处理这个类型」的作业。
 * 传 projectId 就只看该项目，供项目页顶部告警使用。
 */
export async function orphanedJobs(db: SqlDatabase, options: { projectId?: string } = {}, now = new Date()) {
  const workers = await listWorkers(db, now);
  const online = workers.filter((worker) => worker.online);
  const cutoff = new Date(now.valueOf() - ORPHAN_JOB_SECONDS * 1000).toISOString();
  const rows = await db
    .prepare(`
      SELECT id, kind, project_id, required_capability,
        required_capability_protocol_version, created_at FROM jobs
      WHERE status IN ('queued', 'retrying') AND created_at <= ?
        AND (? = '' OR project_id = ?)
      ORDER BY created_at ASC LIMIT 100
    `)
    .bind(cutoff, options.projectId ?? '', options.projectId ?? '')
    .all<{ id: string; kind: string; project_id: string | null; required_capability: string; required_capability_protocol_version: number; created_at: string }>();
  return rows.results
    .filter(
      (row) =>
        !online.some(
          (worker) =>
            worker.kinds.includes(row.kind) &&
            (!row.required_capability ||
              (worker.capabilities.includes(row.required_capability) &&
                (worker.capabilityProtocolVersions[
                  row.required_capability
                ] ?? 0) >= row.required_capability_protocol_version)),
        ),
    )
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      requiredCapability: row.required_capability || null,
      requiredCapabilityProtocolVersion:
        row.required_capability_protocol_version,
      projectId: row.project_id,
      createdAt: row.created_at,
    }));
}
