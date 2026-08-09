import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type CanonicalWorkItem,
  type ConfirmedWorkItemSchedule,
  type ConfirmWorkItemScheduleChangeResponse,
  type ScheduleDependencyConstraint,
  type ScheduleDependencyType,
  type WorkItemDependencyEndpoint,
  type WorkItemSchedule,
  type WorkItemScheduleChangePreview,
  type WorkItemScheduleDependency,
  type WorkItemScheduleDependencyConflict,
  type WorkflowStatusCategory,
} from '@mukuroji/contracts'
import {
  isFiniteNumber,
  isJsonValue,
  isNonnegativeSafeInteger,
  isOptionalString,
  isPositiveSafeInteger,
  isRecord,
  isStringArray,
} from '../../shared/api/jsonValidation'

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

/**
 * Returns whether a value is one canonical schedule dependency relation type.
 *
 * @param value - Unknown dependency-type candidate.
 * @returns Whether the value is shared by Planning and Work Item schedule dependencies.
 */
export function isScheduleDependencyType(
  value: unknown,
): value is ScheduleDependencyType {
  return typeof value === 'string' && scheduleDependencyTypes.has(value)
}

/**
 * Returns whether a value is one canonical schedule dependency date constraint.
 *
 * @param value - Unknown dependency-constraint candidate.
 * @returns Whether the value constrains one supported schedule anchor with a local date.
 */
export function isScheduleDependencyConstraint(
  value: unknown,
): value is ScheduleDependencyConstraint {
  return isRecord(value) &&
    (value.anchor === 'start' || value.anchor === 'finish') &&
    (value.kind === 'on' || value.kind === 'not-before' || value.kind === 'not-after') &&
    typeof value.date === 'string'
}

/**
 * Returns whether a value is one canonical Work Item workflow status category.
 *
 * @param value - Unknown status-category candidate.
 * @returns Whether the value is a supported cross-workflow status category.
 */
export function isWorkItemStatusCategory(
  value: unknown,
): value is WorkflowStatusCategory {
  return typeof value === 'string' && workflowStatusCategories.has(value)
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

/**
 * Returns whether a value is a complete canonical Work Item schedule.
 *
 * @param value - Unknown schedule response candidate.
 * @returns Whether the value satisfies one explicit canonical schedule mode.
 */
export function isWorkItemSchedule(value: unknown): value is WorkItemSchedule {
  if (
    !isRecord(value) ||
    !isCalendarPolicy(value.calendarPolicy) ||
    (
      value.plannedEffortMinutes !== undefined &&
      !isNonnegativeSafeInteger(value.plannedEffortMinutes)
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
    isPositiveSafeInteger(value.durationDays)
}

/**
 * Returns whether a value is one Team-qualified Work Item endpoint.
 *
 * @param value - Unknown endpoint response candidate.
 * @returns Whether the value identifies one Team-local Work Item.
 */
export function isWorkItemDependencyEndpoint(
  value: unknown,
): value is WorkItemDependencyEndpoint {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    value.teamId.length > 0 &&
    typeof value.workItemId === 'string' &&
    value.workItemId.length > 0
}

/**
 * Returns whether a value is one canonical Work Item schedule dependency.
 *
 * @param value - Unknown dependency response candidate.
 * @returns Whether the value contains two endpoints and one supported schedule rule.
 */
export function isWorkItemScheduleDependency(
  value: unknown,
): value is WorkItemScheduleDependency {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    isWorkItemDependencyEndpoint(value.predecessor) &&
    isWorkItemDependencyEndpoint(value.successor) &&
    isScheduleDependencyType(value.type) &&
    Number.isSafeInteger(value.lagDays) &&
    (
      value.constraint === undefined ||
      isScheduleDependencyConstraint(value.constraint)
    ) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
}

/**
 * Returns whether a value is one dependency conflict safe for direct rendering.
 *
 * @param value - Unknown dependency-conflict response candidate.
 * @returns Whether the value contains a supported conflict code and Work Item endpoint.
 */
export function isWorkItemScheduleDependencyConflict(
  value: unknown,
): value is WorkItemScheduleDependencyConflict {
  return isRecord(value) &&
    (
      value.code === 'missing-schedule' ||
      value.code === 'dependency-violation' ||
      value.code === 'constraint-violation'
    ) &&
    typeof value.dependencyId === 'string' &&
    isWorkItemDependencyEndpoint(value.workItem) &&
    isOptionalString(value.requiredDate) &&
    isOptionalString(value.actualDate)
}

/** Returns whether a value is one revision-bound schedule impact. */
function isScheduleImpact(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    typeof value.workItemId === 'string' &&
    (value.kind === 'direct' || value.kind === 'dependency') &&
    isPositiveSafeInteger(value.expectedRevision) &&
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
    isPositiveSafeInteger(value.expectedRevision)
}

/** Returns whether a value is one Team-qualified affected Project. */
function isAffectedProject(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.teamId === 'string' &&
    value.teamId.length > 0 &&
    typeof value.projectId === 'string' &&
    value.projectId.length > 0
}

/**
 * Returns whether a value is a complete dependency-aware schedule preview.
 *
 * @param value - Unknown preview response candidate.
 * @returns Whether the value contains revision-bound impacts, conflicts, and affected scopes.
 */
export function isWorkItemScheduleChangePreview(
  value: unknown,
): value is WorkItemScheduleChangePreview {
  return isRecord(value) &&
    isPositiveSafeInteger(value.expectedRevision) &&
    Array.isArray(value.impacts) &&
    value.impacts.length > 0 &&
    value.impacts.every(isScheduleImpact) &&
    Array.isArray(value.evaluatedRevisions) &&
    value.evaluatedRevisions.length > 0 &&
    value.evaluatedRevisions.every(isEvaluationRevision) &&
    (
      value.relationGraphRevision === undefined ||
      isNonnegativeSafeInteger(value.relationGraphRevision)
    ) &&
    (
      value.planningRevision === undefined ||
      isNonnegativeSafeInteger(value.planningRevision)
    ) &&
    Array.isArray(value.conflicts) &&
    value.conflicts.every(isWorkItemScheduleDependencyConflict) &&
    Array.isArray(value.affectedProjects) &&
    value.affectedProjects.every(isAffectedProject) &&
    isStringArray(value.affectedProjectIds) &&
    isStringArray(value.affectedMilestoneIds) &&
    typeof value.requiresConfirmation === 'boolean' &&
    isStringArray(value.warnings)
}

/**
 * Returns whether a schedule preview's direct impacts belong to the requested Work Item.
 *
 * @param value - Unknown preview response candidate.
 * @param teamId - Team from the preview request path.
 * @param workItemId - Work Item from the preview request path.
 * @returns Whether the preview is complete and every direct impact matches the request target.
 */
export function isWorkItemScheduleChangePreviewForEndpoint(
  value: unknown,
  teamId: string,
  workItemId: string,
): value is WorkItemScheduleChangePreview {
  if (!isWorkItemScheduleChangePreview(value)) return false
  const directImpacts = value.impacts.filter((impact) => impact.kind === 'direct')
  return directImpacts.length > 0 && directImpacts.every((impact) =>
    impact.teamId === teamId && impact.workItemId === workItemId
  )
}

/**
 * Decodes an endpoint-bound schedule preview and upgrades its legacy affected Project shape.
 *
 * Legacy Project IDs cannot be safely qualified with a Team from this response alone. They stay
 * in `affectedProjectIds` for fallback display or search while the current qualified collection
 * is initialized empty.
 *
 * @param value - Unknown schedule preview response candidate.
 * @param teamId - Team from the preview request path.
 * @param workItemId - Work Item from the preview request path.
 * @returns A current endpoint-bound preview, or undefined when the response is malformed.
 */
export function readWorkItemScheduleChangePreviewForEndpoint(
  value: unknown,
  teamId: string,
  workItemId: string,
): WorkItemScheduleChangePreview | undefined {
  const normalized = isRecord(value) && value.affectedProjects === undefined
    ? { ...value, affectedProjects: [] }
    : value
  return isWorkItemScheduleChangePreviewForEndpoint(normalized, teamId, workItemId)
    ? normalized
    : undefined
}

/** Returns whether an optional approval summary has valid numeric counters. */
function isApprovalSummary(value: unknown): boolean {
  return value === undefined || (
    isRecord(value) &&
    isNonnegativeSafeInteger(value.pendingCount) &&
    isNonnegativeSafeInteger(value.overdueCount) &&
    isNonnegativeSafeInteger(value.approvedCount) &&
    isNonnegativeSafeInteger(value.rejectedCount) &&
    isNonnegativeSafeInteger(value.changesRequestedCount) &&
    isOptionalString(value.nextDueAt)
  )
}

/**
 * Returns whether a value is a complete canonical Work Item response.
 *
 * @param value - Unknown Work Item response candidate.
 * @returns Whether the value satisfies the current canonical Work Item schema.
 */
export function isCanonicalWorkItem(value: unknown): value is CanonicalWorkItem {
  return isRecord(value) &&
    value.schemaVersion === WORK_ITEM_SCHEMA_VERSION &&
    isPositiveSafeInteger(value.revision) &&
    typeof value.id === 'string' &&
    typeof value.teamId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.assigneeUserId === 'string' &&
    typeof value.creatorMemberKey === 'string' &&
    typeof value.workflowStatusId === 'string' &&
    isWorkItemStatusCategory(value.statusCategory) &&
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
    isOptionalString(value.sourceTriageEntryId) &&
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
    isPositiveSafeInteger(value.revision) &&
    isWorkItemSchedule(value.schedule) &&
    typeof value.dueDate === 'string' &&
    isOptionalString(value.assignedProjectId)
}

/**
 * Returns whether a value is a complete compact schedule confirmation response.
 *
 * @param value - Unknown confirmation response candidate.
 * @returns Whether the value contains at least one complete compact committed schedule.
 */
export function isConfirmWorkItemScheduleChangeResponse(
  value: unknown,
): value is ConfirmWorkItemScheduleChangeResponse {
  return isRecord(value) &&
    Object.keys(value).every((key) => key === 'workItems') &&
    Array.isArray(value.workItems) &&
    value.workItems.length > 0 &&
    value.workItems.every(isConfirmedWorkItemSchedule)
}
