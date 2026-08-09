import {
  FOCUS_SCHEMA_VERSION,
  type FocusActionability,
  type FocusEffectivePolicy,
  type FocusItem,
  type FocusItemCapabilities,
  type FocusPolicy,
  type FocusPolicyCapabilities,
  type FocusPolicyOverrides,
  type FocusPolicyProvenance,
  type FocusPolicySettings,
  type FocusPolicyTarget,
  type FocusQueueResponse,
  type FocusQueueSection,
  type FocusQueueSectionGroup,
  type FocusRankBreakdown,
  type FocusRankComponent,
  type FocusSignal,
  type FocusSignalFreshness,
  type FocusSignalResolution,
  type FocusSignalSource,
  type FocusSignalType,
  type UpdateFocusPolicyInput,
  type UpdateFocusPolicyResponse,
  type UpdateFocusSnoozeInput,
  type UpdateFocusSnoozeResponse,
  type UpdateFocusWatchInput,
  type UpdateFocusWatchResponse,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'
import {
  isFiniteNumber,
  isNonnegativeSafeInteger,
  isPositiveSafeInteger,
  isRecord,
} from '../../../shared/api/jsonValidation'
import { isCanonicalWorkItem } from '../../../work-items/api/contractValidation'

const focusApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultFocusApiErrorMessage = 'Unable to complete the Focus queue request.'

const focusQueueSectionOrder: readonly FocusQueueSection[] = [
  'now',
  'next',
  'waiting',
  'snoozed',
  'done',
]

const focusQueueSections: ReadonlySet<string> = new Set(focusQueueSectionOrder)

const focusSignalTypes: ReadonlySet<string> = new Set([
  'blocker',
  'urgent',
  'overdue',
  'due-soon',
  'approval',
  'review-request',
  'mention',
  'sla',
  'cycle',
])

const focusSignalSourceKinds: ReadonlySet<string> = new Set([
  'work-item',
  'work-item-relation',
  'planning-dependency',
  'approval',
  'review-request',
  'comment-mention',
  'notification',
  'service-level-policy',
  'planning-cycle',
])

const focusResolutionConditions: ReadonlySet<string> = new Set([
  'work-item-completed',
  'priority-lowered',
  'deadline-changed',
  'dependency-removed',
  'blocker-completed',
  'approval-decided',
  'review-completed',
  'mention-acknowledged',
  'sla-restored',
  'cycle-changed',
  'source-removed',
])

const focusActionabilityReasons: ReadonlySet<string> = new Set([
  'blocked',
  'awaiting-external-action',
  'no-permitted-primary-action',
  'work-item-completed',
])

/** Error returned by the authenticated Focus queue endpoints. */
export class FocusQueueApiError extends Error {
  /** HTTP status returned by the endpoint. */
  readonly status: number

  /** Stable server error code when one was supplied. */
  readonly code?: string

  /**
   * Creates a typed Focus transport error.
   *
   * @param status - HTTP status returned by the endpoint.
   * @param message - Safe request failure message.
   * @param code - Optional stable server error code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'FocusQueueApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Loads the caller's permission-filtered Focus queue snapshot.
 *
 * @param accessToken - Session bearer token.
 * @returns Server-ranked Focus groups and their effective policies.
 */
export function getFocusQueue(accessToken: string): Promise<FocusQueueResponse> {
  return requestValidatedJson(
    `${focusApiBaseUrl}/focus`,
    accessToken,
    {},
    isFocusQueueResponse,
    'InvalidFocusQueueResponse',
  )
}

/**
 * Replaces one user or Team Focus policy override.
 *
 * @param accessToken - Session bearer token.
 * @param input - Revision-bound policy replacement.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns Stored policy and all affected effective Team policies after the update.
 */
export function updateFocusPolicy(
  accessToken: string,
  input: UpdateFocusPolicyInput,
  mutationContext: MutationRequestContext,
): Promise<UpdateFocusPolicyResponse> {
  return requestValidatedJson(
    `${focusApiBaseUrl}/focus/policies`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PUT',
    },
    isUpdateFocusPolicyResponse,
    'InvalidFocusPolicyResponse',
  )
}

/**
 * Snoozes or unsnoozes one Focus item without changing its Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item identifier.
 * @param accessToken - Session bearer token.
 * @param input - Revision-bound wake time replacement.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns Recomputed Focus item after the update.
 */
export function updateFocusSnooze(
  teamId: string,
  workItemId: string,
  accessToken: string,
  input: UpdateFocusSnoozeInput,
  mutationContext: MutationRequestContext,
): Promise<UpdateFocusSnoozeResponse> {
  return requestValidatedJson(
    createFocusItemActionPath(teamId, workItemId, 'snooze'),
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PUT',
    },
    isUpdateFocusSnoozeResponse,
    'InvalidFocusSnoozeResponse',
  )
}

/**
 * Changes the watch state attached to one Focus Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Team-local Work Item identifier.
 * @param accessToken - Session bearer token.
 * @param input - Revision-bound watch state replacement.
 * @param mutationContext - Idempotency and correlation headers.
 * @returns Recomputed Focus item after the update.
 */
export function updateFocusWatch(
  teamId: string,
  workItemId: string,
  accessToken: string,
  input: UpdateFocusWatchInput,
  mutationContext: MutationRequestContext,
): Promise<UpdateFocusWatchResponse> {
  return requestValidatedJson(
    createFocusItemActionPath(teamId, workItemId, 'watch'),
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(mutationContext),
      },
      method: 'PUT',
    },
    isUpdateFocusWatchResponse,
    'InvalidFocusWatchResponse',
  )
}

/** Returns whether an unknown value is a complete Focus queue response. */
function isFocusQueueResponse(value: unknown): value is FocusQueueResponse {
  if (
    !isRecord(value) ||
    value.schemaVersion !== FOCUS_SCHEMA_VERSION ||
    !isCanonicalUtcTimestamp(value.generatedAt) ||
    typeof value.viewerMemberKey !== 'string' ||
    value.viewerMemberKey.length === 0 ||
    !isRecord(value.metrics) ||
    !isNonnegativeSafeInteger(value.metrics.blocked) ||
    !Array.isArray(value.effectivePolicies) ||
    !value.effectivePolicies.every(isFocusEffectivePolicy) ||
    !Array.isArray(value.teamPolicies) ||
    !value.teamPolicies.every((policy) =>
      isFocusPolicy(policy) && policy.target.type === 'team'
    ) ||
    (
      value.userPolicy !== undefined &&
      (!isFocusPolicy(value.userPolicy) || value.userPolicy.target.type !== 'user')
    ) ||
    !isFocusPolicyCapabilities(value.policyCapabilities) ||
    !Array.isArray(value.sections) ||
    !value.sections.every(isFocusQueueSectionGroup)
  ) {
    return false
  }

  return hasFocusQueueResponseInvariants(
    value.sections,
    value.effectivePolicies,
  )
}

/** Returns whether an unknown value is one complete Focus section group. */
function isFocusQueueSectionGroup(value: unknown): value is FocusQueueSectionGroup {
  return isRecord(value) &&
    isFocusQueueSection(value.section) &&
    Array.isArray(value.items) &&
    value.items.every(isFocusItem)
}

/**
 * Verifies cross-field references and uniqueness guarantees in one Focus response.
 *
 * @param sections - Structurally valid Focus section groups.
 * @param effectivePolicies - Structurally valid policies referenced by queue items.
 * @returns Whether ordered sections, items, Work Items, rank evidence, and policies agree.
 */
function hasFocusQueueResponseInvariants(
  sections: readonly FocusQueueSectionGroup[],
  effectivePolicies: readonly FocusEffectivePolicy[],
): boolean {
  if (sections.length !== focusQueueSectionOrder.length) return false

  const effectivePoliciesById = new Map<string, FocusEffectivePolicy>()
  for (const policy of effectivePolicies) {
    if (effectivePoliciesById.has(policy.id)) return false
    effectivePoliciesById.set(policy.id, policy)
  }

  const focusItemIds = new Set<string>()
  const workItemKeys = new Set<string>()
  for (const [index, group] of sections.entries()) {
    if (group.section !== focusQueueSectionOrder[index]) return false

    for (const item of group.items) {
      const workItemKey = JSON.stringify([item.workItem.teamId, item.workItem.id])
      const effectivePolicy = effectivePoliciesById.get(item.effectivePolicyId)
      if (
        item.section !== group.section ||
        focusItemIds.has(item.id) ||
        workItemKeys.has(workItemKey) ||
        !effectivePolicy ||
        (
          effectivePolicy.teamId !== undefined &&
          effectivePolicy.teamId !== item.workItem.teamId
        ) ||
        !hasFocusRankInvariants(item)
      ) {
        return false
      }
      focusItemIds.add(item.id)
      workItemKeys.add(workItemKey)
    }
  }

  return true
}

/**
 * Verifies that one rank references each signal exactly once and sums correctly.
 *
 * @param item - Structurally valid Focus item containing signals and rank components.
 * @returns Whether component references, contribution arithmetic, and score agree.
 */
function hasFocusRankInvariants(item: FocusItem): boolean {
  const signalsById = new Map(item.signals.map((signal) => [signal.id, signal]))
  if (signalsById.size !== item.signals.length) return false

  const rankedSignalIds = new Set<string>()
  let score = 0
  for (const component of item.rank.components) {
    const signal = signalsById.get(component.signalId)
    const expectedContribution = component.weight * component.value
    if (
      !signal ||
      signal.type !== component.signalType ||
      rankedSignalIds.has(component.signalId) ||
      !Number.isFinite(expectedContribution) ||
      !areFiniteNumbersEquivalent(component.contribution, expectedContribution)
    ) {
      return false
    }
    rankedSignalIds.add(component.signalId)
    score += component.contribution
  }

  return rankedSignalIds.size === signalsById.size &&
    Number.isFinite(score) &&
    areFiniteNumbersEquivalent(score, item.rank.score)
}

/** Returns whether two finite JSON numbers are equal within arithmetic round-off. */
function areFiniteNumbersEquivalent(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= Number.EPSILON * scale * 16
}

/** Returns whether an unknown value is one complete stored Focus policy. */
function isFocusPolicy(value: unknown): value is FocusPolicy {
  return isRecord(value) &&
    value.schemaVersion === FOCUS_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    isFocusPolicyTarget(value.target) &&
    isNonnegativeSafeInteger(value.version) &&
    isFocusPolicyOverrides(value.overrides) &&
    isCanonicalUtcTimestamp(value.updatedAt)
}

/** Returns whether an unknown value is one Focus queue item. */
function isFocusItem(value: unknown): value is FocusItem {
  return isRecord(value) &&
    value.schemaVersion === FOCUS_SCHEMA_VERSION &&
    typeof value.id === 'string' &&
    isPositiveSafeInteger(value.version) &&
    isNonnegativeSafeInteger(value.snoozeRevision) &&
    isFocusQueueSection(value.section) &&
    isCanonicalWorkItem(value.workItem) &&
    Array.isArray(value.signals) &&
    value.signals.every(isFocusSignal) &&
    isFocusRankBreakdown(value.rank) &&
    isFocusItemCapabilities(value.capabilities) &&
    isFocusActionability(value.actionability) &&
    typeof value.effectivePolicyId === 'string' &&
    (
      value.snoozedUntil === undefined ||
      isCanonicalUtcTimestamp(value.snoozedUntil)
    ) &&
    typeof value.watching === 'boolean' &&
    isCanonicalUtcTimestamp(value.updatedAt)
}

/** Returns whether an unknown value is one Focus signal. */
function isFocusSignal(value: unknown): value is FocusSignal {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isFocusSignalType(value.type) &&
    isFocusSignalSource(value.source) &&
    isFocusSignalFreshness(value.freshness) &&
    isRecord(value.permission) &&
    typeof value.permission.canOpenSource === 'boolean' &&
    isFocusSignalResolution(value.resolution)
}

/** Returns whether an unknown value is one Focus signal source. */
function isFocusSignalSource(value: unknown): value is FocusSignalSource {
  return isRecord(value) &&
    typeof value.kind === 'string' &&
    focusSignalSourceKinds.has(value.kind) &&
    typeof value.id === 'string' &&
    (value.eventId === undefined || typeof value.eventId === 'string') &&
    isCanonicalUtcTimestamp(value.occurredAt) &&
    (value.deepLink === undefined || isSafeApplicationPath(value.deepLink))
}

/** Returns whether an unknown value is Focus freshness evidence. */
function isFocusSignalFreshness(value: unknown): value is FocusSignalFreshness {
  return isRecord(value) &&
    isCanonicalUtcTimestamp(value.evaluatedAt) &&
    (
      value.validUntil === undefined ||
      isCanonicalUtcTimestamp(value.validUntil)
    ) &&
    (
      value.sourceVersion === undefined ||
      isNonnegativeSafeInteger(value.sourceVersion)
    )
}

/** Returns whether an unknown value is one Focus resolution state. */
function isFocusSignalResolution(value: unknown): value is FocusSignalResolution {
  if (
    !isRecord(value) ||
    typeof value.condition !== 'string' ||
    !focusResolutionConditions.has(value.condition)
  ) {
    return false
  }
  if (value.status === 'open') return value.resolvedAt === undefined
  return value.status === 'resolved' && isCanonicalUtcTimestamp(value.resolvedAt)
}

/** Returns whether an unknown value is one transparent Focus rank. */
function isFocusRankBreakdown(value: unknown): value is FocusRankBreakdown {
  return isRecord(value) &&
    isFiniteNumber(value.score) &&
    Array.isArray(value.components) &&
    value.components.every(isFocusRankComponent) &&
    typeof value.tieBreaker === 'string'
}

/** Returns whether an unknown value is one Focus rank contribution. */
function isFocusRankComponent(value: unknown): value is FocusRankComponent {
  return isRecord(value) &&
    typeof value.signalId === 'string' &&
    isFocusSignalType(value.signalType) &&
    isFiniteNumber(value.weight) &&
    isFiniteNumber(value.value) &&
    isFiniteNumber(value.contribution)
}

/** Returns whether an unknown value is a complete action capability map. */
function isFocusItemCapabilities(value: unknown): value is FocusItemCapabilities {
  return isRecord(value) &&
    typeof value.complete === 'boolean' &&
    typeof value.assign === 'boolean' &&
    typeof value.changeStatus === 'boolean' &&
    typeof value.schedule === 'boolean' &&
    typeof value.snooze === 'boolean' &&
    typeof value.watch === 'boolean' &&
    typeof value.openSource === 'boolean'
}

/** Returns whether an unknown value is one Focus actionability projection. */
function isFocusActionability(value: unknown): value is FocusActionability {
  return isRecord(value) &&
    typeof value.actionable === 'boolean' &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string' &&
      focusActionabilityReasons.has(reason))
}

/** Returns whether an unknown value is one resolved Focus policy. */
function isFocusEffectivePolicy(value: unknown): value is FocusEffectivePolicy {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.fingerprint === 'string' &&
    (value.teamId === undefined || typeof value.teamId === 'string') &&
    isFocusPolicySettings(value.baseSettings) &&
    isFocusPolicySettings(value.teamSettings) &&
    isFocusPolicySettings(value.settings) &&
    Array.isArray(value.provenance) &&
    value.provenance.every(isFocusPolicyProvenance)
}

/** Returns whether an unknown value is a complete policy authorization projection. */
function isFocusPolicyCapabilities(value: unknown): value is FocusPolicyCapabilities {
  return isRecord(value) &&
    typeof value.canEditPersonal === 'boolean' &&
    Array.isArray(value.editableTeamIds) &&
    value.editableTeamIds.every(isNonemptyTrimmedString) &&
    new Set(value.editableTeamIds).size === value.editableTeamIds.length
}

/** Returns whether an unknown value is one resolved Focus policy setting set. */
function isFocusPolicySettings(value: unknown): value is FocusPolicySettings {
  return isRecord(value) &&
    isFocusSignalWeights(value.weights) &&
    isBoundedSafeInteger(value.dueSoonDays, 0, 365) &&
    isBoundedSafeInteger(value.cycleDueSoonDays, 0, 365) &&
    isBoundedSafeInteger(value.slaHours, 1, 8_760) &&
    isBoundedFiniteNumber(value.nowScoreThreshold, 0, 100_000)
}

/** Returns whether an unknown value contains every supported signal weight. */
function isFocusSignalWeights(value: unknown): boolean {
  return isRecord(value) &&
    isBoundedFiniteNumber(value.blocker, 0, 10_000) &&
    isBoundedFiniteNumber(value.urgent, 0, 10_000) &&
    isBoundedFiniteNumber(value.overdue, 0, 10_000) &&
    isBoundedFiniteNumber(value.dueSoon, 0, 10_000) &&
    isBoundedFiniteNumber(value.approval, 0, 10_000) &&
    isBoundedFiniteNumber(value.reviewRequest, 0, 10_000) &&
    isBoundedFiniteNumber(value.mention, 0, 10_000) &&
    isBoundedFiniteNumber(value.sla, 0, 10_000) &&
    isBoundedFiniteNumber(value.cycle, 0, 10_000)
}

/** Returns whether an unknown value is one policy provenance layer. */
function isFocusPolicyProvenance(value: unknown): value is FocusPolicyProvenance {
  if (!isRecord(value) || !isNonnegativeSafeInteger(value.version)) return false
  if (value.source === 'default') return true
  if (value.source === 'user') return typeof value.policyId === 'string'
  return value.source === 'team' &&
    typeof value.policyId === 'string' &&
    typeof value.teamId === 'string'
}

/** Returns whether an unknown value is a user or Team policy target. */
function isFocusPolicyTarget(value: unknown): value is FocusPolicyTarget {
  if (!isRecord(value)) return false
  if (value.type === 'user') return hasExactKeys(value, ['type'])
  return value.type === 'team' &&
    hasExactKeys(value, ['type', 'teamId']) &&
    isNonemptyTrimmedString(value.teamId)
}

/** Returns whether an unknown value is a partial Focus policy setting replacement. */
function isFocusPolicyOverrides(value: unknown): value is FocusPolicyOverrides {
  if (!isRecord(value)) return false
  if (value.weights !== undefined && !isFocusSignalWeightOverrides(value.weights)) return false
  return isOptionalBoundedSafeInteger(value.dueSoonDays, 0, 365) &&
    isOptionalBoundedSafeInteger(value.cycleDueSoonDays, 0, 365) &&
    isOptionalBoundedSafeInteger(value.slaHours, 1, 8_760) &&
    isOptionalBoundedFiniteNumber(value.nowScoreThreshold, 0, 100_000)
}

/** Returns whether an unknown value is a partial set of signal weights. */
function isFocusSignalWeightOverrides(value: unknown): boolean {
  return isRecord(value) &&
    isOptionalBoundedFiniteNumber(value.blocker, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.urgent, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.overdue, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.dueSoon, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.approval, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.reviewRequest, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.mention, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.sla, 0, 10_000) &&
    isOptionalBoundedFiniteNumber(value.cycle, 0, 10_000)
}

/**
 * Returns whether an unknown value is a finite number inside an inclusive range.
 *
 * @param value - Unknown numeric candidate.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @returns Whether the value is finite and inside the supported range.
 */
function isBoundedFiniteNumber(value: unknown, minimum: number, maximum: number): boolean {
  return isFiniteNumber(value) && value >= minimum && value <= maximum
}

/**
 * Returns whether an unknown value is a safe integer inside an inclusive range.
 *
 * @param value - Unknown numeric candidate.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @returns Whether the value is an integer inside the supported range.
 */
function isBoundedSafeInteger(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
}

/**
 * Returns whether an optional value is a bounded finite number.
 *
 * @param value - Unknown optional numeric candidate.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @returns Whether the value is absent or inside the supported range.
 */
function isOptionalBoundedFiniteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return value === undefined || isBoundedFiniteNumber(value, minimum, maximum)
}

/**
 * Returns whether an optional value is a bounded safe integer.
 *
 * @param value - Unknown optional numeric candidate.
 * @param minimum - Inclusive lower bound.
 * @param maximum - Inclusive upper bound.
 * @returns Whether the value is absent or an integer inside the supported range.
 */
function isOptionalBoundedSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return value === undefined || isBoundedSafeInteger(value, minimum, maximum)
}

/**
 * Returns whether an unknown value is a non-empty string already normalized by the server.
 *
 * @param value - Unknown identifier candidate.
 * @returns Whether the value is non-empty and has no surrounding whitespace.
 */
function isNonemptyTrimmedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

/**
 * Returns whether a record contains exactly the expected own enumerable keys.
 *
 * @param value - Record being checked.
 * @param expectedKeys - Complete allowed key collection.
 * @returns Whether no required key is missing and no extra key is present.
 */
function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value)
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key))
}

/**
 * Returns whether an unknown value is a canonical ISO UTC timestamp.
 *
 * @param value - Unknown timestamp candidate.
 * @returns Whether the value equals the runtime's exact UTC serialization.
 */
function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

/** Returns whether an unknown value is one supported Focus queue section. */
function isFocusQueueSection(value: unknown): value is FocusQueueSection {
  return typeof value === 'string' && focusQueueSections.has(value)
}

/** Returns whether an unknown value is one supported Focus signal type. */
function isFocusSignalType(value: unknown): value is FocusSignalType {
  return typeof value === 'string' && focusSignalTypes.has(value)
}

/** Returns whether an unknown value is one policy update response. */
function isUpdateFocusPolicyResponse(value: unknown): value is UpdateFocusPolicyResponse {
  return isRecord(value) &&
    isFocusPolicy(value.policy) &&
    Array.isArray(value.effectivePolicies) &&
    value.effectivePolicies.every(isFocusEffectivePolicy)
}

/** Returns whether an unknown value is one snooze update response. */
function isUpdateFocusSnoozeResponse(value: unknown): value is UpdateFocusSnoozeResponse {
  return isRecord(value) && isFocusItem(value.item)
}

/** Returns whether an unknown value is one watch update response. */
function isUpdateFocusWatchResponse(value: unknown): value is UpdateFocusWatchResponse {
  return isRecord(value) && isFocusItem(value.item)
}

/** Creates one encoded Focus item action endpoint. */
function createFocusItemActionPath(
  teamId: string,
  workItemId: string,
  action: 'snooze' | 'watch',
): string {
  return `${focusApiBaseUrl}/focus/items/${encodeURIComponent(teamId)}/${encodeURIComponent(workItemId)}/${action}`
}

/** Returns whether a deep link stays inside the current application origin. */
function isSafeApplicationPath(value: unknown): value is string {
  return typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\')
}

/** Fetches and validates one Focus endpoint response. */
async function requestValidatedJson<TResponse>(
  url: string,
  accessToken: string,
  init: RequestInit,
  validate: (value: unknown) => value is TResponse,
  invalidCode: string,
): Promise<TResponse> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const value = await readJson(response)

  if (!response.ok) {
    const error = readApiError(value)
    throw new FocusQueueApiError(response.status, error.message, error.code)
  }
  if (!validate(value)) {
    throw new FocusQueueApiError(502, defaultFocusApiErrorMessage, invalidCode)
  }
  return value
}

/** Reads a JSON response without widening untrusted data to `any`. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Extracts a safe error envelope from an untrusted response body. */
function readApiError(value: unknown): { code?: string; message: string } {
  if (!isRecord(value)) return { message: defaultFocusApiErrorMessage }
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    message: typeof value.message === 'string' && value.message.trim().length > 0
      ? value.message
      : defaultFocusApiErrorMessage,
  }
}

/** Removes trailing separators from an API base URL. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, '')
}
