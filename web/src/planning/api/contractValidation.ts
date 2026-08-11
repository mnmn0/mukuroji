import {
  LEGACY_PLANNING_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION,
  PLANNING_UPDATE_CONTENT_VERSION,
  type PlanningUpdate,
  type PlanningUpdateCadenceMutationResponse,
  type PlanningUpdateComment,
  type PlanningUpdateCommentPage,
  type PlanningUpdateHistoryPage,
  type PlanningUpdatePublishResponse,
  type PlanningUpdateReaction,
  type PlanningUpdateReactionPage,
  type PlanningUpdateTargetSummary,
  type PlanningSnapshot,
} from '@mukuroji/contracts'
import {
  isFiniteNumber,
  isNonnegativeSafeInteger,
  isNumberRecord,
  isOptionalString,
  isPositiveSafeInteger,
  isRecord,
  isStringArray,
} from '../../shared/api/jsonValidation'
import {
  isScheduleDependencyConstraint,
  isScheduleDependencyType,
  isWorkItemDependencyEndpoint,
  isWorkItemSchedule,
  isWorkItemScheduleDependency,
  isWorkItemScheduleDependencyConflict,
  isWorkItemStatusCategory,
} from '../../work-items/api/contractValidation'

const planningEntityTypes = new Set<string>([
  'cycle',
  'milestone',
  'release',
  'phase',
  'goal',
  'initiative',
  'roadmap',
  'portfolio',
])
const planningStatuses = new Set<string>([
  'proposed',
  'planned',
  'active',
  'paused',
  'completed',
  'canceled',
])
const planningHealthValues = new Set<string>([
  'unknown',
  'on-track',
  'at-risk',
  'off-track',
])
const planningRiskValues = new Set<string>([
  'none',
  'low',
  'medium',
  'high',
  'critical',
])
const planningUpdateStates = new Set<string>([
  'not-configured',
  'missing',
  'current',
  'overdue',
  'stale',
])

/** Returns whether a value is one Planning status update. */
function isPlanningStatusUpdate(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.message === 'string' &&
    typeof value.authorMemberKey === 'string' &&
    (
      value.health === undefined ||
      typeof value.health === 'string' && planningHealthValues.has(value.health)
    ) &&
    (
      value.risk === undefined ||
      typeof value.risk === 'string' && planningRiskValues.has(value.risk)
    ) &&
    typeof value.createdAt === 'string'
}

/** Returns whether a value is one Planning entity projection. */
function isPlanningEntity(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.type === 'string' && planningEntityTypes.has(value.type) &&
    typeof value.title === 'string' &&
    typeof value.ownerMemberKey === 'string' &&
    typeof value.status === 'string' && planningStatuses.has(value.status) &&
    typeof value.health === 'string' && planningHealthValues.has(value.health) &&
    typeof value.rollupHealth === 'string' && planningHealthValues.has(value.rollupHealth) &&
    typeof value.risk === 'string' && planningRiskValues.has(value.risk) &&
    (value.progressMode === 'automatic' || value.progressMode === 'manual') &&
    (value.manualProgress === undefined || isFiniteNumber(value.manualProgress)) &&
    isFiniteNumber(value.progress) &&
    isNonnegativeSafeInteger(value.linkedWorkItemCount) &&
    isPlanningDateRange(value.baseline) &&
    isPlanningDateRange(value.forecast) &&
    isPlanningCadence(value.cadence) &&
    (value.capacity === undefined || isNonnegativeSafeInteger(value.capacity)) &&
    (
      value.carryOverPolicy === undefined ||
      value.carryOverPolicy === 'move-incomplete' ||
      value.carryOverPolicy === 'keep-incomplete'
    ) &&
    (
      value.goalFramework === undefined ||
      value.goalFramework === 'goal' ||
      value.goalFramework === 'objective' ||
      value.goalFramework === 'key-result'
    ) &&
    Array.isArray(value.statusUpdates) &&
    value.statusUpdates.every(isPlanningStatusUpdate) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    isOptionalString(value.description) &&
    isOptionalString(value.parentId) &&
    isOptionalString(value.teamId) &&
    isOptionalString(value.projectId) &&
    isOptionalString(value.archivedAt)
}

/** Returns whether an optional value is a valid Planning cadence. */
function isPlanningCadence(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    (value.unit === 'week' || value.unit === 'month') &&
    isPositiveSafeInteger(value.count)
  )
}

/** Returns whether a value is a Project or Initiative update target. */
function isPlanningUpdateTarget(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'project') {
    return typeof value.teamId === 'string' &&
      value.teamId.length > 0 &&
      typeof value.projectId === 'string' &&
      value.projectId.length > 0
  }
  return value.type === 'initiative' &&
    typeof value.entityId === 'string' &&
    value.entityId.length > 0
}

/** Returns whether a value is a configured recurring update cadence. */
function isPlanningUpdateCadence(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.updateOwnerMemberKey === 'string' &&
    isRecord(value.cadence) &&
    isPlanningCadence(value.cadence) &&
    isIanaTimeZone(value.timeZone) &&
    isIsoTimestamp(value.nextDueAt) &&
    isNonnegativeSafeInteger(value.reminderHoursBefore) &&
    (
      value.escalationHoursAfter === undefined ||
      isNonnegativeSafeInteger(value.escalationHoursAfter)
    ) &&
    isOptionalString(value.escalationMemberKey)
}

/** Returns whether a value is a server-captured progress snapshot. */
function isPlanningUpdateProgressSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    isFiniteNumber(value.percent) &&
    value.percent >= 0 &&
    value.percent <= 100 &&
    isNonnegativeSafeInteger(value.linkedWorkItemCount)
}

/** Returns whether a value is the bounded latest-update summary. */
function isPlanningLatestUpdateSummary(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isPositiveSafeInteger(value.version) &&
    typeof value.health === 'string' && planningHealthValues.has(value.health) &&
    typeof value.risk === 'string' && planningRiskValues.has(value.risk) &&
    typeof value.summary === 'string' &&
    isPlanningUpdateProgressSnapshot(value.progressSnapshot) &&
    typeof value.authorMemberKey === 'string' &&
    isIsoTimestamp(value.coveredDueAt) &&
    isIsoTimestamp(value.createdAt)
}

/** Returns whether a value is one snapshot update-target summary. */
function isPlanningUpdateTargetSummary(
  value: unknown,
): value is PlanningUpdateTargetSummary {
  return isRecord(value) &&
    isPlanningUpdateTarget(value.target) &&
    (value.cadence === undefined || isPlanningUpdateCadence(value.cadence)) &&
    typeof value.updateState === 'string' && planningUpdateStates.has(value.updateState) &&
    isNonnegativeSafeInteger(value.latestVersion) &&
    (value.latestUpdate === undefined || isPlanningLatestUpdateSummary(value.latestUpdate)) &&
    isOptionalString(value.archivedAt) &&
    typeof value.updatedAt === 'string'
}

/** Returns whether a value is one immutable update evidence reference. */
function isPlanningUpdateEvidence(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'work-item':
      return typeof value.teamId === 'string' && typeof value.workItemId === 'string'
    case 'planning-entity':
      return typeof value.entityId === 'string'
    case 'file':
      return typeof value.fileId === 'string' && isHttpsUrl(value.url)
    case 'link':
      return isHttpsUrl(value.url) && isOptionalString(value.label)
    default:
      return false
  }
}

/** Returns whether a value is an absolute HTTPS URL accepted by evidence contracts. */
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

/** Returns whether a value is a parseable ISO-like timestamp. */
function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** Returns whether a value names an IANA time zone supported by this runtime. */
function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

/** Returns whether a value is a captured Team and Project scope. */
function isPlanningUpdateScopeSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    isOptionalString(value.teamId) &&
    isOptionalString(value.projectId)
}

/** Returns whether a value is one captured Milestone. */
function isPlanningUpdateMilestoneSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.entityId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.status === 'string' && planningStatuses.has(value.status) &&
    isPlanningDateRange(value.forecast)
}

/** Returns whether a value is one captured Planning dependency. */
function isPlanningUpdateDependencySnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.dependencyId === 'string' &&
    typeof value.predecessorId === 'string' &&
    typeof value.successorId === 'string' &&
    isScheduleDependencyType(value.type) &&
    Number.isSafeInteger(value.lagDays)
}

/** Returns whether a value is the immutable comparison context of an update. */
function isPlanningUpdateContextSnapshot(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.health === 'string' && planningHealthValues.has(value.health) &&
    typeof value.risk === 'string' && planningRiskValues.has(value.risk) &&
    isPlanningUpdateProgressSnapshot(value.progress) &&
    isPlanningUpdateScopeSnapshot(value.scope) &&
    isOptionalString(value.targetDate) &&
    Array.isArray(value.milestones) &&
    value.milestones.every(isPlanningUpdateMilestoneSnapshot) &&
    Array.isArray(value.dependencies) &&
    value.dependencies.every(isPlanningUpdateDependencySnapshot)
}

/** Returns whether a value is one immutable comparison delta. */
function isPlanningUpdateChange(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'health':
      return typeof value.before === 'string' && planningHealthValues.has(value.before) &&
        typeof value.after === 'string' && planningHealthValues.has(value.after)
    case 'risk':
      return typeof value.before === 'string' && planningRiskValues.has(value.before) &&
        typeof value.after === 'string' && planningRiskValues.has(value.after)
    case 'progress':
      return isFiniteNumber(value.before) && isFiniteNumber(value.after)
    case 'target-date':
      return isOptionalString(value.before) && isOptionalString(value.after)
    case 'scope':
      return isPlanningUpdateScopeSnapshot(value.before) &&
        isPlanningUpdateScopeSnapshot(value.after)
    case 'milestones':
    case 'dependencies':
      return isStringArray(value.addedIds) &&
        isStringArray(value.removedIds) &&
        isStringArray(value.changedIds)
    default:
      return false
  }
}

/** Returns whether a value is one full immutable structured update. */
function isPlanningUpdate(value: unknown): value is PlanningUpdate {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isPlanningUpdateTarget(value.target) &&
    isPositiveSafeInteger(value.version) &&
    value.contentVersion === PLANNING_UPDATE_CONTENT_VERSION &&
    value.origin === 'manual' &&
    typeof value.health === 'string' && planningHealthValues.has(value.health) &&
    typeof value.risk === 'string' && planningRiskValues.has(value.risk) &&
    typeof value.summary === 'string' &&
    typeof value.riskSummary === 'string' &&
    typeof value.decisionSummary === 'string' &&
    typeof value.helpNeeded === 'string' &&
    typeof value.nextAction === 'string' &&
    isPlanningUpdateProgressSnapshot(value.progressSnapshot) &&
    isPlanningUpdateContextSnapshot(value.contextSnapshot) &&
    Array.isArray(value.changes) &&
    value.changes.every(isPlanningUpdateChange) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isPlanningUpdateEvidence) &&
    typeof value.authorMemberKey === 'string' &&
    isIsoTimestamp(value.coveredDueAt) &&
    isIsoTimestamp(value.createdAt)
}

/** Returns whether a value is one append-only immutable-update comment. */
function isPlanningUpdateComment(value: unknown): value is PlanningUpdateComment {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isPlanningUpdateTarget(value.target) &&
    isPositiveSafeInteger(value.updateVersion) &&
    typeof value.body === 'string' &&
    typeof value.authorMemberKey === 'string' &&
    isIsoTimestamp(value.createdAt)
}

/** Returns whether a value is one member reaction on an immutable update. */
function isPlanningUpdateReaction(value: unknown): value is PlanningUpdateReaction {
  return isRecord(value) &&
    isPlanningUpdateTarget(value.target) &&
    isPositiveSafeInteger(value.updateVersion) &&
    typeof value.emoji === 'string' &&
    typeof value.memberKey === 'string' &&
    isIsoTimestamp(value.createdAt)
}

/** Returns whether a value is one local-date Planning range. */
function isPlanningDateRange(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.startDate === 'string' &&
    typeof value.endDate === 'string'
}

/** Returns whether a value is one Planning entity dependency. */
function isPlanningDependency(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.predecessorId === 'string' &&
    typeof value.successorId === 'string' &&
    isScheduleDependencyType(value.type) &&
    Number.isSafeInteger(value.lagDays) &&
    (
      value.constraint === undefined ||
      isScheduleDependencyConstraint(value.constraint)
    ) &&
    typeof value.createdAt === 'string'
}

/** Returns whether a value is one Planning-to-Work-Item link. */
function isPlanningWorkItemLink(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    typeof value.workItemId === 'string' &&
    isOptionalString(value.projectId) &&
    isOptionalString(value.cycleId) &&
    isOptionalString(value.milestoneId) &&
    isStringArray(value.goalIds) &&
    typeof value.createdAt === 'string'
}

/** Returns whether a value is one Planning Work Item projection. */
function isPlanningWorkItem(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isPositiveSafeInteger(value.revision) &&
    typeof value.teamId === 'string' &&
    typeof value.title === 'string' &&
    isOptionalString(value.projectId) &&
    isWorkItemStatusCategory(value.statusCategory) &&
    typeof value.dueDate === 'string' &&
    isWorkItemSchedule(value.schedule)
}

/** Returns whether a value is the Planning entity critical-path projection. */
function isPlanningCriticalPath(value: unknown): boolean {
  return isRecord(value) &&
    isStringArray(value.entityIds) &&
    isFiniteNumber(value.totalDurationDays) &&
    isNumberRecord(value.slackByEntityId)
}

/** Returns whether a value is one Team-qualified affected Project. */
function isAffectedProject(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    value.teamId.length > 0 &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0
}

/** Returns whether a value is the Work Item dependency management summary. */
function isWorkItemDependencySummary(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.criticalPath)) return false
  return Array.isArray(value.criticalPath.workItems) &&
    value.criticalPath.workItems.every(isWorkItemDependencyEndpoint) &&
    isFiniteNumber(value.criticalPath.totalDurationDays) &&
    isNumberRecord(value.criticalPath.slackByWorkItemKey) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isWorkItemScheduleDependencyConflict) &&
    isNonnegativeSafeInteger(value.unresolvedBlockerCount) &&
    Array.isArray(value.affectedProjects) &&
    value.affectedProjects.every(isAffectedProject) &&
    isStringArray(value.affectedProjectIds) &&
    isStringArray(value.affectedMilestoneIds)
}

/**
 * Returns whether an unknown response is a complete authoritative Planning snapshot.
 *
 * @param value - Unknown Planning snapshot response candidate.
 * @returns Whether the value satisfies the current Planning snapshot schema.
 */
export function isPlanningSnapshot(value: unknown): value is PlanningSnapshot {
  return isRecord(value) &&
    value.schemaVersion === PLANNING_SCHEMA_VERSION &&
    isNonnegativeSafeInteger(value.revision) &&
    Array.isArray(value.entities) &&
    value.entities.every(isPlanningEntity) &&
    Array.isArray(value.dependencies) &&
    value.dependencies.every(isPlanningDependency) &&
    Array.isArray(value.workItemDependencies) &&
    value.workItemDependencies.every(isWorkItemScheduleDependency) &&
    Array.isArray(value.workItemLinks) &&
    value.workItemLinks.every(isPlanningWorkItemLink) &&
    Array.isArray(value.workItems) &&
    value.workItems.every(isPlanningWorkItem) &&
    Array.isArray(value.updateTargets) &&
    value.updateTargets.every(isPlanningUpdateTargetSummary) &&
    isPlanningCriticalPath(value.criticalPath) &&
    isWorkItemDependencySummary(value.workItemDependencySummary) &&
    isOptionalString(value.updatedAt)
}

/**
 * Decodes a current Planning snapshot or upgrades a dependency-free v1 snapshot.
 *
 * The rollout-compatible v1 shape predates canonical Work Item schedule dependencies. Missing
 * graph fields therefore normalize to an empty dependency graph while all existing nested data
 * still passes the same runtime validators as a current response.
 *
 * @param value - Unknown Planning API response candidate.
 * @returns A current Planning snapshot, or undefined when either schema is malformed.
 */
export function readPlanningSnapshot(value: unknown): PlanningSnapshot | undefined {
  if (isPlanningSnapshot(value)) return value
  if (isRecord(value) && value.schemaVersion === PLANNING_SCHEMA_VERSION) {
    const normalizedCurrent = {
      ...value,
      updateTargets: value.updateTargets ?? [],
    }
    if (isPlanningSnapshot(normalizedCurrent)) return normalizedCurrent
  }
  if (!isLegacyPlanningSnapshot(value)) return undefined

  const normalized = {
    ...value,
    schemaVersion: PLANNING_SCHEMA_VERSION,
    updateTargets: [],
    workItemDependencies: value.workItemDependencies ?? [],
    workItemDependencySummary: normalizeLegacyWorkItemDependencySummary(
      value.workItemDependencySummary,
      value.workItems,
    ),
  }
  return isPlanningSnapshot(normalized) ? normalized : undefined
}

/**
 * Decodes one immutable Planning update history page.
 *
 * @param value - Unknown history API response candidate.
 * @returns A validated history page, or undefined when malformed.
 */
export function readPlanningUpdateHistoryPage(
  value: unknown,
): PlanningUpdateHistoryPage | undefined {
  if (!isRecord(value) ||
    !Array.isArray(value.updates) ||
    !value.updates.every(isPlanningUpdate) ||
    !isOptionalString(value.nextCursor)) {
    return undefined
  }
  return {
    nextCursor: value.nextCursor,
    updates: value.updates,
  }
}

/**
 * Decodes one cursor-paginated immutable-update comment page.
 *
 * @param value - Unknown comment history response candidate.
 * @returns A validated comment page, or undefined when malformed.
 */
export function readPlanningUpdateCommentPage(
  value: unknown,
): PlanningUpdateCommentPage | undefined {
  if (!isRecord(value) ||
    !Array.isArray(value.comments) ||
    !value.comments.every(isPlanningUpdateComment) ||
    !isOptionalString(value.nextCursor)) {
    return undefined
  }
  return {
    nextCursor: value.nextCursor,
    comments: value.comments,
  }
}

/**
 * Decodes one newly created immutable-update comment envelope.
 *
 * @param value - Unknown comment mutation response candidate.
 * @returns The validated comment envelope, or undefined when malformed.
 */
export function readPlanningUpdateCommentMutationResponse(
  value: unknown,
): { comment: PlanningUpdateComment } | undefined {
  return isRecord(value) && isPlanningUpdateComment(value.comment)
    ? { comment: value.comment }
    : undefined
}

/**
 * Decodes one immutable-update reaction page.
 *
 * @param value - Unknown reaction history response candidate.
 * @returns A validated reaction page, or undefined when malformed.
 */
export function readPlanningUpdateReactionPage(
  value: unknown,
): PlanningUpdateReactionPage | undefined {
  if (!isRecord(value) ||
    !Array.isArray(value.reactions) ||
    !value.reactions.every(isPlanningUpdateReaction) ||
    !isOptionalString(value.nextCursor)) {
    return undefined
  }
  return {
    nextCursor: value.nextCursor,
    reactions: value.reactions,
  }
}

/**
 * Decodes one newly added immutable-update reaction envelope.
 *
 * @param value - Unknown reaction mutation response candidate.
 * @returns The validated reaction envelope, or undefined when malformed.
 */
export function readPlanningUpdateReactionMutationResponse(
  value: unknown,
): { reaction: PlanningUpdateReaction } | undefined {
  return isRecord(value) && isPlanningUpdateReaction(value.reaction)
    ? { reaction: value.reaction }
    : undefined
}

/**
 * Decodes one cadence mutation response and its authoritative snapshot.
 *
 * @param value - Unknown cadence mutation response candidate.
 * @returns A validated response, or undefined when malformed.
 */
export function readPlanningUpdateCadenceMutationResponse(
  value: unknown,
): PlanningUpdateCadenceMutationResponse | undefined {
  if (!isRecord(value) || !isPlanningUpdateTargetSummary(value.updateTarget)) {
    return undefined
  }
  const planning = readPlanningSnapshot(value.planning)
  return planning
    ? { planning, updateTarget: value.updateTarget }
    : undefined
}

/**
 * Decodes one structured manual publish response and its immutable update.
 *
 * @param value - Unknown publish response candidate.
 * @returns A validated response, or undefined when malformed.
 */
export function readPlanningUpdatePublishResponse(
  value: unknown,
): PlanningUpdatePublishResponse | undefined {
  if (!isRecord(value) || !isPlanningUpdate(value.update)) return undefined
  const planning = readPlanningSnapshot(value.planning)
  return planning
    ? { planning, update: value.update }
    : undefined
}

/** Returns whether a response matches the dependency-free Planning v1 snapshot shape. */
function isLegacyPlanningSnapshot(value: unknown): value is Record<string, unknown> {
  return isRecord(value) &&
    value.schemaVersion === LEGACY_PLANNING_SCHEMA_VERSION &&
    isNonnegativeSafeInteger(value.revision) &&
    Array.isArray(value.entities) &&
    value.entities.every(isPlanningEntity) &&
    Array.isArray(value.dependencies) &&
    value.dependencies.every(isPlanningDependency) &&
    Array.isArray(value.workItemLinks) &&
    value.workItemLinks.every(isPlanningWorkItemLink) &&
    Array.isArray(value.workItems) &&
    value.workItems.every(isPlanningWorkItem) &&
    isPlanningCriticalPath(value.criticalPath) &&
    isOptionalString(value.updatedAt)
}

/** Adds v2 affected Project identities or creates the empty pre-dependency summary. */
function normalizeLegacyWorkItemDependencySummary(
  value: unknown,
  workItems: unknown,
): unknown {
  if (value === undefined) {
    return {
      affectedMilestoneIds: [],
      affectedProjectIds: [],
      affectedProjects: [],
      conflicts: [],
      criticalPath: {
        slackByWorkItemKey: {},
        totalDurationDays: 0,
        workItems: [],
      },
      unresolvedBlockerCount: 0,
    }
  }
  if (!isRecord(value) || value.affectedProjects !== undefined) return value
  return {
    ...value,
    affectedProjects: deriveLegacyAffectedProjects(workItems, value.affectedProjectIds),
  }
}

/**
 * Derives unambiguous Team-qualified Project references from legacy IDs and visible Work Items.
 *
 * IDs with no visible owner or more than one visible owner remain only in the unchanged legacy
 * ID list so callers can use permission-aware search without inventing a Team-scoped route.
 */
function deriveLegacyAffectedProjects(
  workItems: unknown,
  affectedProjectIds: unknown,
): Array<{ projectId: string; teamId: string }> {
  if (!Array.isArray(workItems) || !isStringArray(affectedProjectIds)) return []
  const affectedProjectIdSet = new Set(affectedProjectIds)
  const teamIdsByProjectId = new Map<string, Set<string>>()
  for (const workItem of workItems) {
    if (!isRecord(workItem) ||
      typeof workItem.teamId !== 'string' ||
      workItem.teamId.length === 0 ||
      typeof workItem.projectId !== 'string' ||
      workItem.projectId.length === 0 ||
      !affectedProjectIdSet.has(workItem.projectId)) continue
    const teamIds = teamIdsByProjectId.get(workItem.projectId) ?? new Set<string>()
    teamIds.add(workItem.teamId)
    teamIdsByProjectId.set(workItem.projectId, teamIds)
  }

  return affectedProjectIds.flatMap((projectId, index) => {
    if (affectedProjectIds.indexOf(projectId) !== index) return []
    const teamIds = teamIdsByProjectId.get(projectId)
    if (teamIds?.size !== 1) return []
    const teamId = [...teamIds][0]
    return teamId === undefined ? [] : [{ projectId, teamId }]
  })
}
