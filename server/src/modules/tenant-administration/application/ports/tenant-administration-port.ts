import type {
  RequestTenantClosureInput,
  RequestTenantExportInput,
  TenantAdministrationSnapshot,
  TenantEntitlement,
  TenantGovernancePolicy,
  TenantOperation,
  TenantOperationStepProof,
  TenantProfile,
  TenantRetentionReconciliation,
  TenantUsage,
  UpdateTenantEntitlementInput,
  UpdateTenantGovernanceInput,
  UpdateTenantProfileInput,
} from '@mukuroji/contracts'
import type { TenantFeature } from '@mukuroji/contracts'

/** Safe tenant mutation data passed to the append-only audit writer. */
export type TenantAdministrationAuditEvent = {
  /** Canonical tenant Workspace identifier. */
  workspaceId: string
  /** Stable member or service key that performed the mutation. */
  actorMemberKey: string
  /** Canonical audit event type. */
  eventType: string
  /** Stable entity identifier for the audit event. */
  entityId: string
  /** Private member key converted to a scoped HMAC pseudonym by the audit adapter. */
  privateMemberKey?: string
  /** Short action name shown in audit history. */
  action: string
  /** Route or internal operation that caused the mutation. */
  path: string
  /** HTTP method or trusted internal source that caused the mutation. */
  requestMethod: 'PATCH' | 'POST' | 'INTERNAL'
  /** Idempotency key for deterministic audit event identity. */
  idempotencyKey: string
  /** Optional previous safe state. */
  before?: Readonly<Record<string, unknown>>
  /** Optional next safe state. */
  after?: Readonly<Record<string, unknown>>
  /** Safe metadata associated with the mutation. */
  metadata?: Readonly<Record<string, unknown>>
  /** Tenant retention policy in days. */
  retentionDays: number
  /** Whether retention expiry is suspended by an active legal hold. */
  legalHold: boolean
  /** Timestamp at which the mutation was committed. */
  occurredAt: string
}

/** Prepares audit persistence in the same transaction as a tenant mutation. */
export type TenantAdministrationAuditWriter<TransactionItem = unknown> = {
  /** Creates an append-only audit Put or omits it when audit persistence is disabled. */
  createTransactionItem(
    event: TenantAdministrationAuditEvent,
  ): TransactionItem | undefined
}

/** Input used to meter one Workspace membership state transition. */
export type TenantSeatMutationInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Stable member key whose active-seat state changed. */
  memberKey: string
  /** Direction of the authoritative membership transition. */
  direction: 'activate' | 'deactivate'
  /** Timestamp shared with the Workspace membership transaction. */
  occurredAt: string
}

/**
 * Server-side feature and quota checks used by authenticated feature routes.
 */
export interface TenantEntitlementEnforcement {
  /** Rejects normal route access while tenant closure is active or complete. */
  assertActive(workspaceId: string): Promise<void>
  /** Rejects a feature route when the current entitlement does not include it. */
  assertFeature(workspaceId: string, feature: TenantFeature): Promise<void>
  /** Reserves metered usage after checking feature entitlement and quota. */
  reserveUsage(
    workspaceId: string,
    feature: TenantFeature,
    additionalUnits: number,
    idempotencyKey?: string,
  ): Promise<unknown>
}

/**
 * Prepares seat-meter writes that join the authoritative membership transaction.
 */
export interface TenantSeatMeter<TransactionItem = unknown> {
  /** Returns conditional usage and audit items for one membership transition. */
  prepareSeatMutation(
    input: TenantSeatMutationInput,
  ): Promise<readonly TransactionItem[]>
}

/** Capability used by the trusted worker to reconcile audit TTL state. */
export interface TenantAuditRetentionProcessor {
  /** Applies one bounded page of the current tenant retention job. */
  reconcileAuditRetention(
    workspaceId: string,
  ): Promise<TenantRetentionReconciliation | undefined>
  /** Applies the current tenant retention policy to one newly inserted audit event. */
  reconcileAuditEventRetention(
    workspaceId: string,
    eventId: string,
    occurredAt: string,
  ): Promise<void>
}

/**
 * Application port for tenant administration and data-governance state.
 */
export interface TenantAdministrationClient extends TenantEntitlementEnforcement {
  /** Rejects normal access when a verified closure has sealed the tenant. */
  assertActive(workspaceId: string): Promise<void>
  /** Ensures the tenant aggregate exists and reconciles its authoritative owner. */
  ensureSnapshot(
    workspaceId: string,
    ownerMemberKey: string,
    activeSeats?: number,
  ): Promise<TenantAdministrationSnapshot>
  /** Returns the current tenant aggregate without trusting client-supplied tenant IDs. */
  getSnapshot(workspaceId: string): Promise<TenantAdministrationSnapshot>
  /** Updates profile fields with an optimistic revision condition. */
  updateProfile(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantProfileInput,
  ): Promise<TenantProfile>
  /** Updates plan and capacity fields with an optimistic revision condition. */
  updateEntitlement(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantEntitlementInput,
  ): Promise<TenantEntitlement>
  /** Updates retention, residency, and encryption policy with an optimistic revision condition. */
  updateGovernance(
    workspaceId: string,
    actorMemberKey: string,
    input: UpdateTenantGovernanceInput,
  ): Promise<TenantGovernancePolicy>
  /** Reserves metered usage and returns the updated current-period counter. */
  reserveUsage(
    workspaceId: string,
    feature: TenantFeature,
    additionalUnits: number,
    idempotencyKey?: string,
  ): Promise<TenantUsage>
  /** Starts a bounded, durable tenant export operation. */
  requestExport(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantExportInput,
    idempotencyKey?: string,
  ): Promise<TenantOperation>
  /** Starts a legal-hold-aware account closure operation. */
  requestClosure(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantClosureInput,
    idempotencyKey?: string,
  ): Promise<TenantOperation>
  /** Returns one operation belonging to the authenticated tenant. */
  getOperation(workspaceId: string, operationId: string): Promise<TenantOperation>
  /** Advances one durable workflow step. */
  advanceOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    proof: TenantOperationStepProof | undefined,
  ): Promise<TenantOperation>
  /** Records a safe terminal failure from the capability owning the current step. */
  failOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    failureCode: string,
  ): Promise<TenantOperation>
  /** Pauses one active workflow. */
  pauseOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation>
  /** Starts one held requested workflow or resumes one paused workflow. */
  resumeOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation>
  /** Verifies a completed closure workflow. */
  verifyClosure(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation>
}
