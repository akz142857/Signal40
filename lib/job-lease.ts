import type { SqlDatabase } from './sql.ts';

export type LeaseIdentity = {
  status: string;
  lease_owner: string | null;
  lease_epoch: number;
  lease_expires_at: string | null;
};

export function activeLeaseMatches(
  lease: LeaseIdentity,
  expected: { workerId: string; leaseEpoch: number },
  now = new Date(),
) {
  return (
    lease.status === 'leased' &&
    lease.lease_owner === expected.workerId &&
    lease.lease_epoch === expected.leaseEpoch &&
    Boolean(lease.lease_expires_at) &&
    String(lease.lease_expires_at) > now.toISOString()
  );
}

export type ActiveJobLease = LeaseIdentity & {
  id: string;
  kind: string;
  project_id: string | null;
};

/**
 * Worker 的业务副作用必须使用与续约/完成相同的租约身份。
 * 路由先按主键读取，再在内存中统一检查 owner、epoch、到期时间和业务范围，
 * 避免每个端点各自维护一份容易漂移的 SQL 条件。
 */
export async function loadActiveJobLease(
  db: SqlDatabase,
  input: {
    jobId: string;
    workerId: string;
    leaseEpoch: number;
    projectId?: string;
    kinds?: readonly string[];
  },
  now = new Date(),
) {
  const lease = await db
    .prepare(
      'SELECT id, kind, project_id, status, lease_owner, lease_epoch, lease_expires_at FROM jobs WHERE id = ? LIMIT 1',
    )
    .bind(input.jobId)
    .first<ActiveJobLease>();
  if (!lease) return null;
  if (!activeLeaseMatches(lease, input, now)) return null;
  if (input.projectId !== undefined && lease.project_id !== input.projectId) return null;
  if (input.kinds && !input.kinds.includes(lease.kind)) return null;
  return lease;
}
