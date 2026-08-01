import type {
  RequestTenantClosureInput,
  RequestTenantExportInput,
  TenantAdministrationSnapshot,
  TenantEntitlement,
  TenantGovernancePolicy,
  TenantOperation,
  TenantOperationStepProof,
  TenantProfile,
  TenantUsage,
  UpdateTenantEntitlementInput,
  UpdateTenantGovernanceInput,
  UpdateTenantProfileInput,
} from '@mukuroji/contracts'
import type { TenantFeature } from '@mukuroji/contracts'
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'

/** DynamoDB transaction item prepared for a tenant administration mutation. */
export type TenantAdministrationTransactionItem = NonNullable<
  TransactWriteCommandInput['TransactItems']
>[number]

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
  /** Short action name shown in audit history. */
  action: string
  /** Route or internal operation that caused the mutation. */
  path: string
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
export type TenantAdministrationAuditWriter = {
  /** Creates an append-only audit Put or omits it when audit persistence is disabled. */
  createTransactionItem(
    event: TenantAdministrationAuditEvent,
  ): TenantAdministrationTransactionItem | undefined
}

/**
 * Application port for tenant administration and data-governance state.
 */
export interface TenantAdministrationClient {
  /** Ensures and returns the tenant aggregate for an authenticated Workspace. */
  ensureSnapshot(workspaceId: string, ownerMemberKey: string): Promise<TenantAdministrationSnapshot>
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
  /** Reserves metered usage after checking the current server-side entitlement. */
  reserveUsage(
    workspaceId: string,
    feature: TenantFeature,
    additionalUnits: number,
  ): Promise<TenantUsage>
  /** Starts a bounded, durable tenant export operation. */
  requestExport(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantExportInput,
  ): Promise<TenantOperation>
  /** Starts a legal-hold-aware account closure operation. */
  requestClosure(
    workspaceId: string,
    actorMemberKey: string,
    input: RequestTenantClosureInput,
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
  /** Pauses one active workflow. */
  pauseOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
  ): Promise<TenantOperation>
  /** Resumes one paused workflow. */
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
