export const SOURCE_LIFECYCLE_STATUSES = [
  'draft',
  'connecting',
  'tested',
  'enabled',
  'degraded',
  'paused',
  'archived',
] as const;

export type SourceLifecycleStatus = (typeof SOURCE_LIFECYCLE_STATUSES)[number];

export const SOURCE_PROPOSAL_STATUSES = [
  'proposal_pending',
  'proposal_approved',
  'proposal_rejected',
] as const;

export type SourceProposalStatus = (typeof SOURCE_PROPOSAL_STATUSES)[number];

export const SOURCE_HEALTH_STATUSES = [
  'unknown',
  'healthy',
  'degraded',
  'paused',
  'waiting_capacity',
] as const;

export type SourceHealthStatus = (typeof SOURCE_HEALTH_STATUSES)[number];

export const SOURCE_RIGHTS_STATUSES = [
  'pending',
  'approved',
  'revoked',
  'expired',
] as const;

export type SourceRightsStatus = (typeof SOURCE_RIGHTS_STATUSES)[number];

export const INGESTION_RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'rights_blocked',
] as const;

export type IngestionRunStatus = (typeof INGESTION_RUN_STATUSES)[number];

export const INGESTION_QUARANTINE_STATUSES = [
  'none',
  'held',
  'released',
  'discarded',
] as const;

export type IngestionQuarantineStatus = (typeof INGESTION_QUARANTINE_STATUSES)[number];

export const CONNECTOR_RELEASE_MODES = ['disabled', 'shadow', 'enabled'] as const;

export type ConnectorReleaseMode = (typeof CONNECTOR_RELEASE_MODES)[number];

export const CONNECTOR_ACCEPTANCE_STATES = [
  'Proposed',
  'Implemented locally',
  'Delivered',
  'Deployed',
  'Integrated',
  'Accepted',
  'Blocked',
] as const;

export type ConnectorAcceptanceState = (typeof CONNECTOR_ACCEPTANCE_STATES)[number];
