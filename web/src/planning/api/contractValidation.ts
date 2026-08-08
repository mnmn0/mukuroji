import {
  LEGACY_PLANNING_SCHEMA_VERSION,
  PLANNING_SCHEMA_VERSION,
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
  if (!isLegacyPlanningSnapshot(value)) return undefined

  const normalized = {
    ...value,
    schemaVersion: PLANNING_SCHEMA_VERSION,
    workItemDependencies: value.workItemDependencies ?? [],
    workItemDependencySummary: normalizeLegacyWorkItemDependencySummary(
      value.workItemDependencySummary,
      value.workItems,
    ),
  }
  return isPlanningSnapshot(normalized) ? normalized : undefined
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
