import { createHash } from 'node:crypto'
import {
  type ApprovalRequest,
  type CanonicalWorkItem,
  type PlanningSnapshot,
  type PlanningWorkItemSummary,
  type FocusEffectivePolicy,
  type FocusItem,
  type FocusPolicy,
  type FocusPolicyOverrides,
  type FocusPolicyTarget,
  type FocusQueueResponse,
  type FocusSignalWeightOverrides,
  type UpdateFocusPolicyInput,
  type UpdateFocusPolicyResponse,
  type UpdateFocusSnoozeInput,
  type UpdateFocusSnoozeResponse,
  type UpdateFocusWatchInput,
  type UpdateFocusWatchResponse,
} from '@mukuroji/contracts'
import type { Hono } from 'hono'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { getConfiguredDynamoDbEndpoint } from '../../modules/audit/audit'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  CollaborationError,
  createProjectCollaborationEntityKey,
  createWorkItemCollaborationEntityKey,
} from '../../modules/collaboration/collaboration'
import {
  FileProofingError,
  createFileProofingScopeKey,
  type FileProofingScope,
} from '../../modules/files/file-proofing'
import {
  NotificationError,
  type NotificationFilter,
  type NotificationItem,
} from '../../modules/notifications/notifications'
import {
  FocusStateError,
  createFocusCauseFingerprint,
  createFocusPolicyMutationPreview,
  createFocusPolicyRevisionConditionCheck,
  createFocusQueue,
  createFocusWorkItemStateKey as createFocusWorkItemKey,
  resolveFocusEffectivePolicies,
  type CreateFocusQueueInput,
  type FocusRelationGraphSource,
  type FocusSnoozeRecord,
  type FocusStateSnapshot,
} from '../../modules/focus'
import {
  evaluateEnterpriseAccess,
  type EnterpriseAuthorizationResource,
} from '../../modules/enterprise-identity'
import {
  createPlanningWorkItemDependencySummary,
  PlanningError,
  type PlanningWorkItemState,
} from '../../modules/planning'
import type {
  IdempotencyMutationToken,
  ReleaseIdempotencyRequest,
  ReserveIdempotencyRequest,
} from '../../modules/developer-platform/application/ports'
import { DeveloperPlatformError } from '../../modules/developer-platform'
import {
  developerPlatformDependencies,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { toCollaborationErrorResponse } from '../shared/collaboration-access'
import { WORK_ITEMS_TEAM_READ_LIMIT } from '../shared/constants'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import {
  hasApprovalSummaryContent,
  listAuthorizedReviewerApprovals,
  toFileProofingErrorResponse,
} from '../shared/file-approval-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  createNotificationVisibilityFilter,
  toNotificationErrorResponse,
} from '../shared/notification-access'
import {
  createPlanningCallerAuthorizationConditionChecks,
  readAccessibleWorkItems,
  toPlanningErrorResponse,
} from '../shared/planning-access'
import {
  createApiMutationContext,
  getEffectiveProjectAccessList,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { getEnv } from '../shared/runtime-config'
import { isRecord, stableDigestStringify } from '../shared/value-guards'
import {
  canWriteTeamIssue,
  createWorkItemListLimitExceededError,
  loadAuthorizedTeamIssue,
} from '../shared/work-item-access'
import {
  createWorkItemScheduleIdempotencyUserId,
  createWorkItemScheduleIdempotencyWorkspaceId,
} from '../shared/work-item-schedule'
import { projectAccessAllows, type TeamPermissionContext } from '../shared/workspace-access'

/** Maximum notification page size accepted by the durable Inbox port. */
const FOCUS_NOTIFICATION_PAGE_LIMIT = 50

/** Maximum Inbox pages read from each state partition for one Focus projection. */
const FOCUS_NOTIFICATION_MAX_PAGES_PER_FILTER = 4

/** Maximum age of mention events considered by the Focus queue. */
const FOCUS_NOTIFICATION_LOOKBACK_DAYS = 90

/** Maximum deduplicated mention events supplied to one Focus projection. */
const FOCUS_NOTIFICATION_GLOBAL_LIMIT = 200

/** Maximum mention events retained for one Team-qualified Work Item. */
const FOCUS_NOTIFICATION_PER_WORK_ITEM_LIMIT = 10

/** Inbox state partitions required to recover every visible Focus source event. */
const FOCUS_NOTIFICATION_FILTERS: readonly NotificationFilter[] = [
  'all',
  'archived',
  'snoozed',
]

/** Maximum reviewer approval page size accepted by the file-proofing port. */
const FOCUS_APPROVAL_PAGE_LIMIT = 100

/** Maximum reviewer approval pages read for one Focus projection. */
const FOCUS_APPROVAL_MAX_PAGES = 4

/** Maximum deduplicated reviewer approvals supplied to one Focus projection. */
const FOCUS_APPROVAL_GLOBAL_LIMIT = 400

/** Maximum future duration accepted for one recipient-specific Focus snooze. */
const FOCUS_SNOOZE_MAXIMUM_MILLISECONDS = 365 * 24 * 60 * 60 * 1_000

/** Maximum concurrent watcher reads performed while assembling one Focus queue. */
const FOCUS_WATCHER_READ_BATCH_SIZE = 16

/** Maximum Focus items whose watcher state is resolved for one queue. */
const FOCUS_WATCHER_READ_LIMIT = 400

/** Stable Focus HTTP boundary error. */
class FocusApiError extends Error {
  /** HTTP status returned for this failure. */
  readonly status: number
  /** Machine-readable failure code returned to clients. */
  readonly code: string

  /**
   * Creates one safe Focus API failure.
   *
   * @param status - HTTP status returned for this failure.
   * @param code - Machine-readable failure code.
   * @param message - Safe client-facing failure description.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'FocusApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Parses a complete Focus policy replacement from untrusted JSON.
 *
 * @param value - Unknown request body.
 * @returns Validated policy replacement input.
 */
function readFocusPolicyInput(value: unknown): UpdateFocusPolicyInput {
  const body = requireFocusInputRecord(value, 'A Focus policy object is required.')
  requireFocusInputKeys(body, ['target', 'expectedVersion', 'overrides'])
  return {
    target: readFocusPolicyTarget(body.target),
    expectedVersion: readFocusExpectedVersion(body.expectedVersion),
    overrides: readFocusPolicyOverrides(body.overrides),
  }
}

/**
 * Parses a Focus policy target without accepting a caller-supplied user identity.
 *
 * @param value - Unknown target value.
 * @returns Current-user or Team policy target.
 */
function readFocusPolicyTarget(value: unknown): FocusPolicyTarget {
  const target = requireFocusInputRecord(value, 'Focus policy target is required.')
  if (target.type === 'user') {
    requireFocusInputKeys(target, ['type'])
    return { type: 'user' }
  }
  if (target.type === 'team') {
    requireFocusInputKeys(target, ['type', 'teamId'])
    return {
      type: 'team',
      teamId: readFocusRouteId(target.teamId, 'Focus Team ID'),
    }
  }
  throw invalidFocusInput('Focus policy target is invalid.')
}

/**
 * Parses bounded policy override fields from an untrusted object.
 *
 * @param value - Unknown override value.
 * @returns Validated complete replacement set of optional overrides.
 */
function readFocusPolicyOverrides(value: unknown): FocusPolicyOverrides {
  const overrides = requireFocusInputRecord(value, 'Focus policy overrides are required.')
  requireFocusInputKeys(overrides, [
    'weights',
    'dueSoonDays',
    'cycleDueSoonDays',
    'slaHours',
    'nowScoreThreshold',
  ])
  const weights = overrides.weights === undefined
    ? undefined
    : readFocusSignalWeightOverrides(overrides.weights)
  const dueSoonDays = readOptionalFocusPolicyNumber(
    overrides.dueSoonDays,
    'dueSoonDays',
    0,
    365,
    true,
  )
  const cycleDueSoonDays = readOptionalFocusPolicyNumber(
    overrides.cycleDueSoonDays,
    'cycleDueSoonDays',
    0,
    365,
    true,
  )
  const slaHours = readOptionalFocusPolicyNumber(
    overrides.slaHours,
    'slaHours',
    1,
    24 * 365,
    true,
  )
  const nowScoreThreshold = readOptionalFocusPolicyNumber(
    overrides.nowScoreThreshold,
    'nowScoreThreshold',
    0,
    100_000,
    false,
  )
  return {
    ...(weights === undefined ? {} : { weights }),
    ...(dueSoonDays === undefined ? {} : { dueSoonDays }),
    ...(cycleDueSoonDays === undefined ? {} : { cycleDueSoonDays }),
    ...(slaHours === undefined ? {} : { slaHours }),
    ...(nowScoreThreshold === undefined ? {} : { nowScoreThreshold }),
  }
}

/**
 * Parses bounded per-signal weight replacements.
 *
 * @param value - Unknown signal weight map.
 * @returns Validated signal weight overrides.
 */
function readFocusSignalWeightOverrides(
  value: unknown,
): FocusSignalWeightOverrides {
  const weights = requireFocusInputRecord(value, 'Focus signal weights are invalid.')
  requireFocusInputKeys(weights, [
    'blocker',
    'urgent',
    'overdue',
    'dueSoon',
    'approval',
    'reviewRequest',
    'mention',
    'sla',
    'cycle',
  ])
  const blocker = readOptionalFocusPolicyNumber(weights.blocker, 'blocker', 0, 10_000, false)
  const urgent = readOptionalFocusPolicyNumber(weights.urgent, 'urgent', 0, 10_000, false)
  const overdue = readOptionalFocusPolicyNumber(weights.overdue, 'overdue', 0, 10_000, false)
  const dueSoon = readOptionalFocusPolicyNumber(weights.dueSoon, 'dueSoon', 0, 10_000, false)
  const approval = readOptionalFocusPolicyNumber(weights.approval, 'approval', 0, 10_000, false)
  const reviewRequest = readOptionalFocusPolicyNumber(
    weights.reviewRequest,
    'reviewRequest',
    0,
    10_000,
    false,
  )
  const mention = readOptionalFocusPolicyNumber(weights.mention, 'mention', 0, 10_000, false)
  const sla = readOptionalFocusPolicyNumber(weights.sla, 'sla', 0, 10_000, false)
  const cycle = readOptionalFocusPolicyNumber(weights.cycle, 'cycle', 0, 10_000, false)
  return {
    ...(blocker === undefined ? {} : { blocker }),
    ...(urgent === undefined ? {} : { urgent }),
    ...(overdue === undefined ? {} : { overdue }),
    ...(dueSoon === undefined ? {} : { dueSoon }),
    ...(approval === undefined ? {} : { approval }),
    ...(reviewRequest === undefined ? {} : { reviewRequest }),
    ...(mention === undefined ? {} : { mention }),
    ...(sla === undefined ? {} : { sla }),
    ...(cycle === undefined ? {} : { cycle }),
  }
}

/**
 * Parses one optional bounded Focus policy number.
 *
 * @param value - Unknown numeric value.
 * @param field - Contract field name used in the error response.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @param integer - Whether only safe integers are accepted.
 * @returns Validated number or undefined when omitted.
 */
function readOptionalFocusPolicyNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  integer: boolean,
): number | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw invalidFocusInput(`Focus policy ${field} is outside its supported range.`)
  }
  return value
}

/**
 * Parses a version-checked Focus snooze replacement.
 *
 * @param value - Unknown request body.
 * @param now - Stable mutation clock used to reject expired wake times.
 * @returns Validated snooze or unsnooze input.
 */
function readFocusSnoozeInput(
  value: unknown,
  now: Date,
): UpdateFocusSnoozeInput {
  const body = requireFocusInputRecord(value, 'A Focus snooze object is required.')
  requireFocusInputKeys(body, ['expectedVersion', 'snoozedUntil'])
  const expectedVersion = readFocusExpectedVersion(body.expectedVersion)
  if (body.snoozedUntil === null) {
    return { expectedVersion, snoozedUntil: null }
  }
  if (
    typeof body.snoozedUntil !== 'string' ||
    body.snoozedUntil.length === 0 ||
    body.snoozedUntil !== body.snoozedUntil.trim()
  ) {
    throw invalidFocusInput('Focus snooze wake time must be an ISO 8601 timestamp or null.')
  }
  const snoozedUntil = new Date(body.snoozedUntil)
  if (
    Number.isNaN(snoozedUntil.getTime()) ||
    snoozedUntil.getTime() <= now.getTime() ||
    snoozedUntil.getTime() > now.getTime() + FOCUS_SNOOZE_MAXIMUM_MILLISECONDS
  ) {
    throw invalidFocusInput('Focus snooze wake time must be in the next 365 days.')
  }
  return { expectedVersion, snoozedUntil: snoozedUntil.toISOString() }
}

/**
 * Parses a version-checked Focus watcher replacement.
 *
 * @param value - Unknown request body.
 * @returns Validated watcher input.
 */
function readFocusWatchInput(value: unknown): UpdateFocusWatchInput {
  const body = requireFocusInputRecord(value, 'A Focus watch object is required.')
  requireFocusInputKeys(body, ['expectedVersion', 'watching'])
  if (typeof body.watching !== 'boolean') {
    throw invalidFocusInput('Focus watching must be a boolean.')
  }
  return {
    expectedVersion: readFocusExpectedVersion(body.expectedVersion),
    watching: body.watching,
  }
}

/**
 * Parses one nonnegative optimistic concurrency version.
 *
 * @param value - Unknown version value.
 * @returns Validated version.
 */
function readFocusExpectedVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidFocusInput('Focus expectedVersion must be a nonnegative safe integer.')
  }
  return value
}

/**
 * Parses one bounded Focus route identifier.
 *
 * @param value - Unknown route identifier.
 * @param label - Safe identifier label.
 * @returns Validated unchanged identifier.
 */
function readFocusRouteId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim() ||
    value.length > 256
  ) {
    throw invalidFocusInput(`${label} is required.`)
  }
  return value
}

/**
 * Requires an untrusted Focus value to be a JSON object.
 *
 * @param value - Unknown request value.
 * @param message - Safe validation failure message.
 * @returns Narrowed record value.
 */
function requireFocusInputRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalidFocusInput(message)
  return value
}

/**
 * Rejects unknown keys at the Focus HTTP contract boundary.
 *
 * @param value - Narrowed request object.
 * @param allowedKeys - Complete allowed key list.
 */
function requireFocusInputKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys)
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidFocusInput('Focus input contains an unknown field.')
  }
}

/**
 * Creates one stable invalid Focus request error.
 *
 * @param message - Safe validation failure description.
 * @returns Focus API validation error.
 */
function invalidFocusInput(message: string): FocusApiError {
  return new FocusApiError(400, 'InvalidFocusInput', message)
}

/** Mutation represented by one durable Focus response receipt. */
type FocusMutationReceiptOperation = 'policy' | 'snooze' | 'watch'

/** Stable schema discriminator for Focus mutation receipts. */
const FOCUS_MUTATION_RECEIPT_SCHEMA = 'focus-mutation'

/** Current Focus mutation receipt version. */
const FOCUS_MUTATION_RECEIPT_VERSION = 1

/**
 * Validates the required caller-provided key for one Focus mutation.
 *
 * @param value - Raw `Idempotency-Key` header value.
 * @returns Trimmed key safe for the shared idempotency port.
 */
function readRequiredFocusIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? ''
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
  })
  if (!key || key.length > 256 || hasControlCharacter) {
    throw new FocusApiError(
      400,
      'InvalidFocusIdempotencyKey',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

/**
 * Creates the actor-scoped reservation identity for one Focus mutation.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param idempotencyKey - Validated caller-provided key.
 * @param method - Canonical HTTP method.
 * @param path - Canonical API path.
 * @param body - Parsed request body bound to the key.
 * @returns Shared idempotency reservation request.
 */
function createFocusMutationReservationRequest(
  principal: WorkspacePrincipal,
  idempotencyKey: string,
  method: string,
  path: string,
  body: unknown,
): ReserveIdempotencyRequest {
  return {
    workspaceId: createWorkItemScheduleIdempotencyWorkspaceId(principal.directoryId),
    credentialId: createWorkItemScheduleIdempotencyUserId(
      principal.directoryId,
      principal.actorId,
    ),
    idempotencyKey,
    requestFingerprint: createFocusMutationFingerprint(method, path, body),
  }
}

/**
 * Binds one Focus key to its exact method, canonical path, and parsed JSON body.
 *
 * @param method - Incoming HTTP method.
 * @param path - Canonical API path.
 * @param body - Parsed request body.
 * @returns Stable SHA-256 request fingerprint.
 */
function createFocusMutationFingerprint(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${stableDigestStringify(body)}`)
    .digest('hex')
}

/**
 * Creates an opaque identity for the receipt target.
 *
 * @param operation - Focus mutation operation.
 * @param identifiers - Validated target identifiers in canonical order.
 * @returns Stable SHA-256 target identity.
 */
function createFocusMutationTargetIdentity(
  operation: FocusMutationReceiptOperation,
  identifiers: readonly string[],
): string {
  return createHash('sha256')
    .update(stableDigestStringify([operation, ...identifiers]))
    .digest('hex')
}

/**
 * Creates a canonical item mutation path from validated route identifiers.
 *
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @param operation - Item mutation operation.
 * @returns Canonical encoded API path.
 */
function createFocusItemMutationPath(
  teamId: string,
  workItemId: string,
  operation: 'snooze' | 'watch',
): string {
  return `/api/focus/items/${encodeURIComponent(teamId)}/${encodeURIComponent(workItemId)}/${operation}`
}

/**
 * Prepares the exact policy snapshot and recovery marker used by one durable update.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param input - Validated policy replacement.
 * @param now - Stable mutation clock.
 * @param request - Actor-scoped idempotency reservation identity.
 * @param targetIdentity - Opaque policy target identity.
 * @returns Predicted response, mutation marker, and an already committed policy when recoverable.
 */
async function prepareFocusPolicyMutation(
  principal: WorkspacePrincipal,
  input: UpdateFocusPolicyInput,
  now: Date,
  request: ReserveIdempotencyRequest,
  targetIdentity: string,
) {
  const target = input.target
  const accessibleTeamIds = await readFocusAccessibleTeamIds(principal)
  if (
    target.type === 'user' &&
    accessibleTeamIds.length > WORK_ITEMS_TEAM_READ_LIMIT
  ) {
    throw createWorkItemListLimitExceededError(
      `Workspace has more than ${WORK_ITEMS_TEAM_READ_LIMIT} accessible Teams.`,
    )
  }
  const policyStateTeamIds = target.type === 'team'
    ? [...new Set([...accessibleTeamIds, target.teamId])].sort()
    : accessibleTeamIds
  const state = await workItemDependencies.focusState.getState({
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    teamIds: policyStateTeamIds,
  })
  const preview = createFocusPolicyMutationPreview({
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    update: input,
    now,
  })
  const teamPolicies = target.type === 'team'
    ? [
        ...state.teamPolicies.filter((policy) =>
          policy.target.type !== 'team' || policy.target.teamId !== target.teamId
        ),
        preview,
      ]
    : state.teamPolicies
  const userPolicy = target.type === 'user' ? preview : state.userPolicy
  const effectivePolicyTeamIds = target.type === 'team'
    ? [target.teamId]
    : accessibleTeamIds
  const effectivePolicies = resolveFocusEffectivePolicies({
    teamIds: effectivePolicyTeamIds,
    teamPolicies,
    ...(userPolicy === undefined ? {} : { userPolicy }),
  })
  const policyConditionChecks = [
    ...effectivePolicyTeamIds
      .filter((teamId) => target.type !== 'team' || teamId !== target.teamId)
      .map((teamId) => {
        const teamPolicy = state.teamPolicies.find((policy) =>
          policy.target.type === 'team' && policy.target.teamId === teamId
        )
        return createFocusPolicyRevisionConditionCheck(
          principal.directoryId,
          principal.userKey,
          { type: 'team', teamId },
          teamPolicy?.version ?? 0,
        )
      }),
    ...(target.type === 'team'
      ? [createFocusPolicyRevisionConditionCheck(
          principal.directoryId,
          principal.userKey,
          { type: 'user' },
          state.userPolicy?.version ?? 0,
        )]
      : []),
  ]
  const mutationIdentity = createFocusMutationRecoveryIdentity(
    request,
    'policy',
    targetIdentity,
    { policy: createFocusPolicyRecoveryEvidence(preview) },
  )
  const storedPolicy = target.type === 'user'
    ? state.userPolicy
    : state.teamPolicies.find((policy) =>
        policy.target.type === 'team' && policy.target.teamId === target.teamId
      )
  const storedMutationIdentity = target.type === 'user'
    ? state.userPolicyMutationIdentity
    : state.teamPolicyMutationIdentities[target.teamId]
  const committedPolicy =
    storedMutationIdentity === mutationIdentity &&
    storedPolicy !== undefined &&
    stableDigestStringify(createFocusPolicyRecoveryEvidence(storedPolicy)) ===
      stableDigestStringify(createFocusPolicyRecoveryEvidence(preview))
      ? storedPolicy
      : undefined

  return {
    committedPolicy,
    effectivePolicies,
    mutationIdentity,
    policyConditionChecks,
  }
}

/**
 * Re-reads every policy layer contributing to a successful policy response.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param input - Validated policy replacement.
 * @param expectedEffectivePolicies - Effective policies computed before the write.
 * @returns Effective policies verified against the post-write snapshot.
 */
async function readAndVerifyFocusPolicyEffectivePolicies(
  principal: WorkspacePrincipal,
  input: UpdateFocusPolicyInput,
  expectedEffectivePolicies: readonly FocusEffectivePolicy[],
): Promise<FocusEffectivePolicy[]> {
  const accessibleTeamIds = await readFocusAccessibleTeamIds(principal)
  const teamIds = input.target.type === 'team'
    ? [input.target.teamId]
    : accessibleTeamIds
  const expectedTeamIds = expectedEffectivePolicies.flatMap((policy) =>
    policy.teamId === undefined ? [] : [policy.teamId]
  )
  if (stableDigestStringify(teamIds) !== stableDigestStringify(expectedTeamIds)) {
    throw focusPolicyContributingStateChanged()
  }

  const state = await workItemDependencies.focusState.getState({
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    teamIds,
  })
  const effectivePolicies = resolveFocusEffectivePolicies({
    teamIds,
    teamPolicies: state.teamPolicies,
    ...(state.userPolicy === undefined ? {} : { userPolicy: state.userPolicy }),
  })
  const expectedOutcome = expectedEffectivePolicies.map((policy) => ({
    teamId: policy.teamId,
    fingerprint: policy.fingerprint,
  }))
  const currentOutcome = effectivePolicies.map((policy) => ({
    teamId: policy.teamId,
    fingerprint: policy.fingerprint,
  }))
  if (stableDigestStringify(currentOutcome) !== stableDigestStringify(expectedOutcome)) {
    throw focusPolicyContributingStateChanged()
  }
  return effectivePolicies
}

/** Creates the conflict returned when a contributing Focus policy layer changes mid-write. */
function focusPolicyContributingStateChanged(): FocusApiError {
  return new FocusApiError(
    409,
    'FocusPolicyContributingStateChanged',
    'A contributing Focus policy changed during the mutation. Reload and try again.',
  )
}

/**
 * Selects policy fields whose values are independent from the retry clock.
 *
 * @param policy - Stored or predicted policy.
 * @returns Canonical recovery evidence excluding the mutation timestamp.
 */
function createFocusPolicyRecoveryEvidence(policy: FocusPolicy) {
  return {
    schemaVersion: policy.schemaVersion,
    id: policy.id,
    target: policy.target,
    version: policy.version,
    overrides: policy.overrides,
  }
}

/**
 * Creates a durable marker that binds a domain write to one exact logical request.
 *
 * @param request - Actor-scoped reservation identity.
 * @param operation - Focus mutation kind.
 * @param targetIdentity - Opaque identity of the mutation target.
 * @param evidence - Operation-specific observable state that must remain unchanged.
 * @returns Lowercase SHA-256 mutation identity.
 */
function createFocusMutationRecoveryIdentity(
  request: ReserveIdempotencyRequest,
  operation: FocusMutationReceiptOperation,
  targetIdentity: string,
  evidence: unknown,
): string {
  return createHash('sha256').update(stableDigestStringify({
    credentialId: request.credentialId,
    idempotencyKey: request.idempotencyKey,
    operation,
    requestFingerprint: request.requestFingerprint,
    targetIdentity,
    workspaceId: request.workspaceId,
    evidence,
  })).digest('hex')
}

/**
 * Creates retry-stable evidence for one item mutation while omitting its own effects.
 *
 * @param request - Actor-scoped reservation identity.
 * @param operation - Snooze or watcher operation.
 * @param targetIdentity - Opaque Work Item target identity.
 * @param item - Current permission-filtered Focus item.
 * @param effectivePolicyFingerprint - Current effective policy fingerprint.
 * @returns Lowercase SHA-256 mutation identity.
 */
function createFocusItemMutationRecoveryIdentity(
  request: ReserveIdempotencyRequest,
  operation: 'snooze' | 'watch',
  targetIdentity: string,
  item: FocusItem,
  effectivePolicyFingerprint: string,
): string {
  const signals = item.signals.map((signal) => ({
    ...signal,
    freshness: {
      ...(signal.freshness.validUntil === undefined
        ? {}
        : { validUntil: signal.freshness.validUntil }),
      ...(signal.freshness.sourceVersion === undefined
        ? {}
        : { sourceVersion: signal.freshness.sourceVersion }),
    },
  }))
  const operationStableEvidence = operation === 'snooze'
    ? { watching: item.watching }
    : {
        section: item.section,
        snoozeRevision: item.snoozeRevision,
        snoozedUntil: item.snoozedUntil ?? null,
      }
  return createFocusMutationRecoveryIdentity(
    request,
    operation,
    targetIdentity,
    {
      actionability: item.actionability,
      capabilities: item.capabilities,
      effectivePolicyFingerprint,
      effectivePolicyId: item.effectivePolicyId,
      id: item.id,
      operationStableEvidence,
      rank: item.rank,
      schemaVersion: item.schemaVersion,
      signals,
      workItem: item.workItem,
    },
  )
}

/**
 * Finds the exact snooze row produced by one previously committed logical request.
 *
 * @param state - Current recipient Focus state.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @param mutationIdentity - Expected durable mutation marker.
 * @param snoozedUntil - Desired wake time, or null for an unsnooze tombstone.
 * @param causeFingerprint - Current exact signal-cause fingerprint.
 * @returns Matching committed snooze row, or undefined.
 */
function findCommittedFocusSnooze(
  state: FocusStateSnapshot,
  teamId: string,
  workItemId: string,
  mutationIdentity: string,
  snoozedUntil: string | null,
  causeFingerprint: string,
): FocusSnoozeRecord | undefined {
  return state.snoozes.find((record) =>
    record.teamId === teamId &&
    record.workItemId === workItemId &&
    record.mutationIdentity === mutationIdentity &&
    record.causeFingerprint === causeFingerprint &&
    (record.snoozedUntil ?? null) === snoozedUntil
  )
}

/**
 * Resolves the effective policy evidence referenced by one Focus item.
 *
 * @param queue - Queue snapshot containing the policy collection.
 * @param item - Item whose policy reference must resolve exactly.
 * @returns Current effective policy fingerprint.
 */
function requireFocusEffectivePolicyFingerprint(
  queue: FocusQueueResponse,
  item: FocusItem,
): string {
  const policy = queue.effectivePolicies.find((candidate) =>
    candidate.id === item.effectivePolicyId &&
    candidate.teamId === item.workItem.teamId
  )
  if (policy === undefined) throw focusIdempotencyUnavailable()
  return policy.fingerprint
}

/**
 * Rebuilds a Focus item with the original evaluation clock of a recovered mutation.
 *
 * @param item - Current item whose observable state matched the committed marker.
 * @param evaluatedAt - Persisted canonical mutation timestamp.
 * @returns Detached item matching the original response clock.
 */
function restoreFocusItemEvaluationTime(
  item: FocusItem,
  evaluatedAt: string,
): FocusItem {
  if (!isStoredFocusTimestamp(evaluatedAt)) throw focusIdempotencyUnavailable()
  return {
    ...item,
    signals: item.signals.map((signal) => ({
      ...signal,
      freshness: {
        ...signal.freshness,
        evaluatedAt,
      },
    })),
    updatedAt: evaluatedAt,
  }
}

/**
 * Reserves one Focus mutation and maps persistence failures to the Focus API contract.
 *
 * @param request - Actor-scoped reservation identity.
 * @returns Reservation, in-progress, or completed replay decision.
 */
async function reserveFocusMutation(request: ReserveIdempotencyRequest) {
  try {
    return await developerPlatformDependencies.idempotency.reserveIdempotency(request)
  } catch (error) {
    if (error instanceof DeveloperPlatformError && error.code === 'IdempotencyKeyConflict') {
      throw new FocusApiError(
        409,
        'FocusIdempotencyConflict',
        'Idempotency-Key was already used for a different Focus mutation.',
      )
    }
    throw focusIdempotencyUnavailable()
  }
}

/** Creates the stable conflict returned while an equivalent Focus mutation is processing. */
function focusIdempotencyInProgress(): FocusApiError {
  return new FocusApiError(
    409,
    'FocusIdempotencyInProgress',
    'An equivalent Focus mutation is still processing.',
  )
}

/** Creates the stable failure returned when Focus idempotency persistence is unavailable. */
function focusIdempotencyUnavailable(): FocusApiError {
  return new FocusApiError(
    503,
    'FocusIdempotencyUnavailable',
    'Focus mutation idempotency is unavailable.',
  )
}

/**
 * Creates the ownership token used to complete or release one reservation.
 *
 * @param request - Original reservation identity.
 * @param reservationId - Reservation ownership identifier.
 * @returns Complete immutable mutation token.
 */
function createFocusIdempotencyMutationToken(
  request: ReserveIdempotencyRequest,
  reservationId: string,
): IdempotencyMutationToken {
  return {
    credentialId: request.credentialId,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    reservationId,
  }
}

/**
 * Releases one pre-write Focus reservation without masking the original failure.
 *
 * @param request - Original reservation identity.
 * @param token - Reservation ownership token.
 */
async function releaseFocusMutationReservation(
  request: ReserveIdempotencyRequest,
  token: IdempotencyMutationToken,
): Promise<void> {
  const release = {
    ...request,
    reservationId: token.reservationId,
  } satisfies ReleaseIdempotencyRequest
  await developerPlatformDependencies.idempotency
    .releaseIdempotency(release)
    .catch(() => undefined)
}

/**
 * Completes one Focus reservation with a compact server-owned outcome.
 *
 * @param request - Original reservation identity.
 * @param token - Reservation ownership token.
 * @param operation - Committed Focus operation.
 * @param targetIdentity - Opaque identity of the committed target.
 * @param outcome - Closed operation-specific result evidence.
 */
async function completeFocusMutationReceipt(
  request: ReserveIdempotencyRequest,
  token: IdempotencyMutationToken,
  operation: FocusMutationReceiptOperation,
  targetIdentity: string,
  outcome: Readonly<Record<string, unknown>>,
): Promise<void> {
  const receipt = {
    schema: FOCUS_MUTATION_RECEIPT_SCHEMA,
    version: FOCUS_MUTATION_RECEIPT_VERSION,
    workspaceId: request.workspaceId,
    operation,
    targetIdentity,
    status: 200,
    outcome,
  }
  try {
    await developerPlatformDependencies.idempotency.completeIdempotency({
      ...request,
      reservationId: token.reservationId,
      response: { status: 200, body: receipt },
    })
  } catch {
    throw focusIdempotencyUnavailable()
  }
}

/**
 * Completes one policy reservation with compact committed revision evidence.
 *
 * @param request - Original reservation identity.
 * @param token - Reservation ownership token.
 * @param targetIdentity - Opaque identity of the committed policy target.
 * @param policy - Server-produced committed policy.
 * @param effectivePolicies - Server-produced effective policies returned initially.
 */
async function completeFocusPolicyMutationReceipt(
  request: ReserveIdempotencyRequest,
  token: IdempotencyMutationToken,
  targetIdentity: string,
  policy: FocusPolicy,
  effectivePolicies: readonly FocusEffectivePolicy[],
): Promise<void> {
  if (!isStoredFocusTimestamp(policy.updatedAt)) {
    throw focusIdempotencyUnavailable()
  }
  const effectivePolicyOutcomes = effectivePolicies.map((effectivePolicy) => {
    if (effectivePolicy.teamId === undefined) {
      throw focusIdempotencyUnavailable()
    }
    return {
      teamId: effectivePolicy.teamId,
      fingerprint: effectivePolicy.fingerprint,
    }
  })
  await completeFocusMutationReceipt(
    request,
    token,
    'policy',
    targetIdentity,
    {
      kind: 'policy',
      policyVersion: policy.version,
      policyUpdatedAt: policy.updatedAt,
      effectivePolicies: effectivePolicyOutcomes,
    },
  )
}

/**
 * Completes one item reservation with compact observable state evidence.
 *
 * @param request - Original reservation identity.
 * @param token - Reservation ownership token.
 * @param operation - Snooze or watcher mutation.
 * @param targetIdentity - Opaque identity of the committed Work Item.
 * @param item - Server-produced item returned initially.
 */
async function completeFocusItemMutationReceipt(
  request: ReserveIdempotencyRequest,
  token: IdempotencyMutationToken,
  operation: 'snooze' | 'watch',
  targetIdentity: string,
  item: FocusItem,
): Promise<void> {
  if (
    !isStoredFocusTimestamp(item.updatedAt) ||
    item.signals.some((signal) => signal.freshness.evaluatedAt !== item.updatedAt)
  ) {
    throw focusIdempotencyUnavailable()
  }
  await completeFocusMutationReceipt(
    request,
    token,
    operation,
    targetIdentity,
    {
      kind: operation,
      itemVersion: item.version,
      snoozeRevision: item.snoozeRevision,
      watching: item.watching,
      snoozedUntil: item.snoozedUntil ?? null,
      evaluatedAt: item.updatedAt,
    },
  )
}

/** Creates the stable failure used when a stored Focus receipt is malformed. */
function invalidStoredFocusMutationReceipt(): FocusApiError {
  return new FocusApiError(
    503,
    'InvalidStoredFocusMutationReceipt',
    'The stored Focus mutation receipt is invalid.',
  )
}

/**
 * Strictly validates one stored Focus mutation receipt envelope.
 *
 * @param value - Candidate replay response from the shared idempotency port.
 * @param workspaceId - Expected opaque Workspace reservation identity.
 * @param operation - Expected Focus mutation operation.
 * @param targetIdentity - Expected opaque mutation target identity.
 * @returns Closed operation-specific outcome for further strict validation.
 */
function readStoredFocusMutationReceipt(
  value: unknown,
  workspaceId: string,
  operation: FocusMutationReceiptOperation,
  targetIdentity: string,
): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.body)) {
    throw invalidStoredFocusMutationReceipt()
  }
  const body = value.body
  const outcomeCandidate = body.outcome
  if (!isRecord(outcomeCandidate)) {
    throw invalidStoredFocusMutationReceipt()
  }
  const outcome = outcomeCandidate
  const receipt = {
    schema: FOCUS_MUTATION_RECEIPT_SCHEMA,
    version: FOCUS_MUTATION_RECEIPT_VERSION,
    workspaceId,
    operation,
    targetIdentity,
    status: 200,
    outcome,
  }
  if (
    value.status !== 200 ||
    body.schema !== FOCUS_MUTATION_RECEIPT_SCHEMA ||
    body.version !== FOCUS_MUTATION_RECEIPT_VERSION ||
    body.workspaceId !== workspaceId ||
    body.operation !== operation ||
    body.targetIdentity !== targetIdentity ||
    body.status !== 200 ||
    stableDigestStringify({ status: 200, body: receipt }) !== stableDigestStringify(value)
  ) {
    throw invalidStoredFocusMutationReceipt()
  }
  return outcome
}

/**
 * Tests whether a stored Focus timestamp is canonical ISO 8601 UTC.
 *
 * @param value - Candidate timestamp.
 * @returns Whether the value round-trips through Date unchanged.
 */
function isStoredFocusTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const epoch = Date.parse(value)
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value
}

/**
 * Strictly reads the compact result of one policy mutation.
 *
 * @param value - Candidate operation-specific receipt outcome.
 * @returns Committed policy revision and effective policy fingerprints.
 */
function readStoredFocusPolicyOutcome(value: Record<string, unknown>) {
  if (
    value.kind !== 'policy' ||
    typeof value.policyVersion !== 'number' ||
    !Number.isSafeInteger(value.policyVersion) ||
    value.policyVersion < 1 ||
    !isStoredFocusTimestamp(value.policyUpdatedAt) ||
    !Array.isArray(value.effectivePolicies) ||
    value.effectivePolicies.length > WORK_ITEMS_TEAM_READ_LIMIT
  ) {
    throw invalidStoredFocusMutationReceipt()
  }
  const effectivePolicies: Array<{ teamId: string; fingerprint: string }> = []
  const teamIds = new Set<string>()
  for (const entry of value.effectivePolicies) {
    if (
      !isRecord(entry) ||
      typeof entry.teamId !== 'string' ||
      !entry.teamId ||
      entry.teamId !== entry.teamId.trim() ||
      entry.teamId.length > 256 ||
      typeof entry.fingerprint !== 'string' ||
      !entry.fingerprint ||
      entry.fingerprint !== entry.fingerprint.trim() ||
      entry.fingerprint.length > 512
    ) {
      throw invalidStoredFocusMutationReceipt()
    }
    const normalized = {
      teamId: entry.teamId,
      fingerprint: entry.fingerprint,
    }
    if (
      teamIds.has(entry.teamId) ||
      stableDigestStringify(normalized) !== stableDigestStringify(entry)
    ) {
      throw invalidStoredFocusMutationReceipt()
    }
    teamIds.add(entry.teamId)
    effectivePolicies.push(normalized)
  }
  const normalizedOutcome = {
    kind: 'policy',
    policyVersion: value.policyVersion,
    policyUpdatedAt: value.policyUpdatedAt,
    effectivePolicies,
  }
  if (stableDigestStringify(normalizedOutcome) !== stableDigestStringify(value)) {
    throw invalidStoredFocusMutationReceipt()
  }
  return {
    policyVersion: value.policyVersion,
    policyUpdatedAt: value.policyUpdatedAt,
    effectivePolicies,
  }
}

/** Creates the stable conflict returned when committed Focus state has since changed. */
function focusIdempotencyReplayChanged(): FocusApiError {
  return new FocusApiError(
    409,
    'FocusIdempotencyReplayChanged',
    'Focus state changed after the original mutation. Reload and try again.',
  )
}

/**
 * Reconstructs a policy replay from current authorized state and compact receipt evidence.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param input - Request input bound to the receipt fingerprint.
 * @param value - Strict receipt envelope outcome.
 * @returns Current server-produced response matching the original committed outcome.
 */
async function replayFocusPolicyMutation(
  principal: WorkspacePrincipal,
  input: UpdateFocusPolicyInput,
  value: Record<string, unknown>,
): Promise<UpdateFocusPolicyResponse> {
  const outcome = readStoredFocusPolicyOutcome(value)
  const effectivePolicyTeamIds = outcome.effectivePolicies.map((policy) => policy.teamId)
  if (input.target.type === 'team') {
    if (
      effectivePolicyTeamIds.length !== 1 ||
      effectivePolicyTeamIds[0] !== input.target.teamId
    ) {
      throw invalidStoredFocusMutationReceipt()
    }
  } else {
    const accessibleTeamIds = await readFocusAccessibleTeamIds(principal)
    if (
      stableDigestStringify([...effectivePolicyTeamIds].sort()) !==
        stableDigestStringify(accessibleTeamIds)
    ) {
      throw new FocusApiError(
        403,
        'FocusPolicyReplayAccessChanged',
        'Focus policy access changed after the original mutation.',
      )
    }
  }

  const state = await workItemDependencies.focusState.getState({
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    teamIds: effectivePolicyTeamIds,
  })
  let policy: FocusPolicy | undefined
  if (input.target.type === 'user') {
    policy = state.userPolicy
  } else {
    const teamId = input.target.teamId
    policy = state.teamPolicies.find((candidate) =>
      candidate.target.type === 'team' && candidate.target.teamId === teamId
    )
  }
  if (
    policy === undefined ||
    policy.version !== input.expectedVersion + 1 ||
    policy.version !== outcome.policyVersion ||
    policy.updatedAt !== outcome.policyUpdatedAt ||
    stableDigestStringify(policy.target) !== stableDigestStringify(input.target) ||
    stableDigestStringify(policy.overrides) !== stableDigestStringify(input.overrides)
  ) {
    throw focusIdempotencyReplayChanged()
  }
  const effectivePolicies = resolveFocusEffectivePolicies({
    teamIds: effectivePolicyTeamIds,
    teamPolicies: state.teamPolicies,
    ...(state.userPolicy === undefined ? {} : { userPolicy: state.userPolicy }),
  })
  const currentOutcome = effectivePolicies.map((effectivePolicy) => ({
    teamId: effectivePolicy.teamId,
    fingerprint: effectivePolicy.fingerprint,
  }))
  if (
    stableDigestStringify(currentOutcome) !==
      stableDigestStringify(outcome.effectivePolicies)
  ) {
    throw focusIdempotencyReplayChanged()
  }
  return { policy, effectivePolicies }
}

/**
 * Strictly reads the compact result of one item mutation.
 *
 * @param value - Candidate operation-specific receipt outcome.
 * @param operation - Expected snooze or watcher operation.
 * @returns Committed item version, state, and original evaluation clock.
 */
function readStoredFocusItemOutcome(
  value: Record<string, unknown>,
  operation: 'snooze' | 'watch',
) {
  if (
    value.kind !== operation ||
    typeof value.itemVersion !== 'number' ||
    !Number.isSafeInteger(value.itemVersion) ||
    value.itemVersion < 1 ||
    typeof value.snoozeRevision !== 'number' ||
    !Number.isSafeInteger(value.snoozeRevision) ||
    value.snoozeRevision < 0 ||
    typeof value.watching !== 'boolean' ||
    (value.snoozedUntil !== null && !isStoredFocusTimestamp(value.snoozedUntil)) ||
    !isStoredFocusTimestamp(value.evaluatedAt)
  ) {
    throw invalidStoredFocusMutationReceipt()
  }
  const normalizedOutcome = {
    kind: operation,
    itemVersion: value.itemVersion,
    snoozeRevision: value.snoozeRevision,
    watching: value.watching,
    snoozedUntil: value.snoozedUntil,
    evaluatedAt: value.evaluatedAt,
  }
  if (stableDigestStringify(normalizedOutcome) !== stableDigestStringify(value)) {
    throw invalidStoredFocusMutationReceipt()
  }
  return {
    itemVersion: value.itemVersion,
    snoozeRevision: value.snoozeRevision,
    watching: value.watching,
    snoozedUntil: value.snoozedUntil,
    evaluatedAt: value.evaluatedAt,
  }
}

/**
 * Reconstructs one item replay from the current authorized projection.
 *
 * @param current - Current permission-filtered and strongly reauthorized item.
 * @param operation - Expected snooze or watcher operation.
 * @param value - Strict receipt envelope outcome.
 * @returns Server-produced item with the original successful evaluation clock.
 */
function replayFocusItemMutation(
  current: FocusItem,
  operation: 'snooze' | 'watch',
  value: Record<string, unknown>,
): FocusItem {
  const outcome = readStoredFocusItemOutcome(value, operation)
  if (
    current.version !== outcome.itemVersion ||
    current.snoozeRevision !== outcome.snoozeRevision ||
    current.watching !== outcome.watching ||
    (current.snoozedUntil ?? null) !== outcome.snoozedUntil
  ) {
    throw focusIdempotencyReplayChanged()
  }
  return {
    ...current,
    signals: current.signals.map((signal) => ({
      ...signal,
      freshness: {
        ...signal.freshness,
        evaluatedAt: outcome.evaluatedAt,
      },
    })),
    updatedAt: outcome.evaluatedAt,
  }
}

/**
 * Maps Focus source, persistence, and validation failures to existing API errors.
 *
 * @param context - Current Hono request context.
 * @param error - Unknown route failure.
 * @returns Safe HTTP response.
 */
function toFocusErrorResponse(context: Context, error: unknown): Response {
  if (error instanceof CognitoServiceError) {
    return toCognitoDirectoryErrorResponse(context, error)
  }
  if (error instanceof WorkspaceAccessError || error instanceof ProjectDataError) {
    return toProjectDataErrorResponse(context, error)
  }
  if (error instanceof PlanningError) {
    return toPlanningErrorResponse(context, error)
  }
  if (error instanceof FileProofingError) {
    return toFileProofingErrorResponse(context, error)
  }
  if (error instanceof NotificationError) {
    return toNotificationErrorResponse(context, error)
  }
  if (error instanceof CollaborationError) {
    return toCollaborationErrorResponse(context, error)
  }
  if (error instanceof FocusApiError || error instanceof FocusStateError) {
    if (error.status >= 500) console.error(error)
    switch (error.status) {
      case 400: return context.json({ code: error.code, message: error.message }, 400)
      case 403: return context.json({ code: error.code, message: error.message }, 403)
      case 404: return context.json({ code: error.code, message: error.message }, 404)
      case 409: return context.json({ code: error.code, message: error.message }, 409)
      case 413: return context.json({ code: error.code, message: error.message }, 413)
      case 503: return context.json({ code: error.code, message: error.message }, 503)
      default: return context.json({ code: 'FocusUnavailable', message: 'Focus queue is unavailable.' }, 502)
    }
  }
  console.error(error)
  return context.json(
    { code: 'FocusUnavailable', message: 'Focus queue is unavailable.' },
    502,
  )
}

/**
 * Reads every canonical source needed to build one permission-filtered Focus queue.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param now - Stable evaluation clock shared by the complete projection.
 * @returns A deterministic queue containing only currently authorized sources.
 */
async function readFocusQueue(
  principal: WorkspacePrincipal,
  now: Date,
): Promise<FocusQueueResponse> {
  const { workItems: accessibleWorkItems } = await readAccessibleWorkItems(principal)
  const workItemsPromise = hydrateFocusApprovalSummaries(
    principal,
    accessibleWorkItems,
  )
  const accessibleTeamIdsPromise = readFocusAccessibleTeamIds(principal)
  const planningWorkItems = createFocusPlanningWorkItemState(accessibleWorkItems)
  const planningPromise = workItemDependencies.planning
    .get(principal.directoryId, planningWorkItems)
    .then((planning) => filterFocusPlanningSnapshotForPrincipal(
      principal,
      planning,
      accessibleWorkItems,
    ))
  const relationGraphsPromise = readFocusRelationGraphs(
    principal.directoryId,
    accessibleWorkItems,
  )
  const approvalsPromise = readFocusReviewerApprovals(principal, accessibleWorkItems)
  const notificationsPromise = readFocusNotifications(principal, now)
  const workItemPermissionsPromise = readFocusWorkItemPermissionsByKey(
    principal,
    accessibleWorkItems,
  )
  const accessibleTeamIds = await accessibleTeamIdsPromise
  const editableTeamPolicyIdsPromise = readFocusEditableTeamPolicyIds(
    principal,
    accessibleTeamIds,
  )
  const statePromise = workItemDependencies.focusState.getState({
    workspaceId: principal.directoryId,
    memberKey: principal.userKey,
    teamIds: accessibleTeamIds,
  })
  const [
    workItems,
    planning,
    relationGraphs,
    reviewerApprovals,
    notifications,
    workItemPermissions,
    editableTeamPolicyIds,
    state,
  ] =
    await Promise.all([
      workItemsPromise,
      planningPromise,
      relationGraphsPromise,
      approvalsPromise,
      notificationsPromise,
      workItemPermissionsPromise,
      editableTeamPolicyIdsPromise,
      statePromise,
    ])
  const baseInput: CreateFocusQueueInput = {
    now,
    viewerMemberKey: principal.userKey,
    workItems,
    planning,
    relationGraphs,
    reviewerApprovals,
    notifications,
    teamPolicies: state.teamPolicies,
    policyTeamIds: accessibleTeamIds,
    editableTeamPolicyIds,
    ...(state.userPolicy === undefined ? {} : { userPolicy: state.userPolicy }),
    snoozeRecords: state.snoozes,
    canApproveByWorkItemKey: workItemPermissions.canApproveByWorkItemKey,
    canWriteByWorkItemKey: workItemPermissions.canWriteByWorkItemKey,
    canWatchByWorkItemKey: workItemPermissions.canWatchByWorkItemKey,
    watchingByWorkItemKey: {},
  }
  const candidateQueue = createFocusQueue(baseInput)
  const candidateItems = candidateQueue.sections.flatMap((section) => section.items)
  const watchingByWorkItemKey = await readFocusWatchingByWorkItemKey(
    principal,
    candidateItems,
  )
  return createFocusQueue({ ...baseInput, watchingByWorkItemKey })
}

/**
 * Reads one authoritative relation graph per visible Team.
 *
 * @param workspaceId - Workspace that owns the relation graphs.
 * @param workItems - Current ACL-filtered canonical Work Items.
 * @returns Endpoint-filtered Team graphs.
 */
async function readFocusRelationGraphs(
  workspaceId: string,
  workItems: readonly CanonicalWorkItem[],
): Promise<FocusRelationGraphSource[]> {
  const configuration = workItemDependencies.workItemConfigurations
  const visibleIdsByTeam = new Map<string, Set<string>>()
  for (const workItem of workItems) {
    const visibleIds = visibleIdsByTeam.get(workItem.teamId) ?? new Set<string>()
    visibleIds.add(workItem.id)
    visibleIdsByTeam.set(workItem.teamId, visibleIds)
  }
  return Promise.all([...visibleIdsByTeam.entries()]
    .sort(([leftTeamId], [rightTeamId]) => leftTeamId.localeCompare(rightTeamId))
    .map(async ([teamId, visibleIds]) => {
      const graph = await configuration.listRelationGraph(workspaceId, teamId)
      return {
        teamId,
        graphRevision: graph.graphRevision,
        relations: graph.relations.filter((relation) =>
          visibleIds.has(relation.sourceWorkItemId) &&
          visibleIds.has(relation.targetWorkItemId)
        ),
      }
    }))
}

/**
 * Builds the Planning Work Item projection from the exact canonical Focus snapshot.
 *
 * @param workItems - Current ACL-filtered canonical Work Items.
 * @returns Planning input bound to the same Work Item revisions.
 */
function createFocusPlanningWorkItemState(
  workItems: readonly CanonicalWorkItem[],
): PlanningWorkItemState {
  return {
    workItems: workItems.map((workItem) => ({
      id: workItem.id,
      revision: workItem.revision,
      teamId: workItem.teamId,
      title: workItem.title,
      ...(workItem.assignedProjectId
        ? { projectId: workItem.assignedProjectId }
        : {}),
      statusCategory: workItem.statusCategory,
      dueDate: workItem.dueDate,
      schedule: workItem.schedule,
    } satisfies PlanningWorkItemSummary)),
  }
}

/**
 * Re-evaluates a Focus source permission at its canonical resource scope.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param permission - Independent source permission required by the projection.
 * @param teamId - Canonical owner Team when the source is Team or Project scoped.
 * @param projectId - Canonical Project when the source is Project scoped.
 * @returns Whether the source may contribute data to the Focus projection.
 */
function canReadFocusScopedSource(
  principal: WorkspacePrincipal,
  permission: 'planning.read' | 'files.read',
  teamId?: string,
  projectId?: string,
): boolean {
  if (principal.isSystemAdmin) return true
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) {
    return principal.enterpriseLegacyProjectAccessSuppressed !== true
  }
  if (projectId !== undefined && teamId === undefined) return false
  const resource: EnterpriseAuthorizationResource = projectId !== undefined
    ? {
        workspaceId: principal.directoryId,
        kind: 'project',
        targetId: projectId,
        parentTeamId: teamId,
      }
    : teamId !== undefined
      ? {
          workspaceId: principal.directoryId,
          kind: 'team',
          targetId: teamId,
        }
      : {
          workspaceId: principal.directoryId,
          kind: 'workspace',
        }
  return evaluateEnterpriseAccess({
    permission,
    principal: evaluation.principal,
    assignments: evaluation.assignments,
    customRoles: evaluation.snapshot.customRoles,
    groupMappings: evaluation.groupMappings,
    resource,
  }).allowed
}

/**
 * Attaches approval aggregates only to Work Items whose Files source is readable.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param workItems - Current ACL-filtered canonical Work Items.
 * @returns Detached Work Items with permission-safe approval summaries.
 */
async function hydrateFocusApprovalSummaries(
  principal: WorkspacePrincipal,
  workItems: readonly CanonicalWorkItem[],
): Promise<CanonicalWorkItem[]> {
  const sanitizedWorkItems = workItems.map((workItem) => {
    const sanitized = { ...workItem }
    delete sanitized.approvalSummary
    return sanitized
  })
  if (!getEnv('FILE_PROOFING_TABLE_NAME') && !getConfiguredDynamoDbEndpoint()) {
    return sanitizedWorkItems
  }
  const scopes: FileProofingScope[] = sanitizedWorkItems
    .filter((workItem) => canReadFocusScopedSource(
      principal,
      'files.read',
      workItem.teamId,
      workItem.assignedProjectId,
    ))
    .map((workItem) => ({
      workspaceId: principal.directoryId,
      teamId: workItem.teamId,
      kind: 'work-item',
      issueId: workItem.id,
    }))
  if (scopes.length === 0) return sanitizedWorkItems
  const summaries = await workItemDependencies.fileProofing.getApprovalSummaries(scopes)
  return sanitizedWorkItems.map((workItem) => {
    const summary = summaries.get(createFileProofingScopeKey({
      workspaceId: principal.directoryId,
      teamId: workItem.teamId,
      kind: 'work-item',
      issueId: workItem.id,
    }))
    return summary !== undefined &&
        canReadFocusScopedSource(
          principal,
          'files.read',
          workItem.teamId,
          workItem.assignedProjectId,
        ) &&
        hasApprovalSummaryContent(summary)
      ? { ...workItem, approvalSummary: summary }
      : workItem
  })
}

/**
 * Removes Planning records whose independent source scope is not readable in Focus.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param snapshot - Complete Planning snapshot loaded from the canonical store.
 * @param workItems - Current ACL-filtered canonical Work Items.
 * @returns A detached Planning snapshot safe to use as Focus signal input.
 */
function filterFocusPlanningSnapshotForPrincipal(
  principal: WorkspacePrincipal,
  snapshot: PlanningSnapshot,
  workItems: readonly CanonicalWorkItem[],
): PlanningSnapshot {
  if (principal.isSystemAdmin) return snapshot
  const canonicalWorkItemsByKey = new Map(workItems.map((workItem) => [
    createFocusWorkItemKey(workItem.teamId, workItem.id),
    workItem,
  ]))
  const legacyReadableTeamIds = new Set(workItems.map((workItem) => workItem.teamId))
  const legacyReadableProjectIds = new Set(workItems.flatMap((workItem) =>
    workItem.assignedProjectId === undefined ? [] : [workItem.assignedProjectId]
  ))
  /** Restricts legacy sources to resources evidenced by the authorized Work Item window. */
  const canReadPlanningResource = (teamId?: string, projectId?: string) =>
    principal.enterpriseAuthorizationEvaluation === undefined
      ? principal.enterpriseLegacyProjectAccessSuppressed !== true &&
        teamId !== undefined &&
        legacyReadableTeamIds.has(teamId) &&
        (projectId === undefined || legacyReadableProjectIds.has(projectId))
      : canReadFocusScopedSource(
          principal,
          'planning.read',
          teamId,
          projectId,
        )
  const readableWorkItemKeys = new Set(workItems
    .filter((workItem) => canReadPlanningResource(
      workItem.teamId,
      workItem.assignedProjectId,
    ))
    .map((workItem) => createFocusWorkItemKey(workItem.teamId, workItem.id)))
  const planningWorkItems = snapshot.workItems.filter((workItem) => {
    const key = createFocusWorkItemKey(workItem.teamId, workItem.id)
    return canonicalWorkItemsByKey.has(key) && readableWorkItemKeys.has(key)
  })
  const workItemDependencies = snapshot.workItemDependencies.filter((dependency) =>
    readableWorkItemKeys.has(createFocusWorkItemKey(
      dependency.predecessor.teamId,
      dependency.predecessor.workItemId,
    )) &&
    readableWorkItemKeys.has(createFocusWorkItemKey(
      dependency.successor.teamId,
      dependency.successor.workItemId,
    ))
  )
  const entities = snapshot.entities.filter((entity) =>
    canReadPlanningResource(
      entity.teamId,
      entity.projectId,
    )
  )
  const entityIds = new Set(entities.map((entity) => entity.id))
  const scopedEntities = entities.map((entity) =>
    entity.parentId !== undefined && !entityIds.has(entity.parentId)
      ? { ...entity, parentId: undefined }
      : entity
  )
  const dependencies = snapshot.dependencies.filter((dependency) =>
    entityIds.has(dependency.predecessorId) && entityIds.has(dependency.successorId)
  )
  const workItemLinks = snapshot.workItemLinks
    .filter((link) => readableWorkItemKeys.has(
      createFocusWorkItemKey(link.teamId, link.workItemId),
    ))
    .map((link) => ({
      ...link,
      ...(link.cycleId !== undefined && entityIds.has(link.cycleId)
        ? {}
        : { cycleId: undefined }),
      ...(link.milestoneId !== undefined && entityIds.has(link.milestoneId)
        ? {}
        : { milestoneId: undefined }),
      goalIds: link.goalIds.filter((goalId) => entityIds.has(goalId)),
    }))
  const criticalEntityIds = snapshot.criticalPath.entityIds.filter((entityId) =>
    entityIds.has(entityId)
  )
  return {
    ...snapshot,
    entities: scopedEntities,
    dependencies,
    workItemDependencies,
    workItemLinks,
    workItems: planningWorkItems,
    criticalPath: {
      entityIds: criticalEntityIds,
      totalDurationDays: criticalEntityIds.length === snapshot.criticalPath.entityIds.length
        ? snapshot.criticalPath.totalDurationDays
        : 0,
      slackByEntityId: Object.fromEntries(
        Object.entries(snapshot.criticalPath.slackByEntityId)
          .filter(([entityId]) => entityIds.has(entityId)),
      ),
    },
    workItemDependencySummary: createPlanningWorkItemDependencySummary(
      workItemDependencies,
      planningWorkItems,
      workItemLinks,
    ),
  }
}

/**
 * Resolves all active Teams visible to the current principal.
 *
 * @param principal - Current authenticated Workspace principal.
 * @returns Stable accessible Team identifiers, including Teams without Work Items.
 */
async function readFocusAccessibleTeamIds(
  principal: WorkspacePrincipal,
): Promise<string[]> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
  )
  if (principal.isSystemAdmin) {
    return directory.teams.map((team) => team.id).sort()
  }
  const projectAccesses = await getEffectiveProjectAccessList(principal)
  const accessibleProjectIds = new Set(
    projectAccesses
      .filter((access) => projectAccessAllows(access, 'viewer'))
      .map((access) => access.projectId),
  )
  const authorizedTeamIds = new Set(principal.enterpriseAuthorizedTeamIds ?? [])
  return directory.teams
    .filter((team) =>
      authorizedTeamIds.has(team.id) ||
      team.projects.some((project) => accessibleProjectIds.has(project.id))
    )
    .map((team) => team.id)
    .sort()
}

/**
 * Resolves visible Teams whose policy layer the current principal may manage.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param accessibleTeamIds - Team identifiers already authorized for Focus reads.
 * @returns Stable subset authorized by system administration, Team grants, or manager roles.
 */
async function readFocusEditableTeamPolicyIds(
  principal: WorkspacePrincipal,
  accessibleTeamIds: readonly string[],
): Promise<string[]> {
  if (principal.workspaceRole === 'guest') return []
  if (principal.isSystemAdmin) return [...accessibleTeamIds].sort()
  const accessibleTeamIdSet = new Set(accessibleTeamIds)
  const enterpriseManagedTeamIds = new Set(
    (principal.enterpriseTeamAccesses ?? [])
      .filter((access) => access.permissions.includes('teams.manage'))
      .map((access) => access.teamId),
  )
  const managerProjectIds = new Set(
    (await getEffectiveProjectAccessList(principal))
      .filter((access) => projectAccessAllows(access, 'manager'))
      .map((access) => access.projectId),
  )
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
  )
  return directory.teams
    .filter((team) => accessibleTeamIdSet.has(team.id))
    .filter((team) =>
      enterpriseManagedTeamIds.has(team.id) ||
      team.projects.some((project) => managerProjectIds.has(project.id))
    )
    .map((team) => team.id)
    .sort()
}

/**
 * Computes current Work Item mutation permissions without trusting the route's read grant.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param workItems - Current ACL-filtered canonical Work Items.
 * @returns Independent write and watch permission maps keyed by qualified Work Item identity.
 */
async function readFocusWorkItemPermissionsByKey(
  principal: WorkspacePrincipal,
  workItems: readonly CanonicalWorkItem[],
) {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(
    principal.directoryId,
    'ja',
  )
  const projectAccesses = principal.isSystemAdmin
    ? []
    : await getEffectiveProjectAccessList(principal)
  const teamById = new Map(directory.teams.map((team) => [team.id, team]))
  const canWriteByWorkItemKey: Record<string, boolean> = {}
  const canApproveByWorkItemKey: Record<string, boolean> = {}
  const canWatchByWorkItemKey: Record<string, boolean> = {}

  for (const workItem of workItems) {
    const team = teamById.get(workItem.teamId)
    if (team === undefined) continue
    const teamProjectIds = new Set(team.projects.map((project) => project.id))
    const context: TeamPermissionContext = {
      team,
      directory,
      ...(principal.isSystemAdmin
        ? {}
        : {
            projectAccesses: projectAccesses.filter((access) =>
              teamProjectIds.has(access.projectId)
            ),
          }),
    }
    const key = createFocusWorkItemKey(workItem.teamId, workItem.id)
    canWriteByWorkItemKey[key] = canWriteFocusWorkItem(principal, context, workItem)
    canApproveByWorkItemKey[key] = canApproveFocusWorkItem(principal, context, workItem)
    canWatchByWorkItemKey[key] = canWatchFocusWorkItem(principal, context, workItem)
  }
  return { canApproveByWorkItemKey, canWatchByWorkItemKey, canWriteByWorkItemKey }
}

/**
 * Evaluates the canonical Work Item write permission for Focus capabilities.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param context - Current Team and Project authorization context.
 * @param workItem - Canonical Work Item whose write permission is evaluated.
 * @returns Whether current source state authorizes a Work Item mutation.
 */
function canWriteFocusWorkItem(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  workItem: CanonicalWorkItem,
): boolean {
  if (principal.workspaceRole === 'guest') return false
  if (principal.isSystemAdmin) return true
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) {
    return canWriteTeamIssue(principal, context, workItem.assignedProjectId)
  }
  if (
    workItem.assignedProjectId !== undefined &&
    !context.team.projects.some((project) => project.id === workItem.assignedProjectId)
  ) {
    return false
  }
  return evaluateEnterpriseAccess({
    permission: 'work-items.write',
    principal: evaluation.principal,
    assignments: evaluation.assignments,
    customRoles: evaluation.snapshot.customRoles,
    groupMappings: evaluation.groupMappings,
    resource: workItem.assignedProjectId === undefined
      ? {
          workspaceId: principal.directoryId,
          kind: 'team',
          targetId: workItem.teamId,
        }
      : {
          workspaceId: principal.directoryId,
          kind: 'project',
          targetId: workItem.assignedProjectId,
          parentTeamId: workItem.teamId,
        },
  }).allowed
}

/**
 * Evaluates the approval-decision permission for one Focus Work Item.
 *
 * @param principal - Authenticated Workspace principal whose approval access is evaluated.
 * @param context - Current Team and Project authorization context.
 * @param workItem - Canonical Work Item whose approval may be decided.
 * @returns Whether the current source state authorizes an approval decision.
 */
function canApproveFocusWorkItem(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  workItem: CanonicalWorkItem,
): boolean {
  if (principal.workspaceRole === 'guest') return false
  if (principal.isSystemAdmin) return true
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) {
    return principal.enterpriseLegacyProjectAccessSuppressed !== true
  }
  if (
    workItem.assignedProjectId !== undefined &&
    !context.team.projects.some((project) => project.id === workItem.assignedProjectId)
  ) {
    return false
  }
  return evaluateEnterpriseAccess({
    permission: 'files.approve',
    principal: evaluation.principal,
    assignments: evaluation.assignments,
    customRoles: evaluation.snapshot.customRoles,
    groupMappings: evaluation.groupMappings,
    resource: workItem.assignedProjectId === undefined
      ? {
          workspaceId: principal.directoryId,
          kind: 'team',
          targetId: workItem.teamId,
        }
      : {
          workspaceId: principal.directoryId,
          kind: 'project',
          targetId: workItem.assignedProjectId,
          parentTeamId: workItem.teamId,
        },
  }).allowed
}

/**
 * Evaluates the current canonical Work Item write permission for Focus watch changes.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param context - Current Team and Project authorization context.
 * @param workItem - Canonical Work Item whose watcher state may change.
 * @returns Whether the viewer may mutate their canonical watcher state.
 */
function canWatchFocusWorkItem(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  workItem: CanonicalWorkItem,
): boolean {
  return canWriteFocusWorkItem(principal, context, workItem)
}

/**
 * Requires current canonical watch permission before a Focus watch mutation.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param context - Strong-read Work Item Team and Project authorization context.
 * @param workItem - Current canonical Work Item after revision reauthorization.
 */
function requireFocusWorkItemWatchPermission(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  workItem: CanonicalWorkItem,
): void {
  if (canWatchFocusWorkItem(principal, context, workItem)) return
  throw new FocusApiError(
    403,
    'FocusWatchAccessDenied',
    'Current Work Item watch permission is required to change Focus watch state.',
  )
}

/**
 * Reads watcher state only for Work Items that survived Focus relevance projection.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param items - Current projected Focus items.
 * @returns Watch state keyed by Team-qualified Work Item identity.
 */
async function readFocusWatchingByWorkItemKey(
  principal: WorkspacePrincipal,
  items: readonly FocusItem[],
): Promise<Record<string, boolean>> {
  const uniqueItems = new Map(
    items.map((item) => [
      createFocusWorkItemKey(item.workItem.teamId, item.workItem.id),
      item,
    ]),
  )
  const watching: Record<string, boolean> = {}
  const entries = [...uniqueItems.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )
  for (const [key] of entries.slice(FOCUS_WATCHER_READ_LIMIT)) {
    watching[key] = false
  }
  const readableEntries = entries.slice(0, FOCUS_WATCHER_READ_LIMIT)
  for (
    let start = 0;
    start < readableEntries.length;
    start += FOCUS_WATCHER_READ_BATCH_SIZE
  ) {
    const batch = readableEntries.slice(start, start + FOCUS_WATCHER_READ_BATCH_SIZE)
    const states = await Promise.all(batch.map(async ([key, item]) => {
      const state = await workItemDependencies.collaboration.getMemberWatcherState({
        entityKey: createWorkItemCollaborationEntityKey(
          principal.directoryId,
          item.workItem.teamId,
          item.workItem.id,
        ),
        memberKey: principal.userKey,
        projectEntityKey: item.workItem.assignedProjectId
          ? createProjectCollaborationEntityKey(
              principal.directoryId,
              item.workItem.assignedProjectId,
            )
          : undefined,
      })
      return { key, subscribed: state.subscribed }
    }))
    for (const state of states) {
      watching[state.key] = state.subscribed
    }
  }
  return watching
}

/**
 * Requires a watcher mutation or bounded re-read to match the requested Focus state.
 *
 * @param actual - Watcher state observed after the write or bounded re-read.
 * @param expected - Watcher state requested by the client.
 */
function requireFocusWatchPostcondition(actual: boolean, expected: boolean): void {
  if (actual === expected) return
  throw new FocusApiError(
    409,
    'FocusWatchConflict',
    'Focus watch state changed concurrently. Reload and try again.',
  )
}

/**
 * Reads a bounded pending-approval window through Work Item and Files reauthorization.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param workItems - Current ACL-filtered canonical Work Items.
 * @returns Deduplicated pending approvals currently assigned to the viewer.
 */
async function readFocusReviewerApprovals(
  principal: WorkspacePrincipal,
  workItems: readonly CanonicalWorkItem[],
): Promise<ApprovalRequest[]> {
  const readableWorkItemKeys = new Set(workItems
    .filter((workItem) => canReadFocusScopedSource(
      principal,
      'files.read',
      workItem.teamId,
      workItem.assignedProjectId,
    ))
    .map((workItem) => createFocusWorkItemKey(workItem.teamId, workItem.id)))
  if (readableWorkItemKeys.size === 0) return []
  const approvals = new Map<string, ApprovalRequest>()
  const visitedCursors = new Set<string>()
  const sourcePageBudget = { remaining: FOCUS_APPROVAL_MAX_PAGES }
  let cursor: string | undefined
  do {
    const page = await listAuthorizedReviewerApprovals(principal, {
      limit: Math.min(
        FOCUS_APPROVAL_PAGE_LIMIT,
        FOCUS_APPROVAL_GLOBAL_LIMIT - approvals.size,
      ),
      ...(cursor === undefined ? {} : { cursor }),
    }, sourcePageBudget)
    for (const approval of page.approvals) {
      if (approvals.size >= FOCUS_APPROVAL_GLOBAL_LIMIT) break
      if (
        approval.teamId !== undefined &&
        approval.issueId !== undefined &&
        readableWorkItemKeys.has(createFocusWorkItemKey(
          approval.teamId,
          approval.issueId,
        )) &&
        !approvals.has(approval.id)
      ) {
        approvals.set(approval.id, approval)
      }
    }
    if (page.nextCursor !== undefined) {
      if (visitedCursors.has(page.nextCursor)) {
        throw new FocusApiError(
          503,
          'FocusApprovalCursorStalled',
          'Focus approvals could not advance to the next page.',
        )
      }
      visitedCursors.add(page.nextCursor)
    }
    cursor = page.nextCursor
  } while (
    cursor !== undefined &&
    sourcePageBudget.remaining > 0 &&
    approvals.size < FOCUS_APPROVAL_GLOBAL_LIMIT
  )
  if (cursor !== undefined) {
    throw new FocusApiError(
      503,
      'FocusApprovalReadLimitExceeded',
      'Focus approvals exceed the supported read window.',
    )
  }
  return [...approvals.values()]
}

/**
 * Reads bounded Inbox windows and deduplicates visible mention projections by event ID.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param now - Stable queue evaluation clock.
 * @returns Permission-filtered notification events independent of Inbox read state.
 */
async function readFocusNotifications(
  principal: WorkspacePrincipal,
  now: Date,
): Promise<NotificationItem[]> {
  const isVisible = await createNotificationVisibilityFilter(principal)
  const notifications = new Map<string, NotificationItem>()
  const commentSourceAvailability = new Map<string, boolean>()
  const cutoffTime = now.getTime() -
    FOCUS_NOTIFICATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000
  for (const filter of FOCUS_NOTIFICATION_FILTERS) {
    const visitedCursors = new Set<string>()
    let cursor: string | undefined
    let pagesRead = 0
    let cutoffReached = false
    do {
      const page = await workItemDependencies.notifications.list({
        workspaceId: principal.directoryId,
        memberKey: principal.userKey,
        filter,
        limit: FOCUS_NOTIFICATION_PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
        now,
        isVisible,
      })
      pagesRead += 1
      for (const notification of page.notifications) {
        const occurredAt = Date.parse(notification.occurredAt)
        // Notification pages are newest-first by their timestamp-prefixed key, so an old
        // item proves that later pages cannot contain an in-window mention.
        if (Number.isFinite(occurredAt) && occurredAt < cutoffTime) {
          cutoffReached = true
        }
        if (
          notification.reasons.includes('mention') &&
          notification.teamId !== undefined &&
          notification.issueId !== undefined &&
          Number.isFinite(occurredAt) &&
          occurredAt >= cutoffTime &&
          !notifications.has(notification.eventId)
        ) {
          if (notification.commentId !== undefined) {
            const commentSourceKey = JSON.stringify([
              notification.teamId,
              notification.issueId,
              notification.commentId,
            ])
            let sourceAvailable = commentSourceAvailability.get(commentSourceKey)
            if (sourceAvailable === undefined) {
              const comment = await workItemDependencies.collaboration.getCommentSnapshot({
                entityKey: createWorkItemCollaborationEntityKey(
                  principal.directoryId,
                  notification.teamId,
                  notification.issueId,
                ),
                commentId: notification.commentId,
              })
              sourceAvailable = comment !== undefined && comment.deletedAt === undefined
              commentSourceAvailability.set(commentSourceKey, sourceAvailable)
            }
            if (!sourceAvailable) continue
          }
          notifications.set(notification.eventId, notification)
        }
      }
      if (cutoffReached) {
        cursor = undefined
      } else {
        if (page.nextCursor !== undefined) {
          if (visitedCursors.has(page.nextCursor)) {
            throw new FocusApiError(
              503,
              'FocusNotificationCursorStalled',
              'Focus notifications could not advance to the next page.',
            )
          }
          visitedCursors.add(page.nextCursor)
        }
        cursor = page.nextCursor
      }
    } while (
      !cutoffReached &&
      cursor !== undefined &&
      pagesRead < FOCUS_NOTIFICATION_MAX_PAGES_PER_FILTER
    )
    if (!cutoffReached && cursor !== undefined) {
      throw new FocusApiError(
        503,
        'FocusNotificationReadLimitExceeded',
        'Focus notifications exceed the supported read window.',
      )
    }
  }
  if (notifications.size > FOCUS_NOTIFICATION_GLOBAL_LIMIT) {
    throw new FocusApiError(
      503,
      'FocusNotificationReadLimitExceeded',
      'Focus notifications exceed the supported read window.',
    )
  }
  const mentionCountsByWorkItemKey = new Map<string, number>()
  const boundedNotifications: NotificationItem[] = []
  const newestFirst = [...notifications.values()].sort((left, right) => {
    const timeDifference = Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
    return timeDifference === 0
      ? left.eventId.localeCompare(right.eventId)
      : timeDifference
  })
  for (const notification of newestFirst) {
    if (boundedNotifications.length >= FOCUS_NOTIFICATION_GLOBAL_LIMIT) break
    if (notification.teamId === undefined || notification.issueId === undefined) continue
    const key = createFocusWorkItemKey(notification.teamId, notification.issueId)
    const currentCount = mentionCountsByWorkItemKey.get(key) ?? 0
    if (currentCount >= FOCUS_NOTIFICATION_PER_WORK_ITEM_LIMIT) {
      throw new FocusApiError(
        503,
        'FocusNotificationReadLimitExceeded',
        'Focus mentions exceed the supported per-Work-Item read window.',
      )
    }
    mentionCountsByWorkItemKey.set(key, currentCount + 1)
    boundedNotifications.push(notification)
  }
  return boundedNotifications
}

/**
 * Finds one currently projected Focus item or hides inaccessible source identity.
 *
 * @param queue - Current permission-filtered Focus queue.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Current Focus item.
 */
function requireFocusItem(
  queue: FocusQueueResponse,
  teamId: string,
  workItemId: string,
): FocusItem {
  const item = queue.sections
    .flatMap((section) => section.items)
    .find((candidate) =>
      candidate.workItem.teamId === teamId && candidate.workItem.id === workItemId
    )
  if (item === undefined) {
    throw new FocusApiError(
      404,
      'FocusItemNotFound',
      'Focus item was not found or is no longer accessible.',
    )
  }
  return item
}

/**
 * Finds a post-mutation Focus item and reports concurrent source changes as a conflict.
 *
 * @param queue - Recomputed permission-filtered Focus queue.
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Recomputed Focus item.
 */
function requireUpdatedFocusItem(
  queue: FocusQueueResponse,
  teamId: string,
  workItemId: string,
): FocusItem {
  try {
    return requireFocusItem(queue, teamId, workItemId)
  } catch (error) {
    if (!(error instanceof FocusApiError) || error.code !== 'FocusItemNotFound') {
      throw error
    }
    throw new FocusApiError(
      409,
      'FocusItemChanged',
      'Focus item changed during the mutation. Reload and try again.',
    )
  }
}

/**
 * Requires the client to mutate the currently projected Focus aggregate version.
 *
 * @param item - Current projected Focus item.
 * @param expectedVersion - Version observed by the client.
 */
function requireFocusItemVersion(item: FocusItem, expectedVersion: number): void {
  if (item.version !== expectedVersion) {
    throw new FocusApiError(
      409,
      'FocusItemVersionConflict',
      'Focus item changed after it was read. Reload and try again.',
    )
  }
}

/**
 * Requires a snooze write to match the exact source evidence used to persist it.
 *
 * @param item - Focus item recomputed after the durable snooze write.
 * @param expectedCauseFingerprint - Signal fingerprint captured before the write.
 * @param expectedSnoozedUntil - Requested wake time, or null for an unsnooze.
 */
function requireFocusSnoozePostcondition(
  item: FocusItem,
  expectedCauseFingerprint: string,
  expectedSnoozedUntil: string | null,
): void {
  const actualCauseFingerprint = createFocusCauseFingerprint(item.signals)
  if (
    actualCauseFingerprint !== expectedCauseFingerprint ||
    (item.snoozedUntil ?? null) !== expectedSnoozedUntil
  ) {
    throw new FocusApiError(
      409,
      'FocusSnoozeConflict',
      'Focus source evidence changed during the snooze mutation. Reload and try again.',
    )
  }
}

/**
 * Requires a server-projected Focus capability before a mutation.
 *
 * @param allowed - Current server-authorized capability value.
 * @param action - Safe action label used in the conflict response.
 */
function requireFocusItemCapability(allowed: boolean, action: string): void {
  if (!allowed) {
    throw new FocusApiError(
      409,
      'FocusActionUnavailable',
      `Focus ${action} is no longer available. Reload and try again.`,
    )
  }
}

/**
 * Strongly reauthorizes a Focus source immediately before a personal mutation.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param item - Current projected Focus item.
 * @returns Strongly read authorized Work Item detail and permission context.
 */
async function reauthorizeFocusItem(
  principal: WorkspacePrincipal,
  item: FocusItem,
) {
  const authorized = await loadAuthorizedTeamIssue(
    principal,
    item.workItem.teamId,
    item.workItem.id,
    'viewer',
  )
  if (authorized.detail.issue.revision !== item.workItem.revision) {
    throw new FocusApiError(
      409,
      'FocusItemVersionConflict',
      'Focus item source changed after it was read. Reload and try again.',
    )
  }
  return authorized
}

/**
 * Registers the focus HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerFocusRoutes(routeApp: Hono): void {
  /** Returns the current permission-filtered Focus queue. */
  routeApp.get('/api/focus', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await readFocusQueue(principal, new Date()))
    } catch (error) {
      return toFocusErrorResponse(c, error)
    }
  })

  /** Replaces one personal or Team Focus policy with optimistic concurrency. */
  routeApp.put('/api/focus/policies', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const input = readFocusPolicyInput(await readJson<unknown>(c.req))
      if (input.target.type === 'team') {
        requireWorkspaceBusinessWrite(principal)
        await requireTeamPermission(principal, input.target.teamId, 'manager')
      }
      const operation = 'policy'
      const targetIdentity = createFocusMutationTargetIdentity(operation, [
        input.target.type,
        ...(input.target.type === 'team' ? [input.target.teamId] : []),
      ])
      const reservationRequest = createFocusMutationReservationRequest(
        principal,
        readRequiredFocusIdempotencyKey(c.req.header('Idempotency-Key')),
        c.req.method,
        '/api/focus/policies',
        input,
      )
      const reservation = await reserveFocusMutation(reservationRequest)
      if (reservation.status === 'in-progress') {
        throw focusIdempotencyInProgress()
      }
      if (reservation.status === 'replay') {
        const outcome = readStoredFocusMutationReceipt(
          reservation.response,
          reservationRequest.workspaceId,
          operation,
          targetIdentity,
        )
        const response = await replayFocusPolicyMutation(
          principal,
          input,
          outcome,
        )
        c.header('Idempotency-Replayed', 'true')
        return c.json(response)
      }

      const token = createFocusIdempotencyMutationToken(
        reservationRequest,
        reservation.reservationId,
      )
      try {
        const now = new Date()
        const prepared = await prepareFocusPolicyMutation(
          principal,
          input,
          now,
          reservationRequest,
          targetIdentity,
        )
        if (prepared.committedPolicy !== undefined) {
          await completeFocusPolicyMutationReceipt(
            reservationRequest,
            token,
            targetIdentity,
            prepared.committedPolicy,
            prepared.effectivePolicies,
          )
          c.header('Idempotency-Replayed', 'true')
          return c.json({
            policy: prepared.committedPolicy,
            effectivePolicies: prepared.effectivePolicies,
          } satisfies UpdateFocusPolicyResponse)
        }
        const policy = await workItemDependencies.focusState.savePolicy({
          workspaceId: principal.directoryId,
          memberKey: principal.userKey,
          update: input,
          now,
          mutationIdentity: prepared.mutationIdentity,
          authorizationConditionChecks: [
            ...createPlanningCallerAuthorizationConditionChecks(principal),
            ...prepared.policyConditionChecks,
          ],
        })
        let effectivePolicies = prepared.effectivePolicies
        try {
          effectivePolicies = await readAndVerifyFocusPolicyEffectivePolicies(
            principal,
            input,
            prepared.effectivePolicies,
          )
        } catch (error) {
          if (
            !(error instanceof FocusApiError) ||
            error.code !== 'FocusPolicyContributingStateChanged'
          ) {
            throw error
          }
        }
        const response = { policy, effectivePolicies } satisfies UpdateFocusPolicyResponse
        await completeFocusPolicyMutationReceipt(
          reservationRequest,
          token,
          targetIdentity,
          policy,
          effectivePolicies,
        )
        return c.json(response)
      } catch (error) {
        await releaseFocusMutationReservation(reservationRequest, token)
        throw error
      }
    } catch (error) {
      return toFocusErrorResponse(c, error)
    }
  })

  /** Snoozes or unsnoozes one currently authorized Focus item. */
  routeApp.put('/api/focus/items/:teamId/:workItemId/snooze', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const teamId = readFocusRouteId(c.req.param('teamId'), 'Focus Team ID')
      const workItemId = readFocusRouteId(c.req.param('workItemId'), 'Focus Work Item ID')
      const now = new Date()
      const input = readFocusSnoozeInput(await readJson<unknown>(c.req), now)
      const queue = await readFocusQueue(principal, now)
      const current = requireFocusItem(
        queue,
        teamId,
        workItemId,
      )
      requireFocusItemCapability(current.capabilities.snooze, 'snooze')
      await reauthorizeFocusItem(principal, current)
      const operation = 'snooze'
      const targetIdentity = createFocusMutationTargetIdentity(operation, [teamId, workItemId])
      const reservationRequest = createFocusMutationReservationRequest(
        principal,
        readRequiredFocusIdempotencyKey(c.req.header('Idempotency-Key')),
        c.req.method,
        createFocusItemMutationPath(teamId, workItemId, operation),
        input,
      )
      const reservation = await reserveFocusMutation(reservationRequest)
      if (reservation.status === 'in-progress') {
        throw focusIdempotencyInProgress()
      }
      if (reservation.status === 'replay') {
        const outcome = readStoredFocusMutationReceipt(
          reservation.response,
          reservationRequest.workspaceId,
          operation,
          targetIdentity,
        )
        const item = replayFocusItemMutation(current, operation, outcome)
        c.header('Idempotency-Replayed', 'true')
        return c.json({ item } satisfies UpdateFocusSnoozeResponse)
      }

      const token = createFocusIdempotencyMutationToken(
        reservationRequest,
        reservation.reservationId,
      )
      try {
        const mutationIdentity = createFocusItemMutationRecoveryIdentity(
          reservationRequest,
          operation,
          targetIdentity,
          current,
          requireFocusEffectivePolicyFingerprint(queue, current),
        )
        const causeFingerprint = createFocusCauseFingerprint(current.signals)
        const state = await workItemDependencies.focusState.getState({
          workspaceId: principal.directoryId,
          memberKey: principal.userKey,
          teamIds: [teamId],
        })
        const committedSnooze = findCommittedFocusSnooze(
          state,
          teamId,
          workItemId,
          mutationIdentity,
          input.snoozedUntil,
          causeFingerprint,
        )
        if (committedSnooze !== undefined) {
          const item = restoreFocusItemEvaluationTime(current, committedSnooze.updatedAt)
          await completeFocusItemMutationReceipt(
            reservationRequest,
            token,
            operation,
            targetIdentity,
            item,
          )
          c.header('Idempotency-Replayed', 'true')
          return c.json({ item } satisfies UpdateFocusSnoozeResponse)
        }
        requireFocusItemVersion(current, input.expectedVersion)
        await workItemDependencies.focusState.saveSnooze({
          workspaceId: principal.directoryId,
          memberKey: principal.userKey,
          teamId,
          workItemId,
          expectedVersion: current.snoozeRevision,
          causeFingerprint,
          snoozedUntil: input.snoozedUntil,
          now,
          mutationIdentity,
        })
        const item = requireUpdatedFocusItem(
          await readFocusQueue(principal, now),
          teamId,
          workItemId,
        )
        requireFocusSnoozePostcondition(item, causeFingerprint, input.snoozedUntil)
        const response = { item } satisfies UpdateFocusSnoozeResponse
        await completeFocusItemMutationReceipt(
          reservationRequest,
          token,
          operation,
          targetIdentity,
          item,
        )
        return c.json(response)
      } catch (error) {
        await releaseFocusMutationReservation(reservationRequest, token)
        throw error
      }
    } catch (error) {
      return toFocusErrorResponse(c, error)
    }
  })

  /** Changes the watcher state of one currently authorized Focus item. */
  routeApp.put('/api/focus/items/:teamId/:workItemId/watch', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) {
      return c.json({ message: 'Bearer token is required.' }, 401)
    }

    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const teamId = readFocusRouteId(c.req.param('teamId'), 'Focus Team ID')
      const workItemId = readFocusRouteId(c.req.param('workItemId'), 'Focus Work Item ID')
      const input = readFocusWatchInput(await readJson<unknown>(c.req))
      const now = new Date()
      const queue = await readFocusQueue(principal, now)
      const current = requireFocusItem(
        queue,
        teamId,
        workItemId,
      )
      const { context, detail } = await reauthorizeFocusItem(principal, current)
      requireFocusWorkItemWatchPermission(principal, context, detail.issue)
      requireFocusItemCapability(current.capabilities.watch, 'watch')
      const operation = 'watch'
      const targetIdentity = createFocusMutationTargetIdentity(operation, [teamId, workItemId])
      const reservationRequest = createFocusMutationReservationRequest(
        principal,
        readRequiredFocusIdempotencyKey(c.req.header('Idempotency-Key')),
        c.req.method,
        createFocusItemMutationPath(teamId, workItemId, operation),
        input,
      )
      const reservation = await reserveFocusMutation(reservationRequest)
      if (reservation.status === 'in-progress') {
        throw focusIdempotencyInProgress()
      }
      if (reservation.status === 'replay') {
        const outcome = readStoredFocusMutationReceipt(
          reservation.response,
          reservationRequest.workspaceId,
          operation,
          targetIdentity,
        )
        const item = replayFocusItemMutation(current, operation, outcome)
        c.header('Idempotency-Replayed', 'true')
        return c.json({ item } satisfies UpdateFocusWatchResponse)
      }

      const token = createFocusIdempotencyMutationToken(
        reservationRequest,
        reservation.reservationId,
      )
      try {
        const entityKey = createWorkItemCollaborationEntityKey(
          principal.directoryId,
          teamId,
          workItemId,
        )
        const projectEntityKey = detail.issue.assignedProjectId
          ? createProjectCollaborationEntityKey(
              principal.directoryId,
              detail.issue.assignedProjectId,
            )
          : undefined
        const mutationIdentity = createFocusItemMutationRecoveryIdentity(
          reservationRequest,
          operation,
          targetIdentity,
          current,
          requireFocusEffectivePolicyFingerprint(queue, current),
        )
        const storedWatcher = await workItemDependencies.collaboration
          .getMemberWatcherState({
            entityKey,
            memberKey: principal.userKey,
            projectEntityKey,
          })
        if (
          storedWatcher.mutationIdentity === mutationIdentity &&
          storedWatcher.subscribed === input.watching &&
          storedWatcher.updatedAt !== undefined
        ) {
          requireFocusWatchPostcondition(current.watching, input.watching)
          const item = restoreFocusItemEvaluationTime(current, storedWatcher.updatedAt)
          await completeFocusItemMutationReceipt(
            reservationRequest,
            token,
            operation,
            targetIdentity,
            item,
          )
          c.header('Idempotency-Replayed', 'true')
          return c.json({ item } satisfies UpdateFocusWatchResponse)
        }
        requireFocusWatchPostcondition(storedWatcher.subscribed, current.watching)
        requireFocusItemVersion(current, input.expectedVersion)
        const auditContext = {
          ...createApiMutationContext(c, principal, {
            expectedVersion: input.expectedVersion,
            teamId,
            workItemId,
            watching: input.watching,
          }),
          occurredAt: now.toISOString(),
        }
        const mutation = {
          workspaceId: principal.directoryId,
          teamId,
          issueId: workItemId,
          entityKey,
          authorizationConditionChecks: createPlanningCallerAuthorizationConditionChecks(principal),
          projectId: detail.issue.assignedProjectId,
          projectEntityKey,
          memberKey: principal.userKey,
          expectedSubscribed: current.watching,
          mutationIdentity,
          auditContext,
        }
        const watch = input.watching
          ? await workItemDependencies.collaboration.subscribe(mutation)
          : await workItemDependencies.collaboration.unsubscribe(mutation)
        const observedWatching = watch.subscribed
        requireFocusWatchPostcondition(observedWatching, input.watching)
        const item = requireUpdatedFocusItem(
          await readFocusQueue(principal, now),
          teamId,
          workItemId,
        )
        requireFocusWatchPostcondition(item.watching, input.watching)
        const response = { item } satisfies UpdateFocusWatchResponse
        await completeFocusItemMutationReceipt(
          reservationRequest,
          token,
          operation,
          targetIdentity,
          item,
        )
        return c.json(response)
      } catch (error) {
        await releaseFocusMutationReservation(reservationRequest, token)
        throw error
      }
    } catch (error) {
      return toFocusErrorResponse(c, error)
    }
  })
}
