import type {
  ApprovalRequest,
  CanonicalWorkItem,
  FocusActionability,
  FocusEffectivePolicy,
  FocusItem,
  FocusItemCapabilities,
  FocusPolicy,
  FocusPolicyProvenance,
  FocusPolicySettings,
  FocusQueueResponse,
  FocusQueueSection,
  FocusRankBreakdown,
  FocusRankComponent,
  FocusSignal,
  FocusSignalResolutionCondition,
  FocusSignalSourceKind,
  FocusSignalType,
  FocusSignalWeightOverrides,
  FocusSignalWeights,
  PlanningSnapshot,
  WorkItemRelation,
} from '@mukuroji/contracts'
import { FOCUS_SCHEMA_VERSION } from '@mukuroji/contracts'
import { createHash } from 'node:crypto'
import type { NotificationItem } from '../notifications'
import {
  addWorkItemScheduleCalendarDays,
  workItemScheduleInstantToLocalDate,
} from '../work-items'
import type { FocusSnoozeRecord } from './focus-state'

/** Stable separator used by caller-provided Work Item state maps. */
const WORK_ITEM_KEY_SEPARATOR = '\0'

/** Version of the built-in Focus ranking policy. */
const DEFAULT_POLICY_VERSION = 1

/** Inclusive duration for retaining recently updated terminal Work Items in Done. */
const FOCUS_DONE_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000

/** Stable queue section order shared by projection and response rendering. */
const FOCUS_SECTION_ORDER: readonly FocusQueueSection[] = [
  'now',
  'next',
  'waiting',
  'snoozed',
  'done',
]

/** Product defaults used before Team and user overrides are applied. */
export const DEFAULT_FOCUS_POLICY_SETTINGS: FocusPolicySettings = {
  weights: {
    blocker: 100,
    urgent: 80,
    overdue: 90,
    dueSoon: 50,
    approval: 60,
    reviewRequest: 85,
    mention: 45,
    sla: 75,
    cycle: 25,
  },
  dueSoonDays: 3,
  cycleDueSoonDays: 2,
  slaHours: 72,
  nowScoreThreshold: 75,
}

/** Input used to resolve product, Team, and user Focus policy layers. */
export type ResolveFocusEffectivePoliciesInput = {
  /** Team identifiers that need an effective policy. */
  teamIds: readonly string[]
  /** Versioned Team policy overrides visible to the caller. */
  teamPolicies: readonly FocusPolicy[]
  /** Current user's versioned policy override when one is stored. */
  userPolicy?: FocusPolicy
  /** Optional product defaults used by isolated tests and migrations. */
  defaultSettings?: FocusPolicySettings
}

/** Permission-filtered semantic relation graph used by one Team projection. */
export type FocusRelationGraphSource = {
  /** Team that owns every relation endpoint in this graph. */
  teamId: string
  /** Monotonic canonical relation graph revision. */
  graphRevision: number
  /** Relations whose source and target Work Items are both currently visible. */
  relations: readonly WorkItemRelation[]
}

/** ACL-filtered canonical sources and recipient state used to project Focus. */
export type CreateFocusQueueInput = {
  /** Evaluation instant as a Date or ISO 8601 timestamp. */
  now: Date | string
  /** Authenticated Workspace member key used for ownership and review checks. */
  viewerMemberKey: string
  /** Canonical Work Items already filtered by current read permission. */
  workItems: readonly CanonicalWorkItem[]
  /** Planning snapshot already filtered so hidden dependency endpoints are absent. */
  planning: PlanningSnapshot
  /**
   * Optional authoritative semantic relation graphs with source occurrence evidence.
   * Relation-only blockers are omitted when this evidence is unavailable.
   */
  relationGraphs?: readonly FocusRelationGraphSource[]
  /** Reviewer approval requests already reauthorized for the current caller. */
  reviewerApprovals: readonly ApprovalRequest[]
  /** Notification events already filtered by current source visibility. */
  notifications: readonly NotificationItem[]
  /** Team-scoped Focus policy overrides visible to the caller. */
  teamPolicies: readonly FocusPolicy[]
  /** Accessible Teams that need policy controls even when their queue is empty. */
  policyTeamIds?: readonly string[]
  /** Current user's Focus policy override when one is stored. */
  userPolicy?: FocusPolicy
  /** Visible Teams whose policy override the caller may manage. */
  editableTeamPolicyIds?: readonly string[]
  /** Recipient-specific Work Item snoozes loaded from the Focus state store. */
  snoozeRecords: readonly FocusSnoozeRecord[]
  /**
   * Write permission keyed by `teamId`, a NUL separator, and Work Item ID.
   * Missing entries fail closed as read-only.
   */
  canWriteByWorkItemKey: Readonly<Record<string, boolean>>
  /**
   * Approval-decision permission keyed by `teamId`, a NUL separator, and Work Item ID.
   * Missing entries fail closed and suppress review-request actionability.
   */
  canApproveByWorkItemKey: Readonly<Record<string, boolean>>
  /**
   * Watch permission keyed by `teamId`, a NUL separator, and Work Item ID.
   * Missing entries fail closed and suppress the watch mutation capability.
   */
  canWatchByWorkItemKey: Readonly<Record<string, boolean>>
  /**
   * Canonical watcher state keyed by `teamId`, a NUL separator, and Work Item ID.
   * Missing entries are treated as not watched.
   */
  watchingByWorkItemKey: Readonly<Record<string, boolean>>
}

/** Internal signal plus ranking and recurrence evidence not exposed by the API. */
type ProjectedSignal = {
  /** Public signal contract. */
  signal: FocusSignal
  /** Semantic cause key used to collapse equivalent canonical sources. */
  causeKey: string
  /** Lower value wins when equivalent sources are available. */
  sourcePriority: number
  /** Deadline used by deterministic item tie breaking when present. */
  deadline?: string
}

/** Source fields used to construct one projected signal. */
type CreateProjectedSignalInput = {
  /** Attention category represented by the signal. */
  type: FocusSignalType
  /** Canonical source kind. */
  sourceKind: FocusSignalSourceKind
  /** Stable canonical source identifier. */
  sourceId: string
  /** Immutable event identifier when the source supplies one. */
  eventId?: string
  /** Timestamp at which the attention cause occurred. */
  occurredAt: string
  /** Current queue evaluation timestamp. */
  evaluatedAt: string
  /** Source revision observed during projection. */
  sourceVersion?: number
  /** Timestamp after which the source must be evaluated again. */
  validUntil?: string
  /** Authorized relative link to the canonical source. */
  deepLink?: string
  /** Condition that resolves the active signal. */
  resolutionCondition: FocusSignalResolutionCondition
  /** Optional semantic key shared by equivalent source representations. */
  causeKey?: string
  /** Optional source preference where lower values are more canonical. */
  sourcePriority?: number
  /** Deadline used only for stable rank tie breaking. */
  deadline?: string
}

/** Precomputed source indexes shared while projecting every Work Item. */
type FocusProjectionContext = {
  /** Evaluation instant. */
  now: Date
  /** Canonical evaluation timestamp. */
  evaluatedAt: string
  /** Current viewer member key. */
  viewerMemberKey: string
  /** ACL-filtered Planning snapshot. */
  planning: PlanningSnapshot
  /** Canonical Work Items keyed by Team-qualified identity. */
  workItemsByKey: ReadonlyMap<string, CanonicalWorkItem>
  /** Authoritative permission-filtered semantic relation graphs keyed by Team. */
  relationGraphsByTeamId: ReadonlyMap<string, FocusRelationGraphSource>
  /** Planning Work Item projections keyed by Team-qualified identity. */
  planningWorkItemsByKey: ReadonlyMap<
    string,
    PlanningSnapshot['workItems'][number]
  >
  /** Planning links grouped by Team-qualified Work Item identity. */
  planningLinksByWorkItemKey: ReadonlyMap<
    string,
    readonly PlanningSnapshot['workItemLinks'][number][]
  >
  /** Planning dependencies grouped by Team-qualified successor identity. */
  planningDependenciesBySuccessorKey: ReadonlyMap<
    string,
    readonly PlanningSnapshot['workItemDependencies'][number][]
  >
  /** Planning entities keyed by their Workspace-local identifier. */
  planningEntitiesById: ReadonlyMap<string, PlanningSnapshot['entities'][number]>
  /** Reviewer approvals grouped by Team-qualified Work Item identity. */
  approvalsByWorkItemKey: ReadonlyMap<string, readonly ApprovalRequest[]>
  /** Visible notifications grouped by Team-qualified Work Item identity. */
  notificationsByWorkItemKey: ReadonlyMap<string, readonly NotificationItem[]>
}

/** Internal item projection retained until section ordering is complete. */
type ProjectedFocusItem = {
  /** Public item contract. */
  item: FocusItem
  /** Composite signal cause fingerprint used to validate a stored snooze. */
  causeFingerprint: string
}

/**
 * Resolves product defaults, then a Team override, then the user override.
 *
 * @param input - Teams and policy layers to resolve.
 * @returns One deterministic effective policy for each distinct Team.
 */
export function resolveFocusEffectivePolicies(
  input: ResolveFocusEffectivePoliciesInput,
): FocusEffectivePolicy[] {
  const settings = normalizePolicySettings(
    input.defaultSettings ?? DEFAULT_FOCUS_POLICY_SETTINGS,
  )
  const userPolicy = selectUserPolicy(input.userPolicy)
  const teamIds = [...new Set(input.teamIds)].sort(compareStrings)

  return teamIds.map((teamId) => {
    const teamPolicy = selectTeamPolicy(input.teamPolicies, teamId)
    const afterTeam = applyPolicyOverrides(settings, teamPolicy?.overrides)
    const effectiveSettings = applyPolicyOverrides(afterTeam, userPolicy?.overrides)
    const provenance = createPolicyProvenance(teamId, teamPolicy, userPolicy)
    const fingerprint = createEffectivePolicyFingerprint(
      teamId,
      effectiveSettings,
      provenance,
    )
    return {
      id: `focus-effective:${encodeURIComponent(teamId)}`,
      fingerprint,
      teamId,
      baseSettings: normalizePolicySettings(settings),
      teamSettings: normalizePolicySettings(afterTeam),
      settings: effectiveSettings,
      provenance,
    }
  })
}

/**
 * Creates a recurrence-sensitive fingerprint from stable signal source evidence.
 * Evaluation timestamps are intentionally excluded so an unchanged queue remains snoozed.
 *
 * @param signals - Current deduplicated signals for one Work Item.
 * @returns Compact deterministic signal-cause fingerprint.
 */
export function createFocusCauseFingerprint(
  signals: readonly FocusSignal[],
): string {
  const evidence = [...signals]
    .sort(compareSignals)
    .map((signal) => ({
      id: signal.id,
      type: signal.type,
      source: {
        eventId: signal.source.eventId ?? null,
        id: signal.source.id,
        kind: signal.source.kind,
      },
      resolution: {
        condition: signal.resolution.condition,
        status: signal.resolution.status,
      },
    }))
  return `focus-cause-v2-${stableDigest(stableCanonicalJson(evidence))}`
}

/**
 * Projects the current recipient Focus queue from ACL-filtered canonical sources.
 *
 * @param input - Canonical source snapshots, policy layers, and recipient state.
 * @returns Deterministically ranked Focus queue grouped into stable sections.
 */
export function createFocusQueue(input: CreateFocusQueueInput): FocusQueueResponse {
  const now = normalizeInstant(input.now)
  const evaluatedAt = now.toISOString()
  const viewerMemberKey = normalizeFocusMemberKey(input.viewerMemberKey)
  const activeWorkItems = input.workItems.filter((workItem) => workItem.archivedAt === undefined)
  const effectivePolicies = resolveFocusEffectivePolicies({
    teamIds: [
      ...activeWorkItems.map((workItem) => workItem.teamId),
      ...(input.policyTeamIds ?? []),
    ],
    teamPolicies: input.teamPolicies,
    ...(input.userPolicy === undefined ? {} : { userPolicy: input.userPolicy }),
  })
  const userPolicy = selectUserPolicy(input.userPolicy)
  const policyByTeam = new Map(
    effectivePolicies.flatMap((policy) => policy.teamId === undefined ? [] : [[policy.teamId, policy]]),
  )
  const visibleTeamIds = new Set(effectivePolicies.flatMap((policy) =>
    policy.teamId === undefined ? [] : [policy.teamId]
  ))
  const teamPolicies = [...visibleTeamIds]
    .map((teamId) => selectTeamPolicy(input.teamPolicies, teamId))
    .filter((policy): policy is FocusPolicy => policy !== undefined)
    .map(cloneFocusPolicy)
    .sort((left, right) => comparePolicyTargets(left, right))
  const editableTeamIds = [...new Set(input.editableTeamPolicyIds ?? [])]
    .filter((teamId) => visibleTeamIds.has(teamId))
    .sort(compareStrings)
  const context = createProjectionContext(
    input,
    now,
    evaluatedAt,
    viewerMemberKey,
    activeWorkItems,
  )
  const snoozeByKey = new Map(
    input.snoozeRecords.map((record) => [createWorkItemKey(record.teamId, record.workItemId), record]),
  )
  const projectedItems = activeWorkItems.flatMap((workItem) => {
    const policy = policyByTeam.get(workItem.teamId)
    if (policy === undefined) return []
    const projected = projectFocusItem(
      input,
      context,
      workItem,
      policy,
      snoozeByKey.get(createWorkItemKey(workItem.teamId, workItem.id)),
    )
    return projected === undefined ? [] : [projected]
  })
  const blockedCount = activeWorkItems.filter((workItem) =>
    !isTerminalWorkItem(workItem) && hasActiveBlocker(context, workItem)
  ).length

  return {
    schemaVersion: FOCUS_SCHEMA_VERSION,
    generatedAt: evaluatedAt,
    viewerMemberKey,
    metrics: { blocked: blockedCount },
    effectivePolicies,
    teamPolicies,
    ...(userPolicy === undefined ? {} : { userPolicy: cloneFocusPolicy(userPolicy) }),
    policyCapabilities: {
      canEditPersonal: true,
      editableTeamIds,
    },
    sections: FOCUS_SECTION_ORDER.map((section) => ({
      section,
      items: projectedItems
        .filter((projected) => projected.item.section === section)
        .map((projected) => projected.item)
        .sort(compareFocusItems),
    })),
  }
}

/**
 * Detaches one stored policy before exposing it through the queue response.
 *
 * @param policy - Valid personal policy selected for the current viewer.
 * @returns A deeply detached policy value.
 */
function cloneFocusPolicy(policy: FocusPolicy): FocusPolicy {
  return {
    ...policy,
    target: policy.target.type === 'user'
      ? { type: 'user' }
      : { type: 'team', teamId: policy.target.teamId },
    overrides: {
      ...policy.overrides,
      ...(policy.overrides.weights === undefined
        ? {}
        : { weights: { ...policy.overrides.weights } }),
    },
  }
}

/**
 * Orders stored Team policies without locale-sensitive comparison.
 *
 * @param left - Left policy.
 * @param right - Right policy.
 * @returns Stable target and identifier ordering.
 */
function comparePolicyTargets(left: FocusPolicy, right: FocusPolicy): number {
  const leftTarget = left.target.type === 'team' ? left.target.teamId : ''
  const rightTarget = right.target.type === 'team' ? right.target.teamId : ''
  return compareStrings(leftTarget, rightTarget) || compareStrings(left.id, right.id)
}

/**
 * Checks whether one visible Work Item has a canonical unresolved predecessor.
 *
 * @param context - Permission-filtered source indexes.
 * @param workItem - Candidate successor Work Item.
 * @returns True when a semantic relation or Planning dependency remains unresolved.
 */
function hasActiveBlocker(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
): boolean {
  return createRelationBlockerSignals(context, workItem).length > 0 ||
    createBlockerSignals(context, workItem).length > 0
}

/**
 * Creates one Team-qualified Work Item map key without accepting a physical database key.
 *
 * @param teamId - Owning Team identifier.
 * @param workItemId - Team-local Work Item identifier.
 * @returns Collision-safe in-memory identity.
 */
export function createFocusWorkItemStateKey(
  teamId: string,
  workItemId: string,
): string {
  return `${teamId}${WORK_ITEM_KEY_SEPARATOR}${workItemId}`
}

/** Internal concise alias for the shared Focus Work Item state-map key contract. */
const createWorkItemKey = createFocusWorkItemStateKey

/**
 * Normalizes an evaluation instant and rejects invalid timestamps.
 *
 * @param value - Date object or ISO timestamp.
 * @returns Detached valid Date.
 */
function normalizeInstant(value: Date | string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Focus evaluation time must be a valid instant.')
  }
  return date
}

/**
 * Selects the highest-version valid user policy.
 *
 * @param policy - Candidate user policy.
 * @returns Valid user policy or undefined.
 */
function selectUserPolicy(policy: FocusPolicy | undefined): FocusPolicy | undefined {
  return policy?.target.type === 'user' ? policy : undefined
}

/**
 * Selects the highest-version policy for one Team.
 *
 * @param policies - Candidate Team policies.
 * @param teamId - Target Team.
 * @returns Selected Team policy or undefined.
 */
function selectTeamPolicy(
  policies: readonly FocusPolicy[],
  teamId: string,
): FocusPolicy | undefined {
  return policies
    .filter((policy) => policy.target.type === 'team' && policy.target.teamId === teamId)
    .sort((left, right) => right.version - left.version || compareStrings(left.id, right.id))[0]
}

/**
 * Creates ordered provenance for one effective policy.
 *
 * @param teamId - Team whose settings are resolved.
 * @param teamPolicy - Selected Team layer.
 * @param userPolicy - Selected user layer.
 * @returns Low-to-high precedence provenance.
 */
function createPolicyProvenance(
  teamId: string,
  teamPolicy: FocusPolicy | undefined,
  userPolicy: FocusPolicy | undefined,
): FocusPolicyProvenance[] {
  const provenance: FocusPolicyProvenance[] = [{
    source: 'default',
    version: DEFAULT_POLICY_VERSION,
  }]
  if (teamPolicy !== undefined) {
    provenance.push({
      source: 'team',
      policyId: teamPolicy.id,
      teamId,
      version: teamPolicy.version,
    })
  }
  if (userPolicy !== undefined) {
    provenance.push({
      source: 'user',
      policyId: userPolicy.id,
      version: userPolicy.version,
    })
  }
  return provenance
}

/**
 * Applies one partial policy layer to resolved settings.
 *
 * @param base - Lower-precedence settings.
 * @param overrides - Optional higher-precedence overrides.
 * @returns Newly allocated normalized settings.
 */
function applyPolicyOverrides(
  base: FocusPolicySettings,
  overrides: FocusPolicy['overrides'] | undefined,
): FocusPolicySettings {
  return normalizePolicySettings({
    weights: mergeSignalWeights(base.weights, overrides?.weights),
    dueSoonDays: overrides?.dueSoonDays ?? base.dueSoonDays,
    cycleDueSoonDays: overrides?.cycleDueSoonDays ?? base.cycleDueSoonDays,
    slaHours: overrides?.slaHours ?? base.slaHours,
    nowScoreThreshold: overrides?.nowScoreThreshold ?? base.nowScoreThreshold,
  })
}

/**
 * Merges optional signal weights over a complete lower-precedence set.
 *
 * @param base - Complete lower-precedence weights.
 * @param overrides - Optional individual replacements.
 * @returns Complete detached weight set.
 */
function mergeSignalWeights(
  base: FocusSignalWeights,
  overrides: FocusSignalWeightOverrides | undefined,
): FocusSignalWeights {
  return {
    blocker: overrides?.blocker ?? base.blocker,
    urgent: overrides?.urgent ?? base.urgent,
    overdue: overrides?.overdue ?? base.overdue,
    dueSoon: overrides?.dueSoon ?? base.dueSoon,
    approval: overrides?.approval ?? base.approval,
    reviewRequest: overrides?.reviewRequest ?? base.reviewRequest,
    mention: overrides?.mention ?? base.mention,
    sla: overrides?.sla ?? base.sla,
    cycle: overrides?.cycle ?? base.cycle,
  }
}

/**
 * Validates complete policy settings at the pure domain boundary.
 *
 * @param settings - Candidate complete settings.
 * @returns Detached validated settings.
 */
function normalizePolicySettings(settings: FocusPolicySettings): FocusPolicySettings {
  const weights = mergeSignalWeights(settings.weights, undefined)
  for (const weight of Object.values(weights)) {
    requireBoundedFiniteNumber(weight, 0, 10_000, 'Focus signal weight')
  }
  requireBoundedInteger(settings.dueSoonDays, 0, 365, 'Focus due-soon days')
  requireBoundedInteger(settings.cycleDueSoonDays, 0, 365, 'Focus cycle due-soon days')
  requireBoundedInteger(settings.slaHours, 1, 8_760, 'Focus SLA hours')
  requireBoundedFiniteNumber(
    settings.nowScoreThreshold,
    0,
    100_000,
    'Focus Now threshold',
  )
  return {
    weights,
    dueSoonDays: settings.dueSoonDays,
    cycleDueSoonDays: settings.cycleDueSoonDays,
    slaHours: settings.slaHours,
    nowScoreThreshold: settings.nowScoreThreshold,
  }
}

/**
 * Rejects a non-finite numeric policy value outside an inclusive range.
 *
 * @param value - Candidate number.
 * @param minimum - Inclusive minimum.
 * @param maximum - Inclusive maximum.
 * @param label - Error label.
 */
function requireBoundedFiniteNumber(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be from ${minimum} through ${maximum}.`)
  }
}

/**
 * Rejects an integer outside an inclusive range.
 *
 * @param value - Candidate integer.
 * @param minimum - Inclusive minimum.
 * @param maximum - Inclusive maximum.
 * @param label - Error label.
 */
function requireBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}.`)
  }
}

/**
 * Creates an opaque deterministic policy fingerprint.
 *
 * @param teamId - Team receiving the effective policy.
 * @param settings - Fully resolved settings.
 * @param provenance - Applied policy layers.
 * @returns Compact fingerprint.
 */
function createEffectivePolicyFingerprint(
  teamId: string,
  settings: FocusPolicySettings,
  provenance: readonly FocusPolicyProvenance[],
): string {
  return `focus-policy-v2-${stableDigest(stableCanonicalJson({
    provenance,
    settings,
    teamId,
  }))}`
}

/**
 * Computes a collision-resistant deterministic digest for persisted evidence.
 *
 * @param value - Canonically ordered evidence string.
 * @returns Lowercase SHA-256 digest.
 */
function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Serializes JSON-compatible evidence with recursively sorted object keys.
 *
 * @param value - Aggregate evidence whose object insertion order is not semantic.
 * @returns Canonical JSON text suitable for deterministic hashing.
 */
function stableCanonicalJson(value: unknown): string {
  const serialized = serializeCanonicalJsonValue(value)
  if (serialized === undefined) {
    throw new TypeError('Focus hash evidence must be JSON serializable.')
  }
  return serialized
}

/**
 * Serializes one JSON value while omitting unsupported object properties.
 *
 * @param value - Candidate JSON value.
 * @returns Canonical JSON text, or undefined for values JSON omits from objects.
 */
function serializeCanonicalJsonValue(value: unknown): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Focus hash evidence cannot contain bigint values.')
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonicalJsonValue(entry) ?? 'null').join(',')}]`
  }

  const entries = Object.entries(value)
    .sort(([leftKey], [rightKey]) => compareStrings(leftKey, rightKey))
    .flatMap(([key, entry]) => {
      const serialized = serializeCanonicalJsonValue(entry)
      return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`]
    })
  return `{${entries.join(',')}}`
}

/**
 * Maps snapshot evidence to a positive safe integer for the public concurrency token.
 *
 * @param value - Canonically ordered aggregate evidence.
 * @returns Positive integer using 52 bits of a SHA-256 digest.
 */
function stableSafeIntegerDigest(value: string): number {
  const valueFromDigest = Number.parseInt(stableDigest(value).slice(0, 13), 16)
  return valueFromDigest === 0 ? 1 : valueFromDigest
}

/**
 * Computes a compact deterministic positive integer from a string.
 *
 * @param value - Stable evidence string.
 * @returns Positive integer below 2^31-1.
 */
function stableNumericHash(value: string): number {
  const modulus = 2_147_483_647
  let hash = 17
  for (const character of value) {
    hash = (hash * 131 + (character.codePointAt(0) ?? 0)) % modulus
  }
  return hash === 0 ? 1 : hash
}

/**
 * Compares strings with code-unit ordering independent of the runtime locale.
 *
 * @param left - Left value.
 * @param right - Right value.
 * @returns Negative, zero, or positive comparison result.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Orders signals by category, occurrence, and stable identifier.
 *
 * @param left - Left signal.
 * @param right - Right signal.
 * @returns Stable comparison result.
 */
function compareSignals(left: FocusSignal, right: FocusSignal): number {
  return signalOrder(left.type) - signalOrder(right.type) ||
    compareStrings(left.source.occurredAt, right.source.occurredAt) ||
    compareStrings(left.id, right.id)
}

/**
 * Returns the stable display order of a signal category.
 *
 * @param type - Signal category.
 * @returns Zero-based order index.
 */
function signalOrder(type: FocusSignalType): number {
  switch (type) {
    case 'blocker': return 0
    case 'urgent': return 1
    case 'overdue': return 2
    case 'due-soon': return 3
    case 'approval': return 4
    case 'review-request': return 5
    case 'mention': return 6
    case 'sla': return 7
    case 'cycle': return 8
  }
}

/**
 * Precomputes source indexes used by Work Item projections.
 *
 * @param input - Queue projection input.
 * @param now - Normalized evaluation instant.
 * @param evaluatedAt - Canonical evaluation timestamp.
 * @param workItems - Non-archived canonical Work Items.
 * @returns Immutable-by-convention projection context.
 */
function createProjectionContext(
  input: CreateFocusQueueInput,
  now: Date,
  evaluatedAt: string,
  viewerMemberKey: string,
  workItems: readonly CanonicalWorkItem[],
): FocusProjectionContext {
  const approvalsByWorkItemKey = new Map<string, ApprovalRequest[]>()
  for (const approval of input.reviewerApprovals) {
    if (approval.teamId === undefined || approval.issueId === undefined) continue
    appendMapValue(
      approvalsByWorkItemKey,
      createWorkItemKey(approval.teamId, approval.issueId),
      approval,
    )
  }

  const notificationsByWorkItemKey = new Map<string, NotificationItem[]>()
  for (const notification of input.notifications) {
    if (notification.teamId === undefined || notification.issueId === undefined) continue
    appendMapValue(
      notificationsByWorkItemKey,
      createWorkItemKey(notification.teamId, notification.issueId),
      notification,
    )
  }

  const planningLinksByWorkItemKey = new Map<
    string,
    PlanningSnapshot['workItemLinks'][number][]
  >()
  for (const link of input.planning.workItemLinks) {
    appendMapValue(
      planningLinksByWorkItemKey,
      createWorkItemKey(link.teamId, link.workItemId),
      link,
    )
  }

  const planningDependenciesBySuccessorKey = new Map<
    string,
    PlanningSnapshot['workItemDependencies'][number][]
  >()
  for (const dependency of input.planning.workItemDependencies) {
    appendMapValue(
      planningDependenciesBySuccessorKey,
      createWorkItemKey(
        dependency.successor.teamId,
        dependency.successor.workItemId,
      ),
      dependency,
    )
  }

  return {
    now,
    evaluatedAt,
    viewerMemberKey,
    planning: input.planning,
    workItemsByKey: new Map(
      workItems.map((workItem) => [createWorkItemKey(workItem.teamId, workItem.id), workItem]),
    ),
    relationGraphsByTeamId: new Map(
      (input.relationGraphs ?? []).map((graph) => [graph.teamId, graph]),
    ),
    planningWorkItemsByKey: new Map(
      input.planning.workItems.map((workItem) => [
        createWorkItemKey(workItem.teamId, workItem.id),
        workItem,
      ]),
    ),
    planningLinksByWorkItemKey,
    planningDependenciesBySuccessorKey,
    planningEntitiesById: new Map(
      input.planning.entities.map((entity) => [entity.id, entity]),
    ),
    approvalsByWorkItemKey,
    notificationsByWorkItemKey,
  }
}

/**
 * Appends one value to an array-valued map.
 *
 * @param map - Mutable grouping map.
 * @param key - Group identity.
 * @param value - Value to append.
 */
function appendMapValue<Value>(
  map: Map<string, Value[]>,
  key: string,
  value: Value,
): void {
  const values = map.get(key)
  if (values === undefined) {
    map.set(key, [value])
    return
  }
  values.push(value)
}

/**
 * Projects one canonical Work Item when it is owned by or directly relevant to the viewer.
 *
 * @param input - Queue input containing recipient state maps.
 * @param context - Precomputed canonical source indexes.
 * @param workItem - Work Item being evaluated.
 * @param policy - Effective Team/user policy.
 * @param snooze - Current recipient snooze or tombstone.
 * @returns Projected item and recurrence evidence, or undefined when irrelevant.
 */
function projectFocusItem(
  input: CreateFocusQueueInput,
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  policy: FocusEffectivePolicy,
  snooze: FocusSnoozeRecord | undefined,
): ProjectedFocusItem | undefined {
  const key = createWorkItemKey(workItem.teamId, workItem.id)
  const ownedByViewer = normalizeFocusMemberKey(workItem.assigneeUserId) ===
    context.viewerMemberKey
  const projectedSignals = createProjectedSignals(
    context,
    workItem,
    policy,
    ownedByViewer,
  )
  const signals = projectedSignals.map((projected) => projected.signal)
  const terminal = isTerminalWorkItem(workItem)
  if (terminal && !isWithinDoneRetention(workItem.updatedAt, context.now)) return undefined
  const directlyRelevant = ownedByViewer || signals.some((signal) =>
    signal.type === 'review-request' || signal.type === 'mention'
  )
  if (!directlyRelevant || (!terminal && signals.length === 0)) return undefined

  const canWrite = input.canWriteByWorkItemKey[key] === true
  const canApprove = input.canApproveByWorkItemKey[key] === true
  const canWatch = input.canWatchByWorkItemKey[key] === true
  const capabilities = createCapabilities(
    terminal,
    canWrite,
    canWatch,
    ownedByViewer,
    signals,
  )
  const actionability = createActionability(
    terminal,
    canWrite,
    canApprove,
    capabilities,
    signals,
  )
  const rank = createFocusRank(projectedSignals, policy.settings.weights, key)
  const causeFingerprint = createFocusCauseFingerprint(signals)
  const activeSnooze = isActiveMatchingSnooze(snooze, causeFingerprint, context.now)
  const section = selectFocusSection(
    terminal,
    activeSnooze,
    actionability,
    signals,
    rank.score,
    policy.settings.nowScoreThreshold,
  )
  const watching = input.watchingByWorkItemKey[key] === true
  const snoozeRevision = snooze?.version ?? 0
  const version = createFocusItemVersion({
    actionability,
    capabilities,
    causeFingerprint,
    policy,
    rank,
    section,
    signals,
    snooze,
    watching,
    workItem,
  })
  const item: FocusItem = {
    schemaVersion: FOCUS_SCHEMA_VERSION,
    id: `focus-item:${stableNumericHash(context.viewerMemberKey).toString(36)}:${encodeURIComponent(workItem.teamId)}:${encodeURIComponent(workItem.id)}`,
    version,
    snoozeRevision,
    section,
    workItem,
    signals,
    rank,
    capabilities,
    actionability,
    effectivePolicyId: policy.id,
    ...(activeSnooze && snooze?.snoozedUntil !== undefined
      ? { snoozedUntil: snooze.snoozedUntil }
      : {}),
    watching,
    updatedAt: context.evaluatedAt,
  }
  return { item, causeFingerprint }
}

/** Aggregate evidence used to create one optimistic Focus snapshot version. */
type CreateFocusItemVersionInput = {
  /** Current actionability projection. */
  actionability: FocusActionability
  /** Current authorized action projection. */
  capabilities: FocusItemCapabilities
  /** Exact active signal-cause fingerprint. */
  causeFingerprint: string
  /** Effective Team/user policy used for ranking. */
  policy: FocusEffectivePolicy
  /** Current public rank and tie-break evidence. */
  rank: FocusRankBreakdown
  /** Current queue section. */
  section: FocusQueueSection
  /** Current public signal snapshots. */
  signals: readonly FocusSignal[]
  /** Current durable snooze or tombstone. */
  snooze: FocusSnoozeRecord | undefined
  /** Current watcher state. */
  watching: boolean
  /** Current canonical Work Item snapshot. */
  workItem: CanonicalWorkItem
}

/**
 * Creates a snapshot-bound version that changes with every observable aggregate input.
 *
 * @param input - Canonical item, signal, policy, capability, watch, and snooze evidence.
 * @returns Deterministic safe-integer concurrency token.
 */
function createFocusItemVersion(input: CreateFocusItemVersionInput): number {
  return stableSafeIntegerDigest(stableCanonicalJson({
    actionability: input.actionability,
    capabilities: input.capabilities,
    causeFingerprint: input.causeFingerprint,
    effectivePolicyId: input.policy.id,
    policyFingerprint: input.policy.fingerprint,
    rank: input.rank,
    section: input.section,
    signals: input.signals.map((signal) => ({
      id: signal.id,
      type: signal.type,
      source: signal.source,
      freshness: {
        ...(signal.freshness.validUntil === undefined
          ? {}
          : { validUntil: signal.freshness.validUntil }),
        ...(signal.freshness.sourceVersion === undefined
          ? {}
          : { sourceVersion: signal.freshness.sourceVersion }),
      },
      permission: signal.permission,
      resolution: signal.resolution,
    })),
    snooze: input.snooze === undefined
      ? null
      : {
          causeFingerprint: input.snooze.causeFingerprint,
          snoozedUntil: input.snooze.snoozedUntil ?? null,
          version: input.snooze.version,
        },
    watching: input.watching,
    workItem: input.workItem,
  }))
}

/**
 * Projects and deduplicates every active signal for one Work Item.
 *
 * @param context - Canonical source indexes.
 * @param workItem - Work Item being evaluated.
 * @param policy - Effective policy controlling time windows.
 * @param ownedByViewer - Whether the current viewer owns the Work Item.
 * @returns Stable deduplicated signal projections.
 */
function createProjectedSignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  policy: FocusEffectivePolicy,
  ownedByViewer: boolean,
): ProjectedSignal[] {
  if (isTerminalWorkItem(workItem)) return []
  const projected = [
    ...createOwnedWorkItemSignals(context, workItem, policy, ownedByViewer),
    ...createApprovalSignals(context, workItem, ownedByViewer),
    ...createMentionSignals(context, workItem),
  ]
  const bySignalId = new Map<string, ProjectedSignal>()
  for (const candidate of projected.sort((left, right) =>
    compareSignals(left.signal, right.signal)
  )) {
    const current = bySignalId.get(candidate.causeKey)
    if (current === undefined || candidate.sourcePriority < current.sourcePriority) {
      bySignalId.set(candidate.causeKey, candidate)
    }
  }
  return [...bySignalId.values()].sort((left, right) =>
    compareSignals(left.signal, right.signal)
  )
}

/**
 * Projects assignment-owned priority, deadline, blocker, SLA, and cycle signals.
 *
 * @param context - Canonical source indexes.
 * @param workItem - Work Item being evaluated.
 * @param policy - Effective policy controlling time windows.
 * @param ownedByViewer - Whether the current viewer owns the Work Item.
 * @returns Owned-work signal projections.
 */
function createOwnedWorkItemSignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  policy: FocusEffectivePolicy,
  ownedByViewer: boolean,
): ProjectedSignal[] {
  if (!ownedByViewer) return []
  return [
    ...createPrioritySignal(context, workItem),
    ...createDeadlineSignal(context, workItem, policy.settings.dueSoonDays),
    ...createRelationBlockerSignals(context, workItem),
    ...createBlockerSignals(context, workItem),
    ...createSlaSignal(context, workItem, policy),
    ...createCycleSignals(context, workItem, policy.settings.cycleDueSoonDays),
  ]
}

/**
 * Projects high priority as the first-schema urgent signal.
 *
 * @param context - Projection context.
 * @param workItem - Owned Work Item.
 * @returns Zero or one urgent signal.
 */
function createPrioritySignal(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
): ProjectedSignal[] {
  if (workItem.priority !== 'high') return []
  const occurredAt = selectCausalTimestamp(workItem.priorityUpdatedAt, workItem.createdAt)
  return [createProjectedSignal({
    type: 'urgent',
    sourceKind: 'work-item',
    sourceId: createCausalSourceId(
      `${createWorkItemSourceId(workItem)}:priority:high`,
      occurredAt,
    ),
    occurredAt,
    evaluatedAt: context.evaluatedAt,
    sourceVersion: workItem.revision,
    deepLink: createWorkItemDeepLink(workItem),
    resolutionCondition: 'priority-lowered',
  })]
}

/**
 * Projects overdue or due-soon state using the Work Item's canonical timezone.
 *
 * @param context - Projection context.
 * @param workItem - Owned Work Item.
 * @param dueSoonDays - Inclusive local calendar-day attention window.
 * @returns Zero or one deadline signal.
 */
function createDeadlineSignal(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  dueSoonDays: number,
): ProjectedSignal[] {
  if (workItem.dueDate === '') return []
  const localToday = workItemScheduleInstantToLocalDate(
    context.now,
    workItem.schedule.calendarPolicy,
  )
  const dueSoonEnd = addWorkItemScheduleCalendarDays(localToday, dueSoonDays)
  const type: FocusSignalType | undefined = workItem.dueDate < localToday
    ? 'overdue'
    : workItem.dueDate <= dueSoonEnd
      ? 'due-soon'
      : undefined
  if (type === undefined) return []
  const occurredAt = selectCausalTimestamp(workItem.dueDateUpdatedAt, workItem.createdAt)
  return [createProjectedSignal({
    type,
    sourceKind: 'work-item',
    sourceId: createCausalSourceId(
      `${createWorkItemSourceId(workItem)}:deadline:${encodeURIComponent(workItem.dueDate)}`,
      occurredAt,
    ),
    occurredAt,
    evaluatedAt: context.evaluatedAt,
    sourceVersion: workItem.revision,
    deepLink: createWorkItemDeepLink(workItem),
    resolutionCondition: 'deadline-changed',
    deadline: workItem.dueDate,
  })]
}

/**
 * Projects real incoming unresolved Planning dependencies as blockers.
 *
 * @param context - ACL-filtered Planning context.
 * @param workItem - Successor Work Item.
 * @returns One blocker signal per visible unresolved predecessor edge.
 */
function createBlockerSignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
): ProjectedSignal[] {
  const successorKey = createWorkItemKey(workItem.teamId, workItem.id)
  const dependencies = context.planningDependenciesBySuccessorKey.get(successorKey) ?? []
  return dependencies.flatMap((dependency) => {
    const predecessorKey = createWorkItemKey(
      dependency.predecessor.teamId,
      dependency.predecessor.workItemId,
    )
    const predecessor = context.planningWorkItemsByKey.get(predecessorKey)
    if (predecessor === undefined || isTerminalStatus(predecessor.statusCategory)) return []
    return [createProjectedSignal({
      type: 'blocker',
      sourceKind: 'planning-dependency',
      sourceId: createCausalSourceId(dependency.id, dependency.createdAt),
      occurredAt: dependency.createdAt,
      evaluatedAt: context.evaluatedAt,
      sourceVersion: context.planning.revision,
      deepLink: createWorkItemDeepLink(workItem),
      resolutionCondition: 'blocker-completed',
      causeKey: `blocker:${successorKey}:${predecessorKey}`,
      sourcePriority: 1,
      ...(workItem.dueDate === '' ? {} : { deadline: workItem.dueDate }),
    })]
  })
}

/**
 * Projects canonical semantic `blockedBy` relations against visible predecessors.
 *
 * @param context - ACL-filtered Work Item context.
 * @param workItem - Relation source and blocked successor.
 * @returns One blocker signal per visible unresolved semantic predecessor.
 */
function createRelationBlockerSignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
): ProjectedSignal[] {
  const successorKey = createWorkItemKey(workItem.teamId, workItem.id)
  const graph = context.relationGraphsByTeamId.get(workItem.teamId)
  if (graph !== undefined) {
    return graph.relations.flatMap((relation) => {
      if (
        relation.sourceWorkItemId !== workItem.id ||
        relation.type !== 'blockedBy'
      ) return []
      const predecessorId = relation.targetWorkItemId
      const occurredAt = relation.createdAt
      if (
        predecessorId === undefined ||
        predecessorId.length === 0 ||
        occurredAt === undefined ||
        Number.isNaN(Date.parse(occurredAt))
      ) return []
      return createSemanticRelationBlockerSignal(
        context,
        workItem,
        successorKey,
        predecessorId,
        occurredAt,
        graph.graphRevision,
      )
    })
  }
  return []
}

/**
 * Projects one semantic blocker after validating its predecessor remains visible and active.
 *
 * @param context - Permission-filtered canonical source indexes.
 * @param workItem - Blocked successor Work Item.
 * @param successorKey - Team-qualified successor identity used only for deduplication.
 * @param predecessorId - Team-local predecessor identifier.
 * @param occurredAt - Canonical relation creation time.
 * @param graphRevision - Relation graph generation observed with the source.
 * @returns Zero or one unresolved semantic blocker signal.
 */
function createSemanticRelationBlockerSignal(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  successorKey: string,
  predecessorId: string,
  occurredAt: string,
  graphRevision: number | undefined,
): ProjectedSignal[] {
  const predecessorKey = createWorkItemKey(workItem.teamId, predecessorId)
  const canonicalPredecessor = context.workItemsByKey.get(predecessorKey)
  const planningPredecessor = context.planningWorkItemsByKey.get(predecessorKey)
  const predecessorStatus = canonicalPredecessor?.statusCategory ??
    planningPredecessor?.statusCategory
  if (predecessorStatus === undefined || isTerminalStatus(predecessorStatus)) return []
  return [createProjectedSignal({
    type: 'blocker',
    sourceKind: 'work-item-relation',
    sourceId: createCausalSourceId(
      `${createWorkItemSourceId(workItem)}:blockedBy:${encodeURIComponent(predecessorId)}`,
      occurredAt,
    ),
    occurredAt,
    evaluatedAt: context.evaluatedAt,
    sourceVersion: graphRevision,
    deepLink: createWorkItemDeepLink(workItem),
    resolutionCondition: 'blocker-completed',
    causeKey: `blocker:${successorKey}:${predecessorKey}`,
    sourcePriority: 0,
    ...(workItem.dueDate === '' ? {} : { deadline: workItem.dueDate }),
  })]
}

/**
 * Projects pending approval and current-reviewer signals without trusting caller identity fields.
 *
 * @param context - Projection context containing reauthorized approvals.
 * @param workItem - Related canonical Work Item.
 * @param ownedByViewer - Whether approval waiting affects the viewer's owned work.
 * @returns Deduplicable approval and review signals.
 */
function createApprovalSignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  ownedByViewer: boolean,
): ProjectedSignal[] {
  const key = createWorkItemKey(workItem.teamId, workItem.id)
  const approvals = context.approvalsByWorkItemKey.get(key) ?? []
  const viewerReviewApprovals = approvals.filter((approval) =>
    approval.status === 'pending' && approval.reviewers.some((reviewer) =>
      normalizeFocusMemberKey(reviewer.memberKey) === context.viewerMemberKey &&
      reviewer.status === 'pending'
    )
  )
  const aggregateSignals = ownedByViewer
    ? createApprovalSummarySignals(context, workItem, viewerReviewApprovals)
    : []
  const reviewerSignals = approvals.flatMap((approval) => {
    if (approval.status !== 'pending') return []
    const reviewer = approval.reviewers.find((candidate) =>
      normalizeFocusMemberKey(candidate.memberKey) === context.viewerMemberKey &&
      candidate.status === 'pending'
    )
    const sourceKind: FocusSignalSourceKind = reviewer === undefined
      ? 'approval'
      : 'review-request'
    const primaryType: FocusSignalType | undefined = reviewer !== undefined
      ? 'review-request'
      : ownedByViewer
        ? 'approval'
        : undefined
    if (primaryType === undefined) return []
    const resolutionCondition: FocusSignalResolutionCondition = reviewer === undefined
      ? 'approval-decided'
      : 'review-completed'
    const signals = [createProjectedSignal({
      type: primaryType,
      sourceKind,
      sourceId: `${approval.id}:revision:${approval.revision}`,
      occurredAt: approval.createdAt,
      evaluatedAt: context.evaluatedAt,
      sourceVersion: approval.revision,
      validUntil: approval.dueAt,
      deepLink: createWorkItemDeepLink(workItem),
      resolutionCondition,
      deadline: approval.dueAt,
    })]
    if (new Date(approval.dueAt).getTime() < context.now.getTime()) {
      signals.push(createProjectedSignal({
        type: 'overdue',
        sourceKind,
        sourceId: `${approval.id}:revision:${approval.revision}:deadline`,
        occurredAt: approval.dueAt,
        evaluatedAt: context.evaluatedAt,
        sourceVersion: approval.revision,
        deepLink: createWorkItemDeepLink(workItem),
        resolutionCondition,
        deadline: approval.dueAt,
      }))
    }
    return signals
  })
  return [...aggregateSignals, ...reviewerSignals]
}

/**
 * Projects an owned Work Item's approval aggregate for pending approvals not represented by a viewer review request.
 *
 * @param context - Projection context.
 * @param workItem - Owned Work Item with an optional approval summary.
 * @param excludedApprovals - Viewer-specific pending approvals already projected separately.
 * @returns Pending approval and optional overdue signals.
 */
function createApprovalSummarySignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  excludedApprovals: readonly ApprovalRequest[] = [],
): ProjectedSignal[] {
  const summary = workItem.approvalSummary
  if (summary === undefined) return []
  const excludedPendingCount = excludedApprovals.filter((approval) =>
    approval.status === 'pending'
  ).length
  const pendingCount = Math.max(0, summary.pendingCount - excludedPendingCount)
  if (pendingCount < 1) return []
  const excludedOverdueCount = excludedApprovals.filter((approval) =>
    approval.status === 'pending' &&
    new Date(approval.dueAt).getTime() < context.now.getTime()
  ).length
  const overdueCount = Math.max(0, summary.overdueCount - excludedOverdueCount)
  const remainingDueDates = summary.pendingDueAt === undefined
    ? summary.nextDueAt === undefined ? [] : [summary.nextDueAt]
    : [...summary.pendingDueAt]
  for (const excludedApproval of excludedApprovals) {
    if (excludedApproval.status !== 'pending') continue
    const excludedDueAtIndex = remainingDueDates.indexOf(excludedApproval.dueAt)
    if (excludedDueAtIndex >= 0) remainingDueDates.splice(excludedDueAtIndex, 1)
  }
  const nextDueAt = remainingDueDates.sort()[0]
  const occurredAt = selectCausalTimestamp(summary.updatedAt, workItem.createdAt)
  const sourceId = createCausalSourceId([
    createWorkItemSourceId(workItem),
    'approval-summary',
    pendingCount,
    overdueCount,
    nextDueAt ?? '',
  ].join(':'), occurredAt)
  const signals = [createProjectedSignal({
    type: 'approval',
    sourceKind: 'approval',
    sourceId,
    occurredAt,
    evaluatedAt: context.evaluatedAt,
    ...(nextDueAt === undefined ? {} : { validUntil: nextDueAt }),
    deepLink: createWorkItemDeepLink(workItem),
    resolutionCondition: 'approval-decided',
    ...(nextDueAt === undefined ? {} : { deadline: nextDueAt }),
  })]
  if (overdueCount > 0) {
    signals.push(createProjectedSignal({
      type: 'overdue',
      sourceKind: 'approval',
      sourceId: `${sourceId}:deadline`,
      occurredAt: nextDueAt ?? occurredAt,
      evaluatedAt: context.evaluatedAt,
      deepLink: createWorkItemDeepLink(workItem),
      resolutionCondition: 'approval-decided',
      ...(nextDueAt === undefined ? {} : { deadline: nextDueAt }),
    }))
  }
  return signals
}

/**
 * Projects visible mention events independently from their Inbox presentation state.
 *
 * @param context - Projection context containing permission-filtered notifications.
 * @param workItem - Mentioned canonical Work Item.
 * @returns Mention signals backed by durable Inbox events.
 */
function createMentionSignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
): ProjectedSignal[] {
  const key = createWorkItemKey(workItem.teamId, workItem.id)
  return (context.notificationsByWorkItemKey.get(key) ?? []).flatMap((notification) => {
    if (!notification.reasons.includes('mention')) return []
    return [createProjectedSignal({
      type: 'mention',
      sourceKind: 'notification',
      sourceId: notification.eventId,
      eventId: notification.eventId,
      occurredAt: notification.occurredAt,
      evaluatedAt: context.evaluatedAt,
      deepLink: createInboxEventDeepLink(notification.eventId, notification.state),
      resolutionCondition: 'source-removed',
    })]
  })
}

/**
 * Projects an SLA breach from Work Item age and the effective policy window.
 *
 * @param context - Projection context.
 * @param workItem - Owned unfinished Work Item.
 * @param policy - Effective SLA policy.
 * @returns Zero or one SLA signal.
 */
function createSlaSignal(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  policy: FocusEffectivePolicy,
): ProjectedSignal[] {
  const createdAt = new Date(workItem.createdAt)
  if (Number.isNaN(createdAt.getTime())) return []
  const dueAt = new Date(
    createdAt.getTime() + policy.settings.slaHours * 60 * 60 * 1_000,
  )
  if (dueAt.getTime() > context.now.getTime()) return []
  return [createProjectedSignal({
    type: 'sla',
    sourceKind: 'service-level-policy',
    sourceId: `${policy.id}:${policy.fingerprint}:${createWorkItemSourceId(workItem)}:${encodeURIComponent(dueAt.toISOString())}`,
    occurredAt: dueAt.toISOString(),
    evaluatedAt: context.evaluatedAt,
    deepLink: createWorkItemDeepLink(workItem),
    resolutionCondition: 'sla-restored',
    deadline: dueAt.toISOString(),
  })]
}

/**
 * Projects active cycles whose forecast boundary is inside the effective attention window.
 *
 * @param context - ACL-filtered Planning context.
 * @param workItem - Linked owned Work Item.
 * @param cycleDueSoonDays - Inclusive local calendar-day cycle window.
 * @returns One signal per visible qualifying cycle.
 */
function createCycleSignals(
  context: FocusProjectionContext,
  workItem: CanonicalWorkItem,
  cycleDueSoonDays: number,
): ProjectedSignal[] {
  const key = createWorkItemKey(workItem.teamId, workItem.id)
  const localToday = workItemScheduleInstantToLocalDate(
    context.now,
    workItem.schedule.calendarPolicy,
  )
  const attentionEnd = addWorkItemScheduleCalendarDays(localToday, cycleDueSoonDays)
  return (context.planningLinksByWorkItemKey.get(key) ?? []).flatMap((link) => {
    if (link.cycleId === undefined) return []
    const cycle = context.planningEntitiesById.get(link.cycleId)
    if (
      cycle === undefined ||
      cycle.type !== 'cycle' ||
      cycle.status !== 'active' ||
      cycle.forecast.endDate > attentionEnd
    ) return []
    return [createProjectedSignal({
      type: 'cycle',
      sourceKind: 'planning-cycle',
      sourceId: `${cycle.id}:${encodeURIComponent(link.createdAt)}:${encodeURIComponent(cycle.forecast.endDate)}`,
      occurredAt: link.createdAt,
      evaluatedAt: context.evaluatedAt,
      sourceVersion: context.planning.revision,
      deepLink: createWorkItemDeepLink(workItem),
      resolutionCondition: 'cycle-changed',
      deadline: cycle.forecast.endDate,
    })]
  })
}

/**
 * Constructs one public signal with a stable deduplication identity.
 *
 * @param input - Canonical source and resolution evidence.
 * @returns Signal plus internal deadline evidence.
 */
function createProjectedSignal(input: CreateProjectedSignalInput): ProjectedSignal {
  const signal: FocusSignal = {
    id: `${input.type}:${input.sourceKind}:${input.sourceId}`,
    type: input.type,
    source: {
      kind: input.sourceKind,
      id: input.sourceId,
      ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
      occurredAt: input.occurredAt,
      ...(input.deepLink === undefined ? {} : { deepLink: input.deepLink }),
    },
    freshness: {
      evaluatedAt: input.evaluatedAt,
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.sourceVersion === undefined ? {} : { sourceVersion: input.sourceVersion }),
    },
    permission: {
      canOpenSource: input.deepLink !== undefined,
    },
    resolution: {
      condition: input.resolutionCondition,
      status: 'open',
    },
  }
  return {
    signal,
    causeKey: input.causeKey ?? signal.id,
    sourcePriority: input.sourcePriority ?? 0,
    ...(input.deadline === undefined ? {} : { deadline: input.deadline }),
  }
}

/**
 * Creates transparent rank components and deterministic tie evidence.
 *
 * @param projectedSignals - Deduplicated signals with deadline evidence.
 * @param weights - Effective signal weights.
 * @param workItemKey - Stable final tie-break identity.
 * @returns Rank breakdown.
 */
function createFocusRank(
  projectedSignals: readonly ProjectedSignal[],
  weights: FocusSignalWeights,
  workItemKey: string,
): FocusRankBreakdown {
  const components: FocusRankComponent[] = projectedSignals.map(({ signal }) => {
    const weight = readSignalWeight(weights, signal.type)
    return {
      signalId: signal.id,
      signalType: signal.type,
      weight,
      value: 1,
      contribution: weight,
    }
  })
  const score = components.reduce((total, component) => total + component.contribution, 0)
  const deadlines = projectedSignals.flatMap((signal) =>
    signal.deadline === undefined ? [] : [signal.deadline]
  ).sort(compareStrings)
  const occurrences = projectedSignals
    .map((signal) => signal.signal.source.occurredAt)
    .sort(compareStrings)
  return {
    score,
    components,
    tieBreaker: [deadlines[0] ?? '9999-12-31T23:59:59.999Z', occurrences[0] ?? '', workItemKey]
      .join('|'),
  }
}

/**
 * Reads the effective weight for one signal type.
 *
 * @param weights - Complete effective weight set.
 * @param type - Signal category.
 * @returns Numeric effective weight.
 */
function readSignalWeight(weights: FocusSignalWeights, type: FocusSignalType): number {
  switch (type) {
    case 'blocker': return weights.blocker
    case 'urgent': return weights.urgent
    case 'overdue': return weights.overdue
    case 'due-soon': return weights.dueSoon
    case 'approval': return weights.approval
    case 'review-request': return weights.reviewRequest
    case 'mention': return weights.mention
    case 'sla': return weights.sla
    case 'cycle': return weights.cycle
  }
}

/**
 * Derives server-authorized capabilities from current lifecycle and write permission.
 *
 * @param terminal - Whether the Work Item is terminal.
 * @param canWrite - Whether canonical Work Item writes are authorized.
 * @param canWatch - Whether Collaboration authorizes watcher mutations.
 * @param ownedByViewer - Whether the current viewer is already assigned.
 * @param signals - Current signal sources.
 * @returns Capability set returned by the Focus contract.
 */
function createCapabilities(
  terminal: boolean,
  canWrite: boolean,
  canWatch: boolean,
  ownedByViewer: boolean,
  signals: readonly FocusSignal[],
): FocusItemCapabilities {
  const canMutateWorkItem = !terminal && canWrite
  return {
    complete: canMutateWorkItem,
    assign: canMutateWorkItem && !ownedByViewer,
    changeStatus: canWrite,
    schedule: canMutateWorkItem,
    snooze: !terminal,
    watch: !terminal && canWatch,
    openSource: signals.some((signal) => signal.permission.canOpenSource),
  }
}

/**
 * Explains whether the viewer can make progress on the current item.
 *
 * @param terminal - Whether the Work Item is terminal.
 * @param canWrite - Whether canonical Work Item writes are authorized.
 * @param capabilities - Derived action capabilities.
 * @param signals - Current signals.
 * @returns Stable actionability state.
 */
function createActionability(
  terminal: boolean,
  canWrite: boolean,
  canApprove: boolean,
  capabilities: FocusItemCapabilities,
  signals: readonly FocusSignal[],
): FocusActionability {
  if (terminal) {
    return { actionable: false, reasons: ['work-item-completed'] }
  }
  const hasReviewAction = capabilities.openSource && signals.some((signal) =>
    signal.type === 'mention' ||
    (signal.type === 'review-request' && canApprove)
  )
  if (signals.some((signal) => signal.type === 'blocker') && !hasReviewAction) {
    return { actionable: false, reasons: ['blocked'] }
  }
  if (signals.some((signal) => signal.type === 'approval') && !hasReviewAction) {
    return { actionable: false, reasons: ['awaiting-external-action'] }
  }
  if (!canWrite && !hasReviewAction) {
    return { actionable: false, reasons: ['no-permitted-primary-action'] }
  }
  return { actionable: true, reasons: [] }
}

/**
 * Selects the current section after lifecycle, snooze, and actionability checks.
 *
 * @param terminal - Whether the Work Item is terminal.
 * @param snoozed - Whether current causes exactly match an active snooze.
 * @param actionability - Current ability to make progress.
 * @param signals - Current signal set.
 * @param score - Deterministic rank score.
 * @param nowThreshold - Effective Now threshold.
 * @returns Stable queue section.
 */
function selectFocusSection(
  terminal: boolean,
  snoozed: boolean,
  actionability: FocusActionability,
  signals: readonly FocusSignal[],
  score: number,
  nowThreshold: number,
): FocusQueueSection {
  if (terminal) return 'done'
  if (snoozed) return 'snoozed'
  if (!actionability.actionable) return 'waiting'
  if (
    score >= nowThreshold ||
    signals.some((signal) => signal.type === 'overdue' || signal.type === 'review-request')
  ) return 'now'
  return 'next'
}

/**
 * Checks whether a persisted snooze still applies to the exact active cause set.
 *
 * @param snooze - Current snooze or version-preserving tombstone.
 * @param causeFingerprint - Current cause fingerprint.
 * @param now - Evaluation instant.
 * @returns True only for an unexpired exact-cause snooze.
 */
function isActiveMatchingSnooze(
  snooze: FocusSnoozeRecord | undefined,
  causeFingerprint: string,
  now: Date,
): boolean {
  if (snooze?.snoozedUntil === undefined || snooze.causeFingerprint !== causeFingerprint) {
    return false
  }
  const wakeTime = new Date(snooze.snoozedUntil).getTime()
  return !Number.isNaN(wakeTime) && wakeTime > now.getTime()
}

/**
 * Checks whether a canonical Work Item is in a terminal workflow category.
 *
 * @param workItem - Canonical Work Item.
 * @returns True for completed or canceled items.
 */
function isTerminalWorkItem(workItem: CanonicalWorkItem): boolean {
  return isTerminalStatus(workItem.statusCategory)
}

/**
 * Checks whether a workflow category is terminal.
 *
 * @param status - Canonical workflow category.
 * @returns True for completed or canceled categories.
 */
function isTerminalStatus(status: CanonicalWorkItem['statusCategory']): boolean {
  return status === 'completed' || status === 'canceled'
}

/**
 * Checks whether a terminal Work Item remains inside the inclusive Done retention window.
 *
 * @param updatedAt - Canonical timestamp of the latest terminal Work Item update.
 * @param now - Stable queue evaluation instant.
 * @returns True when the timestamp is valid and not older than the exact 30-day boundary.
 */
function isWithinDoneRetention(updatedAt: string, now: Date): boolean {
  const updatedAtTime = Date.parse(updatedAt)
  return !Number.isNaN(updatedAtTime) &&
    updatedAtTime >= now.getTime() - FOCUS_DONE_RETENTION_MILLISECONDS
}

/**
 * Creates the authorized Work Item deep link shared by source signals.
 *
 * @param workItem - Canonical Work Item.
 * @returns Application-relative Work Item link.
 */
function createWorkItemDeepLink(workItem: CanonicalWorkItem): string {
  return `/teams/${encodeURIComponent(workItem.teamId)}/issues?issueId=${encodeURIComponent(workItem.id)}`
}

/**
 * Creates a public source identifier without leaking internal map separators.
 *
 * @param workItem - Canonical Work Item source.
 * @returns Stable URI-safe Team-qualified source identity.
 */
function createWorkItemSourceId(workItem: CanonicalWorkItem): string {
  return `${encodeURIComponent(workItem.teamId)}/${encodeURIComponent(workItem.id)}`
}

/**
 * Selects a source-owned causal timestamp with a stable creation-time compatibility fallback.
 *
 * @param timestamp - Field-specific mutation timestamp from the canonical source.
 * @param createdAt - Canonical source creation timestamp for pre-field records.
 * @returns Field-specific timestamp, or the stable source creation timestamp.
 */
function selectCausalTimestamp(timestamp: string | undefined, createdAt: string): string {
  return timestamp === undefined || Number.isNaN(Date.parse(timestamp)) ? createdAt : timestamp
}

/**
 * Binds a stable source identity to the occurrence timestamp that created its current cause.
 *
 * @param sourceId - Stable source record or relationship identifier.
 * @param occurredAt - Source-owned causal occurrence timestamp.
 * @returns Recurrence-sensitive source identity.
 */
function createCausalSourceId(sourceId: string, occurredAt: string): string {
  return `${sourceId}:occurred-at:${encodeURIComponent(occurredAt)}`
}

/**
 * Creates the Inbox event path used to correlate a mention with its immutable notification.
 *
 * @param eventId - Durable notification event identifier.
 * @param state - Current Inbox presentation state used to select the matching timeline.
 * @returns Safe application-relative Inbox path.
 */
function createInboxEventDeepLink(
  eventId: string,
  state: NotificationItem['state'],
): string {
  const eventSelection = `eventId=${encodeURIComponent(eventId)}`
  return state === 'archived' || state === 'snoozed'
    ? `/inbox?${eventSelection}&filter=${state}`
    : `/inbox?${eventSelection}`
}

/**
 * Orders queue items by score, then explicit tie evidence, then stable identity.
 *
 * @param left - Left item.
 * @param right - Right item.
 * @returns Stable comparison result.
 */
function compareFocusItems(left: FocusItem, right: FocusItem): number {
  return right.rank.score - left.rank.score ||
    compareStrings(left.rank.tieBreaker, right.rank.tieBreaker) ||
    compareStrings(left.id, right.id)
}

/**
 * Normalizes recipient identity consistently with durable Focus and approval state.
 *
 * @param value - Candidate Workspace member key.
 * @returns Trimmed lowercase identity.
 */
function normalizeFocusMemberKey(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) {
    throw new TypeError('Focus viewer member key is required.')
  }
  return normalized
}
