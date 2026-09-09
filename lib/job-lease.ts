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
