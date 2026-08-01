import type {
  TenantAdministrationSnapshot,
  TenantClosureStep,
  TenantDefaultPolicy,
  TenantEntitlement,
  TenantExportStep,
  TenantFeature,
  TenantGovernancePolicy,
  TenantLocale,
  TenantOperation,
  TenantOperationStepProof,
  TenantOperationStatus,
  TenantPlan,
  TenantProfile,
  TenantUsage,
} from '@mukuroji/contracts'

/** Minimum audit retention accepted by the tenant governance policy. */
export const TENANT_MIN_AUDIT_RETENTION_DAYS = 30

/** Maximum audit retention accepted by the tenant governance policy. */
export const TENANT_MAX_AUDIT_RETENTION_DAYS = 2_555

/** Maximum active seats accepted by the tenant entitlement policy. */
export const TENANT_MAX_SEAT_LIMIT = 1_000_000

/** Maximum metered units accepted by the tenant entitlement policy. */
export const TENANT_MAX_USAGE_QUOTA = 1_000_000_000

/** Stable steps for an export operation. */
export const TENANT_EXPORT_STEPS: readonly TenantExportStep[] = [
  'snapshot',
  'prepare-artifact',
  'verify-artifact',
]

/** Stable steps for an account-closure operation. */
export const TENANT_CLOSURE_STEPS: readonly TenantClosureStep[] = [
  'export',
  'revoke-access',
  'anonymize-members',
  'delete-data',
  'delete-secrets',
  'verify',
]

/**
 * Stable application error raised by tenant administration invariants.
 */
export class TenantAdministrationError extends Error {
  /** HTTP status used by the tenant administration adapter. */
  readonly status: number
  /** Stable machine-readable error code. */
  readonly code: string

  /**
   * Creates a tenant administration error.
   *
   * @param status - HTTP-compatible status code.
   * @param code - Stable error code.
   * @param message - Safe human-readable message.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'TenantAdministrationError'
    this.status = status
    this.code = code
  }
}

/**
 * Creates the default tenant profile for a newly observed Workspace.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param ownerMemberKey - Current owner member key.
 * @param now - Creation timestamp.
 * @returns A revision-zero tenant profile.
 */
export function createDefaultTenantProfile(
  workspaceId: string,
  ownerMemberKey: string,
  now: string,
): TenantProfile {
  return {
    workspaceId,
    ownerMemberKey,
    region: 'ap-northeast-1',
    locale: 'ja',
    defaultPolicy: createDefaultTenantPolicy(),
    revision: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Creates the default member/resource policy for a tenant.
 *
 * @returns A conservative default policy.
 */
export function createDefaultTenantPolicy(): TenantDefaultPolicy {
  return {
    allowExternalCollaborators: false,
    requireMfa: false,
    defaultMemberRole: 'member',
  }
}

/**
 * Creates the default plan entitlement for a tenant.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param now - Entitlement creation timestamp.
 * @returns A starter entitlement with bounded capacity.
 */
export function createDefaultTenantEntitlement(
  workspaceId: string,
  now: string,
): TenantEntitlement {
  return {
    workspaceId,
    plan: 'starter',
    features: ['documents'],
    seatLimit: 5,
    usageQuota: 10_000,
    gracePeriodDays: 7,
    revision: 0,
    updatedAt: now,
  }
}

/**
 * Creates an empty usage period anchored to the supplied timestamp.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param now - Current timestamp used to calculate the period.
 * @returns A zeroed current-period usage record.
 */
export function createDefaultTenantUsage(
  workspaceId: string,
  now: string,
): TenantUsage {
  const current = new Date(now)
  if (Number.isNaN(current.getTime())) {
    throw new TenantAdministrationError(500, 'InvalidTenantClock', 'Tenant clock is invalid.')
  }
  const periodStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1))
  const periodEnd = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1))
  return {
    workspaceId,
    activeSeats: 0,
    periodUsage: 0,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    revision: 0,
    updatedAt: now,
  }
}

/**
 * Creates the default governance policy for a tenant.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param actorMemberKey - Member key that created the policy.
 * @param now - Creation timestamp.
 * @returns A retention-safe governance policy.
 */
export function createDefaultTenantGovernance(
  workspaceId: string,
  actorMemberKey: string,
  now: string,
): TenantGovernancePolicy {
  return {
    workspaceId,
    auditRetentionDays: 365,
    legalHold: false,
    dataResidency: 'ap-northeast-1',
    encryptionKeyPolicy: 'aws-managed',
    revision: 0,
    updatedAt: now,
    updatedBy: actorMemberKey,
  }
}

/**
 * Creates a new tenant administration snapshot.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param ownerMemberKey - Current owner member key.
 * @param now - Snapshot creation timestamp.
 * @returns A complete default tenant administration aggregate.
 */
export function createDefaultTenantAdministrationSnapshot(
  workspaceId: string,
  ownerMemberKey: string,
  now: string,
): TenantAdministrationSnapshot {
  return {
    schemaVersion: 1,
    profile: createDefaultTenantProfile(workspaceId, ownerMemberKey, now),
    entitlement: createDefaultTenantEntitlement(workspaceId, now),
    usage: createDefaultTenantUsage(workspaceId, now),
    governance: createDefaultTenantGovernance(workspaceId, ownerMemberKey, now),
  }
}

/**
 * Validates a tenant locale.
 *
 * @param value - Candidate locale.
 * @returns The validated locale.
 */
export function validateTenantLocale(value: unknown): TenantLocale {
  if (value === 'ja' || value === 'en') {
    return value
  }
  throw new TenantAdministrationError(400, 'InvalidTenantLocale', 'Tenant locale is invalid.')
}

/**
 * Validates a tenant plan.
 *
 * @param value - Candidate plan.
 * @returns The validated plan.
 */
export function validateTenantPlan(value: unknown): TenantPlan {
  if (value === 'starter' || value === 'growth' || value === 'enterprise') {
    return value
  }
  throw new TenantAdministrationError(400, 'InvalidTenantPlan', 'Tenant plan is invalid.')
}

/**
 * Validates a feature list and rejects duplicates.
 *
 * @param value - Candidate feature list.
 * @returns A normalized feature list.
 */
export function validateTenantFeatures(value: unknown): TenantFeature[] {
  if (!Array.isArray(value) || value.length > 20) {
    throw new TenantAdministrationError(400, 'InvalidTenantFeatures', 'Tenant features are invalid.')
  }
  const features: TenantFeature[] = []
  for (const candidate of value) {
    if (
      candidate !== 'documents' &&
      candidate !== 'analytics' &&
      candidate !== 'automation' &&
      candidate !== 'developer-platform' &&
      candidate !== 'sso' &&
      candidate !== 'scim'
    ) {
      throw new TenantAdministrationError(400, 'InvalidTenantFeatures', 'Tenant features are invalid.')
    }
    if (features.includes(candidate)) {
      throw new TenantAdministrationError(400, 'DuplicateTenantFeature', 'Tenant features must be unique.')
    }
    features.push(candidate)
  }
  return features
}

/**
 * Validates a region-like AWS data residency identifier.
 *
 * @param value - Candidate region.
 * @returns A trimmed, lower-case region.
 */
export function validateTenantRegion(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TenantAdministrationError(400, 'InvalidTenantRegion', 'Tenant region is invalid.')
  }
  const region = value.trim().toLowerCase()
  if (!/^[a-z0-9-]{3,32}$/u.test(region) || !region.includes('-')) {
    throw new TenantAdministrationError(400, 'InvalidTenantRegion', 'Tenant region is invalid.')
  }
  return region
}

/**
 * Validates a boolean policy flag.
 *
 * @param value - Candidate boolean.
 * @param code - Stable error code used for a failed validation.
 * @returns The validated boolean.
 */
export function validateTenantBoolean(value: unknown, code: string): boolean {
  if (typeof value === 'boolean') {
    return value
  }
  throw new TenantAdministrationError(400, code, 'Tenant policy value is invalid.')
}

/**
 * Validates a finite non-negative integer.
 *
 * @param value - Candidate number.
 * @param maximum - Inclusive maximum.
 * @param code - Stable error code used for a failed validation.
 * @returns The validated integer.
 */
export function validateTenantInteger(
  value: unknown,
  maximum: number,
  code: string,
): number {
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= maximum
  ) {
    return value
  }
  throw new TenantAdministrationError(400, code, 'Tenant numeric value is invalid.')
}

/**
 * Applies a metered usage reservation with a server-side quota check.
 *
 * @param entitlement - Current tenant entitlement.
 * @param usage - Current tenant usage.
 * @param additionalUnits - Units to reserve.
 * @param now - Current timestamp.
 * @returns The next usage record after the reservation.
 */
export function reserveTenantUsage(
  entitlement: TenantEntitlement,
  usage: TenantUsage,
  additionalUnits: number,
  now: string,
): TenantUsage {
  const units = validateTenantInteger(additionalUnits, TENANT_MAX_USAGE_QUOTA, 'InvalidUsageUnits')
  const current = new Date(now)
  if (Number.isNaN(current.getTime())) {
    throw new TenantAdministrationError(500, 'InvalidTenantClock', 'Tenant clock is invalid.')
  }
  const periodEnd = new Date(usage.periodEnd)
  if (Number.isNaN(periodEnd.getTime())) {
    throw new TenantAdministrationError(503, 'InvalidTenantUsagePeriod', 'Tenant usage period is invalid.')
  }
  let periodUsage = usage
  if (current >= periodEnd) {
    periodUsage = {
      ...usage,
      periodUsage: 0,
      ...getTenantUsagePeriod(current),
      gracePeriodEndsAt: undefined,
    }
  }
  const nextUsage = periodUsage.periodUsage + units
  if (nextUsage > entitlement.usageQuota) {
    const graceEndsAt = periodUsage.gracePeriodEndsAt
      ? new Date(periodUsage.gracePeriodEndsAt)
      : new Date(current.getTime() + entitlement.gracePeriodDays * 86_400_000)
    if (Number.isNaN(graceEndsAt.getTime()) || current > graceEndsAt) {
      throw new TenantAdministrationError(
        429,
        'TenantUsageQuotaExceeded',
        'Tenant usage quota has been exceeded.',
      )
    }
    return {
      ...periodUsage,
      periodUsage: nextUsage,
      gracePeriodEndsAt: graceEndsAt.toISOString(),
      revision: periodUsage.revision + 1,
      updatedAt: now,
    }
  }
  return {
    ...periodUsage,
    periodUsage: nextUsage,
    revision: periodUsage.revision + 1,
    updatedAt: now,
  }
}

/** Calculates the UTC calendar-month boundary used by tenant metering. */
function getTenantUsagePeriod(current: Date): { periodStart: string; periodEnd: string } {
  const periodStart = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1))
  const periodEnd = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1))
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  }
}

/**
 * Ensures a tenant feature is enabled before a server-side operation starts.
 *
 * @param entitlement - Current tenant entitlement.
 * @param feature - Feature required by the operation.
 * @throws TenantAdministrationError when the feature is not enabled.
 */
export function assertTenantFeatureEnabled(
  entitlement: TenantEntitlement,
  feature: TenantFeature,
): void {
  if (!entitlement.features.includes(feature)) {
    throw new TenantAdministrationError(
      403,
      'TenantFeatureNotEntitled',
      'The tenant is not entitled to this feature.',
    )
  }
}

/**
 * Ensures a tenant has capacity for another active seat.
 *
 * @param entitlement - Current tenant entitlement.
 * @param usage - Current tenant usage.
 */
export function assertTenantSeatAvailable(
  entitlement: TenantEntitlement,
  usage: TenantUsage,
): void {
  if (usage.activeSeats >= entitlement.seatLimit) {
    throw new TenantAdministrationError(
      403,
      'TenantSeatLimitExceeded',
      'The tenant seat limit has been exceeded.',
    )
  }
}

/**
 * Determines whether an operation blocks normal tenant access.
 *
 * @param status - Operation status to inspect.
 * @returns True while the operation is still active.
 */
export function isTenantOperationActive(status: TenantOperationStatus): boolean {
  return status === 'requested' || status === 'running' || status === 'paused'
}

/**
 * Advances one durable step of an export or closure operation.
 *
 * @param operation - Current durable operation.
 * @param proof - Trusted evidence for the current step, when completing a step.
 * @param now - Transition timestamp.
 * @returns The next operation state.
 */
export function advanceTenantOperation(
  operation: TenantOperation,
  proof: TenantOperationStepProof | undefined,
  now: string,
): TenantOperation {
  if (operation.status === 'requested') {
    return {
      ...operation,
      status: 'running',
      currentStep: operation.kind === 'export'
        ? TENANT_EXPORT_STEPS[0]
        : TENANT_CLOSURE_STEPS[0],
      updatedAt: now,
      revision: operation.revision + 1,
    }
  }
  if (operation.status !== 'running' || operation.currentStep === undefined) {
    throw new TenantAdministrationError(
      409,
      'TenantOperationNotAdvancable',
      'Tenant operation cannot be advanced in its current state.',
    )
  }
  if (
    proof === undefined ||
    proof.step !== operation.currentStep ||
    proof.evidenceReference.trim().length === 0
  ) {
    throw new TenantAdministrationError(
      403,
      'TenantOperationStepProofRequired',
      'Trusted execution evidence is required to complete the current tenant operation step.',
    )
  }
  const steps = operation.kind === 'export' ? TENANT_EXPORT_STEPS : TENANT_CLOSURE_STEPS
  const currentIndex = steps.findIndex((step) => step === operation.currentStep)
  if (currentIndex < 0) {
    throw new TenantAdministrationError(
      409,
      'TenantOperationStepInvalid',
      'Tenant operation step is invalid.',
    )
  }
  const completedSteps = operation.completedSteps.includes(operation.currentStep)
    ? operation.completedSteps
    : [...operation.completedSteps, operation.currentStep]
  const nextStep = steps[currentIndex + 1]
  return {
    ...operation,
    status: nextStep === undefined ? 'completed' : 'running',
    currentStep: nextStep ?? operation.currentStep,
    completedSteps,
    lastEvidenceReference: proof.evidenceReference.trim(),
    updatedAt: now,
    revision: operation.revision + 1,
  }
}

/**
 * Pauses an active tenant operation.
 *
 * @param operation - Current durable operation.
 * @param now - Transition timestamp.
 * @returns The paused operation.
 */
export function pauseTenantOperation(
  operation: TenantOperation,
  now: string,
): TenantOperation {
  if (!isTenantOperationActive(operation.status)) {
    throw new TenantAdministrationError(409, 'TenantOperationNotPausable', 'Tenant operation cannot be paused.')
  }
  return {
    ...operation,
    status: 'paused',
    updatedAt: now,
    revision: operation.revision + 1,
  }
}

/**
 * Resumes a paused tenant operation.
 *
 * @param operation - Current durable operation.
 * @param now - Transition timestamp.
 * @returns The running operation.
 */
export function resumeTenantOperation(
  operation: TenantOperation,
  now: string,
): TenantOperation {
  if (operation.status !== 'paused') {
    throw new TenantAdministrationError(409, 'TenantOperationNotResumable', 'Tenant operation is not paused.')
  }
  return {
    ...operation,
    status: 'running',
    updatedAt: now,
    revision: operation.revision + 1,
  }
}

/**
 * Verifies a completed closure operation and seals its result.
 *
 * @param operation - Current durable closure operation.
 * @param now - Verification timestamp.
 * @returns A verified closure operation.
 */
export function verifyTenantClosure(
  operation: TenantOperation,
  now: string,
): TenantOperation {
  if (
    operation.kind !== 'closure' ||
    operation.status !== 'completed' ||
    !TENANT_CLOSURE_STEPS.every((step) => operation.completedSteps.includes(step))
  ) {
    throw new TenantAdministrationError(
      409,
      'TenantClosureNotVerifiable',
      'Tenant closure is not ready for verification.',
    )
  }
  return {
    ...operation,
    status: 'verified',
    updatedAt: now,
    revision: operation.revision + 1,
  }
}
