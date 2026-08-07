import {
  PLANNING_SCHEMA_VERSION,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
  type ConfirmedWorkItemSchedule,
  type PlanningSnapshot,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
  type ConfirmWorkItemScheduleChangeResponse,
} from '@mukuroji/contracts'

const scheduleDependencyTypes = new Set<string>([
  'finish-to-start',
  'start-to-start',
  'finish-to-finish',
  'start-to-finish',
])
const weekdays = new Set<string>([
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
])
const workflowStatusCategories = new Set<string>([
  'backlog',
  'triage',
  'unstarted',
  'started',
  'completed',
  'canceled',
])
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

/** Returns whether an unknown JSON value is a plain object-like record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns whether a value is a nonnegative safe integer. */
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Returns whether a value is a positive safe integer. */
function isPositiveRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Returns whether a value is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Returns whether a value is an array containing only strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

/** Returns whether an optional field is absent or a string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Returns whether a JSON object contains only finite numeric values. */
function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every(isFiniteNumber)
}

/** Returns whether a value can safely cross a JSON data boundary. */
function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    isFiniteNumber(value)
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

/** Returns whether a value is a structurally valid canonical calendar policy. */
function isCalendarPolicy(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.timeZone === 'string' &&
    value.timeZone.length > 0 &&
    Array.isArray(value.workingWeekdays) &&
    value.workingWeekdays.length > 0 &&
    value.workingWeekdays.every((entry) => typeof entry === 'string' && weekdays.has(entry)) &&
    isStringArray(value.holidays)
}

/** Returns whether a value is a complete canonical Work Item schedule. */
export function isWorkItemSchedule(value: unknown): value is WorkItemSchedule {
  if (
    !isRecord(value) ||
    !isCalendarPolicy(value.calendarPolicy) ||
    (
      value.plannedEffortMinutes !== undefined &&
      (!isRevision(value.plannedEffortMinutes))
    )
  ) {
    return false
  }
  if (value.mode === 'unscheduled') return true
  if (value.mode === 'due-date') return typeof value.dueDate === 'string'
  if (value.mode === 'milestone') {
    return typeof value.startDate === 'string' &&
      value.endDate === value.startDate &&
      value.durationDays === 0
  }
  return value.mode === 'date-range' &&
    typeof value.startDate === 'string' &&
    typeof value.endDate === 'string' &&
    isPositiveRevision(value.durationDays)
}

/** Returns whether a value is one Team-qualified Work Item endpoint. */
function isDependencyEndpoint(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    value.teamId.length > 0 &&
    typeof value.workItemId === 'string' &&
    value.workItemId.length > 0
}

/** Returns whether a value is one supported explicit date constraint. */
function isDependencyConstraint(value: unknown): boolean {
  return isRecord(value) &&
    (value.anchor === 'start' || value.anchor === 'finish') &&
    (value.kind === 'on' || value.kind === 'not-before' || value.kind === 'not-after') &&
    typeof value.date === 'string'
}

/** Returns whether a value is one canonical Work Item schedule dependency. */
function isWorkItemDependency(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isDependencyEndpoint(value.predecessor) &&
    isDependencyEndpoint(value.successor) &&
    typeof value.type === 'string' &&
    scheduleDependencyTypes.has(value.type) &&
    Number.isSafeInteger(value.lagDays) &&
    (value.constraint === undefined || isDependencyConstraint(value.constraint)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
}

/** Returns whether a value is one dependency conflict safe for direct rendering. */
function isDependencyConflict(value: unknown): boolean {
  return isRecord(value) &&
    (
      value.code === 'missing-schedule' ||
      value.code === 'dependency-violation' ||
      value.code === 'constraint-violation'
    ) &&
    typeof value.dependencyId === 'string' &&
    isDependencyEndpoint(value.workItem) &&
    isOptionalString(value.requiredDate) &&
    isOptionalString(value.actualDate)
}

/** Returns whether a value is one revision-bound schedule impact. */
function isScheduleImpact(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    typeof value.workItemId === 'string' &&
    (value.kind === 'direct' || value.kind === 'dependency') &&
    isPositiveRevision(value.expectedRevision) &&
    isWorkItemSchedule(value.before) &&
    isWorkItemSchedule(value.after) &&
    isFiniteNumber(value.dateDeltaDays) &&
    isOptionalString(value.dependencyId)
}

/** Returns whether a value is one evaluated Work Item revision. */
function isEvaluationRevision(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    typeof value.workItemId === 'string' &&
    isPositiveRevision(value.expectedRevision)
}

/** Returns whether a value is a complete dependency-aware schedule preview. */
export function isWorkItemScheduleChangePreview(
  value: unknown,
): value is WorkItemScheduleChangePreview {
  return isRecord(value) &&
    isPositiveRevision(value.expectedRevision) &&
    Array.isArray(value.impacts) &&
    value.impacts.length > 0 &&
    value.impacts.every(isScheduleImpact) &&
    Array.isArray(value.evaluatedRevisions) &&
    value.evaluatedRevisions.length > 0 &&
    value.evaluatedRevisions.every(isEvaluationRevision) &&
    (value.relationGraphRevision === undefined || isRevision(value.relationGraphRevision)) &&
    (value.planningRevision === undefined || isRevision(value.planningRevision)) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isDependencyConflict) &&
    isStringArray(value.affectedProjectIds) &&
    isStringArray(value.affectedMilestoneIds) &&
    typeof value.requiresConfirmation === 'boolean' &&
    isStringArray(value.warnings)
}

/** Returns whether an optional approval summary has valid numeric counters. */
function isApprovalSummary(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    isRevision(value.pendingCount) &&
    isRevision(value.overdueCount) &&
    isRevision(value.approvedCount) &&
    isRevision(value.rejectedCount) &&
    isRevision(value.changesRequestedCount) &&
    isOptionalString(value.nextDueAt)
  )
}

/** Returns whether a value is a complete canonical Work Item response. */
export function isCanonicalWorkItem(value: unknown): value is CanonicalWorkItem {
  return isRecord(value) &&
    value.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    isPositiveRevision(value.revision) &&
    typeof value.id === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.assigneeUserId === 'string' &&
    typeof value.creatorMemberKey === 'string' &&
    typeof value.workflowStatusId === 'string' &&
    typeof value.statusCategory === 'string' &&
    workflowStatusCategories.has(value.statusCategory) &&
    value.workflowSchemaVersion === WORK_ITEM_CONFIGURATION_SCHEMA_VERSION &&
    isRecord(value.customFieldValues) &&
    Object.values(value.customFieldValues).every(isJsonValue) &&
    isStringArray(value.relationIds) &&
    typeof value.dueDate === 'string' &&
    isWorkItemSchedule(value.schedule) &&
    (value.priority === 'high' || value.priority === 'medium' || value.priority === 'low') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    value.source === 'dynamodb' &&
    isOptionalString(value.assignedProjectId) &&
    isOptionalString(value.description) &&
    isOptionalString(value.assigneeEmail) &&
    isOptionalString(value.assigneeName) &&
    isOptionalString(value.sourceRequestId) &&
    isOptionalString(value.archivedAt) &&
    isOptionalString(value.archivedBy) &&
    isApprovalSummary(value.approvalSummary)
}

/** Returns whether a value is one compact committed Work Item schedule. */
function isConfirmedWorkItemSchedule(value: unknown): value is ConfirmedWorkItemSchedule {
  return isRecord(value) &&
    Object.keys(value).every((key) =>
      key === 'id' ||
      key === 'teamId' ||
      key === 'revision' ||
      key === 'schedule' ||
      key === 'dueDate' ||
      key === 'assignedProjectId'
    ) &&
    typeof value.id === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 1 &&
    isWorkItemSchedule(value.schedule) &&
    typeof value.dueDate === 'string' &&
    isOptionalString(value.assignedProjectId)
}

/** Returns whether a value is a complete compact schedule confirmation response. */
export function isConfirmWorkItemScheduleChangeResponse(
  value: unknown,
): value is ConfirmWorkItemScheduleChangeResponse {
  return isRecord(value) &&
    Object.keys(value).every((key) => key === 'workItems') &&
    Array.isArray(value.workItems) &&
    value.workItems.length > 0 &&
    value.workItems.every(isConfirmedWorkItemSchedule)
}

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
    isRevision(value.linkedWorkItemCount) &&
    isPlanningDateRange(value.baseline) &&
    isPlanningDateRange(value.forecast) &&
    isPlanningCadence(value.cadence) &&
    (value.capacity === undefined || isRevision(value.capacity)) &&
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
    isPositiveRevision(value.count)
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
    typeof value.type === 'string' &&
    scheduleDependencyTypes.has(value.type) &&
    Number.isSafeInteger(value.lagDays) &&
    (value.constraint === undefined || isDependencyConstraint(value.constraint)) &&
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
    isPositiveRevision(value.revision) &&
    typeof value.teamId === 'string' &&
    typeof value.title === 'string' &&
    isOptionalString(value.projectId) &&
    typeof value.statusCategory === 'string' &&
    workflowStatusCategories.has(value.statusCategory) &&
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

/** Returns whether a value is the Work Item dependency management summary. */
function isWorkItemDependencySummary(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.criticalPath)) return false
  return Array.isArray(value.criticalPath.workItems) &&
    value.criticalPath.workItems.every(isDependencyEndpoint) &&
    isFiniteNumber(value.criticalPath.totalDurationDays) &&
    isNumberRecord(value.criticalPath.slackByWorkItemKey) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isDependencyConflict) &&
    isRevision(value.unresolvedBlockerCount) &&
    isStringArray(value.affectedProjectIds) &&
    isStringArray(value.affectedMilestoneIds)
}

/** Returns whether an unknown response is a complete authoritative Planning snapshot. */
export function isPlanningSnapshot(value: unknown): value is PlanningSnapshot {
  return isRecord(value) &&
    value.schemaVersion === PLANNING_SCHEMA_VERSION &&
    isRevision(value.revision) &&
    Array.isArray(value.entities) &&
    value.entities.every(isPlanningEntity) &&
    Array.isArray(value.dependencies) &&
    value.dependencies.every(isPlanningDependency) &&
    Array.isArray(value.workItemDependencies) &&
    value.workItemDependencies.every(isWorkItemDependency) &&
    Array.isArray(value.workItemLinks) &&
    value.workItemLinks.every(isPlanningWorkItemLink) &&
    Array.isArray(value.workItems) &&
    value.workItems.every(isPlanningWorkItem) &&
    isPlanningCriticalPath(value.criticalPath) &&
    isWorkItemDependencySummary(value.workItemDependencySummary) &&
    isOptionalString(value.updatedAt)
}
