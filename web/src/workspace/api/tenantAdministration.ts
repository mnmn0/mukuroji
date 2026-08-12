import type {
  RequestTenantClosureInput,
  RequestTenantExportInput,
  TenantAdministrationSnapshot,
  TenantBillingPeriod,
  TenantDefaultPolicy,
  TenantEntitlement,
  TenantGovernanceEnforcement,
  TenantGovernancePolicy,
  TenantOperation,
  TenantProfile,
  TenantRetentionReconciliation,
  TenantUsage,
  UpdateTenantEntitlementInput,
  UpdateTenantGovernanceInput,
  UpdateTenantProfileInput,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { WorkspaceAccessApiError } from './errors'

const tenantAdministrationApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)

/**
 * Retrieves the tenant administration aggregate for the authenticated Workspace.
 *
 * @param accessToken - Bearer token used for the read.
 * @param signal - Optional cancellation signal for the request.
 * @returns The validated tenant administration snapshot.
 */
export async function getTenantAdministration(
  accessToken: string,
  signal?: AbortSignal,
): Promise<TenantAdministrationSnapshot> {
  return readTenantAdministrationSnapshot(await sendTenantRequest(
    '/tenant/administration',
    accessToken,
    { signal },
  ))
}

/**
 * Updates tenant profile and default policy fields.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param input - Revision-checked profile update.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The updated tenant profile.
 */
export async function updateTenantProfile(
  accessToken: string,
  input: UpdateTenantProfileInput,
  mutationContext: MutationRequestContext,
): Promise<TenantProfile> {
  return readResponseEntity(
    await sendTenantRequest('/tenant/profile', accessToken, {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PATCH',
    }),
    'profile',
    isTenantProfile,
  )
}

/**
 * Updates tenant plan, feature, seat, and quota entitlement fields.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param input - Revision-checked entitlement update.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The updated tenant entitlement.
 */
export async function updateTenantEntitlement(
  accessToken: string,
  input: UpdateTenantEntitlementInput,
  mutationContext: MutationRequestContext,
): Promise<TenantEntitlement> {
  return readResponseEntity(
    await sendTenantRequest('/tenant/entitlement', accessToken, {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PATCH',
    }),
    'entitlement',
    isTenantEntitlement,
  )
}

/**
 * Updates tenant retention, legal-hold, residency, and key policy fields.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param input - Revision-checked governance update.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The updated tenant governance policy.
 */
export async function updateTenantGovernance(
  accessToken: string,
  input: UpdateTenantGovernanceInput,
  mutationContext: MutationRequestContext,
): Promise<TenantGovernancePolicy> {
  return readResponseEntity(
    await sendTenantRequest('/tenant/governance', accessToken, {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'PATCH',
    }),
    'governance',
    isTenantGovernancePolicy,
  )
}

/**
 * Starts a tenant export and returns its durable operation record.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param input - Requested export format.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The requested export operation.
 */
export async function requestTenantExport(
  accessToken: string,
  input: RequestTenantExportInput,
  mutationContext: MutationRequestContext,
): Promise<TenantOperation> {
  return readResponseEntity(
    await sendTenantRequest('/tenant/exports', accessToken, {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    }),
    'operation',
    isTenantOperation,
  )
}

/**
 * Starts an account-closure workflow after its explicit confirmation.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param input - Explicit closure confirmation.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The requested closure operation.
 */
export async function requestTenantClosure(
  accessToken: string,
  input: RequestTenantClosureInput,
  mutationContext: MutationRequestContext,
): Promise<TenantOperation> {
  return readResponseEntity(
    await sendTenantRequest('/tenant/closures', accessToken, {
      body: JSON.stringify(input),
      headers: createMutationHeaders(mutationContext),
      method: 'POST',
    }),
    'operation',
    isTenantOperation,
  )
}

/**
 * Pauses one active export or closure workflow.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param operationId - Durable tenant operation identifier.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The paused tenant operation.
 */
export function pauseTenantOperation(
  accessToken: string,
  operationId: string,
  mutationContext: MutationRequestContext,
) {
  return mutateTenantOperation(accessToken, operationId, 'pause', mutationContext)
}

/**
 * Resumes one paused export or closure workflow.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param operationId - Durable tenant operation identifier.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The resumed tenant operation.
 */
export function resumeTenantOperation(
  accessToken: string,
  operationId: string,
  mutationContext: MutationRequestContext,
) {
  return mutateTenantOperation(accessToken, operationId, 'resume', mutationContext)
}

/**
 * Verifies a completed closure workflow.
 *
 * @param accessToken - Bearer token used for the mutation.
 * @param operationId - Durable closure operation identifier.
 * @param mutationContext - Idempotency and request mutation context.
 * @returns The verified closure operation.
 */
export function verifyTenantClosure(
  accessToken: string,
  operationId: string,
  mutationContext: MutationRequestContext,
) {
  return mutateTenantOperation(accessToken, operationId, 'verify', mutationContext)
}

async function mutateTenantOperation(
  accessToken: string,
  operationId: string,
  action: 'pause' | 'resume' | 'verify',
  mutationContext: MutationRequestContext,
): Promise<TenantOperation> {
  return readResponseEntity(
    await sendTenantRequest(
      `/tenant/operations/${encodeURIComponent(operationId)}/${action}`,
      accessToken,
      {
        headers: createMutationHeaders(mutationContext),
        method: 'POST',
      },
    ),
    'operation',
    isTenantOperation,
  )
}

async function sendTenantRequest(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${tenantAdministrationApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })
  const data = await readJson(response)
  if (!response.ok) {
    throw new WorkspaceAccessApiError(
      response.status,
      readErrorMessage(data),
      readErrorCode(data),
    )
  }
  return data
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  return text ? JSON.parse(text) : {}
}

function readResponseEntity<T>(
  value: unknown,
  key: string,
  guard: (candidate: unknown) => candidate is T,
): T {
  if (isRecord(value)) {
    const entity = value[key]
    if (guard(entity)) return entity
  }
  throw new WorkspaceAccessApiError(502, 'tenant.administration.invalidResponse')
}

function readTenantAdministrationSnapshot(value: unknown): TenantAdministrationSnapshot {
  if (
    isRecord(value) &&
    value.schemaVersion === 2 &&
    isTenantProfile(value.profile) &&
    isTenantEntitlement(value.entitlement) &&
    isTenantUsage(value.usage) &&
    Array.isArray(value.billingPeriods) &&
    value.billingPeriods.every(isTenantBillingPeriod) &&
    Array.isArray(value.recentOperations) &&
    value.recentOperations.every(isTenantOperation) &&
    isTenantGovernancePolicy(value.governance) &&
    isTenantGovernanceEnforcement(value.governanceEnforcement) &&
    (value.retentionReconciliation === undefined ||
      isTenantRetentionReconciliation(value.retentionReconciliation)) &&
    (value.activeOperation === undefined || isTenantOperation(value.activeOperation))
  ) {
    return {
      schemaVersion: 2,
      profile: value.profile,
      entitlement: value.entitlement,
      usage: value.usage,
      billingPeriods: value.billingPeriods,
      recentOperations: value.recentOperations,
      governance: value.governance,
      governanceEnforcement: value.governanceEnforcement,
      ...(value.retentionReconciliation
        ? { retentionReconciliation: value.retentionReconciliation }
        : {}),
      ...(value.activeOperation ? { activeOperation: value.activeOperation } : {}),
    }
  }
  throw new WorkspaceAccessApiError(502, 'tenant.administration.invalidResponse')
}

/** Returns true for data-plane governance enforcement controls. */
function isTenantGovernanceEnforcement(
  value: unknown,
): value is TenantGovernanceEnforcement {
  return isRecord(value) &&
    typeof value.dataResidency === 'string' &&
    (value.encryptionKeyPolicy === 'aws-managed' || value.encryptionKeyPolicy === 'customer-managed')
}

/** Returns true for one validated audit-retention reconciliation progress record. */
function isTenantRetentionReconciliation(
  value: unknown,
): value is TenantRetentionReconciliation {
  return isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    isNonNegativeInteger(value.governanceRevision) &&
    (value.status === 'pending' || value.status === 'running' || value.status === 'completed') &&
    isNonNegativeInteger(value.retentionDays) &&
    typeof value.legalHold === 'boolean' &&
    isNonNegativeInteger(value.processedEvents) &&
    (value.cursorEventId === undefined || typeof value.cursorEventId === 'string') &&
    typeof value.updatedBy === 'string' &&
    isRevisionedRecord(value)
}

function isTenantProfile(value: unknown): value is TenantProfile {
  return isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    typeof value.ownerMemberKey === 'string' &&
    typeof value.region === 'string' &&
    (value.locale === 'ja' || value.locale === 'en') &&
    isTenantDefaultPolicy(value.defaultPolicy) &&
    (value.status === 'active' || value.status === 'closing' || value.status === 'closed') &&
    (value.closedAt === undefined || typeof value.closedAt === 'string') &&
    (value.closedByOperationId === undefined || typeof value.closedByOperationId === 'string') &&
    (value.status === 'closed'
      ? typeof value.closedAt === 'string' && typeof value.closedByOperationId === 'string'
      : value.closedAt === undefined && value.closedByOperationId === undefined) &&
    isRevisionedRecord(value)
}

function isTenantDefaultPolicy(value: unknown): value is TenantDefaultPolicy {
  return isRecord(value) &&
    (value.defaultMemberRole === 'member' || value.defaultMemberRole === 'guest')
}

function isTenantEntitlement(value: unknown): value is TenantEntitlement {
  return isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    (value.plan === 'starter' || value.plan === 'growth' || value.plan === 'enterprise') &&
    Array.isArray(value.features) &&
    value.features.every(isTenantFeature) &&
    isNonNegativeInteger(value.seatLimit) &&
    isNonNegativeInteger(value.usageQuota) &&
    isNonNegativeInteger(value.gracePeriodDays) &&
    isRevisionedRecord(value)
}

function isTenantFeature(value: unknown): value is TenantEntitlement['features'][number] {
  return value === 'documents' ||
    value === 'analytics' ||
    value === 'automation' ||
    value === 'developer-platform' ||
    value === 'sso' ||
    value === 'scim'
}

function isTenantUsage(value: unknown): value is TenantUsage {
  return isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    isNonNegativeInteger(value.activeSeats) &&
    isNonNegativeInteger(value.periodUsage) &&
    typeof value.periodStart === 'string' &&
    typeof value.periodEnd === 'string' &&
    (value.gracePeriodEndsAt === undefined || typeof value.gracePeriodEndsAt === 'string') &&
    isRevisionedRecord(value)
}

/** Returns true for one invoice-ready tenant billing aggregate. */
function isTenantBillingPeriod(value: unknown): value is TenantBillingPeriod {
  return isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    typeof value.periodStart === 'string' &&
    typeof value.periodEnd === 'string' &&
    isNonNegativeInteger(value.meteredUnits) &&
    isNonNegativeInteger(value.activeSeatHighWaterMark) &&
    isRevisionedRecord(value)
}

function isTenantGovernancePolicy(value: unknown): value is TenantGovernancePolicy {
  return isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    isNonNegativeInteger(value.auditRetentionDays) &&
    typeof value.legalHold === 'boolean' &&
    typeof value.dataResidency === 'string' &&
    (value.encryptionKeyPolicy === 'aws-managed' || value.encryptionKeyPolicy === 'customer-managed') &&
    typeof value.updatedBy === 'string' &&
    isRevisionedRecord(value)
}

function isTenantOperation(value: unknown): value is TenantOperation {
  return isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.workspaceId === 'string' &&
    (value.kind === 'export' || value.kind === 'closure') &&
    (value.status === 'requested' || value.status === 'running' || value.status === 'paused' ||
      value.status === 'completed' || value.status === 'failed' || value.status === 'verified') &&
    typeof value.requestedBy === 'string' &&
    typeof value.requestedAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.updatedBy === 'string' &&
    Array.isArray(value.completedSteps) &&
    value.completedSteps.every(isTenantOperationStep) &&
    (value.currentStep === undefined || isTenantOperationStep(value.currentStep)) &&
    (value.lastEvidenceReference === undefined ||
      typeof value.lastEvidenceReference === 'string' &&
      /^evidence:sha256:[a-f0-9]{64}$/u.test(value.lastEvidenceReference)) &&
    (value.failureCode === undefined ||
      typeof value.failureCode === 'string' &&
      /^[A-Z][A-Z0-9_]{2,63}$/u.test(value.failureCode)) &&
    (value.exportFormat === undefined || value.exportFormat === 'jsonl' || value.exportFormat === 'csv') &&
    isRevisionedRecord(value)
}

/** Returns true for one bounded tenant lifecycle step. */
function isTenantOperationStep(
  value: unknown,
): value is TenantOperation['completedSteps'][number] {
  return value === 'snapshot' ||
    value === 'prepare-artifact' ||
    value === 'verify-artifact' ||
    value === 'export' ||
    value === 'revoke-access' ||
    value === 'anonymize-members' ||
    value === 'delete-data' ||
    value === 'delete-secrets' ||
    value === 'verify'
}

function isRevisionedRecord(value: Record<string, unknown>): boolean {
  return typeof value.createdAt === 'string' || typeof value.updatedAt === 'string'
    ? isNonNegativeInteger(value.revision)
    : false
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readErrorCode(value: unknown): string | undefined {
  return isRecord(value) && typeof value.code === 'string' ? value.code : undefined
}

function readErrorMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === 'string'
    ? value.message
    : 'tenant.administration.error'
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}
