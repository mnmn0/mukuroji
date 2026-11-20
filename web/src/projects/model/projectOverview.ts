import {
  classifyFactoryBoardItem,
  type CanonicalWorkItem,
  type FactoryBoardLane,
  type PlanningEntity,
  type PlanningEntityType,
  type PlanningUpdateTargetSummary,
  type TeamAgentRunBoardResponse,
} from '@mukuroji/contracts'
import type { ProjectMember, ProjectMemberRole } from '../api/members'
import { resolveWorkflowStatusCategory } from '../../work-items/model/workItemDisplay'
import { isWorkspaceTaskOverdue } from '../../work-items/model/workspaceWorkItems'

/** Most schedule entities (Phase, Milestone, Release) shown on the Project overview. */
export const PROJECT_OVERVIEW_SCHEDULE_LIMIT = 6

/** Most Project members listed by name on the Project overview. */
export const PROJECT_OVERVIEW_MEMBER_LIMIT = 8

/** Planning entity types shown as the Project schedule on the overview. */
const projectOverviewScheduleTypes: ReadonlySet<PlanningEntityType> = new Set<PlanningEntityType>([
  'phase',
  'milestone',
  'release',
])

/** Work Item counts shown by the Project overview progress widget. */
export type ProjectOverviewWorkItemSummary = {
  /** Every readable Work Item of the Project. */
  totalCount: number
  /** Work Items outside completed and canceled workflow categories. */
  openCount: number
  /** Work Items in the started workflow category. */
  inProgressCount: number
  /** Work Items in the completed workflow category. */
  doneCount: number
  /** Rounded percentage of completed Work Items among all Work Items. */
  completionRate: number
  /** Open Work Items whose due date has passed. */
  overdueCount: number
  /** Open Work Items with high priority. */
  highPriorityOpenCount: number
}

/** One Phase, Milestone, or Release row shown on the Project overview. */
export type ProjectOverviewScheduleItem = {
  /** Planning entity identifier. */
  id: string
  /** Planning entity type. */
  type: PlanningEntityType
  /** Display title. */
  title: string
  /** Lifecycle status of the entity. */
  status: PlanningEntity['status']
  /** Health rolled up from the entity and its descendants. */
  health: PlanningEntity['rollupHealth']
  /** Read-time progress from 0 to 100. */
  progress: number
  /** Forecast end date in `YYYY-MM-DD`. */
  forecastEndDate: string
  /** Baseline end date in `YYYY-MM-DD`. */
  baselineEndDate: string
  /** Days the forecast end is after the baseline end; negative when earlier. */
  delayDays: number
}

/** Bounded Phase, Milestone, and Release list of one Project. */
export type ProjectOverviewSchedule = {
  /** Rows shown on the overview, nearest forecast end first. */
  items: ProjectOverviewScheduleItem[]
  /** Rows left out because of the overview limit. */
  hiddenCount: number
  /** Rows whose forecast end is after their baseline end, counted over every row. */
  delayedCount: number
}

/** Project members grouped by role, with a bounded named list. */
export type ProjectOverviewMembers = {
  /** Number of members for each Project role. */
  roleCounts: Record<ProjectMemberRole, number>
  /** Every member counted by the summary. */
  totalCount: number
  /** Members shown by name, managers first. */
  shown: ProjectMember[]
  /** Members left out because of the overview limit. */
  hiddenCount: number
}

/**
 * Counts the Project's Work Items for the overview progress and attention widgets.
 *
 * Two Teams can use the same Project ID, and the Project list returns both Teams' Work
 * Items, so only the Work Items of the overview's Team are counted.
 *
 * @param projectWorkItems - Readable Work Items assigned to the Project.
 * @param teamId - Team that owns the Project shown by the overview.
 * @param referenceDate - Instant that decides whether a due date has passed.
 * @returns Progress and attention counts.
 */
export function summarizeProjectOverviewWorkItems(
  projectWorkItems: readonly CanonicalWorkItem[],
  teamId: string,
  referenceDate: Date,
): ProjectOverviewWorkItemSummary {
  const workItems = projectWorkItems.filter((workItem) => workItem.teamId === teamId)
  let openCount = 0
  let inProgressCount = 0
  let doneCount = 0
  let overdueCount = 0
  let highPriorityOpenCount = 0

  for (const workItem of workItems) {
    const category = resolveWorkflowStatusCategory(workItem)
    if (category === 'completed') doneCount += 1
    if (category === 'started') inProgressCount += 1
    if (category === 'completed' || category === 'canceled') continue
    openCount += 1
    if (workItem.priority === 'high') highPriorityOpenCount += 1
    if (isWorkspaceTaskOverdue(workItem, referenceDate)) overdueCount += 1
  }

  const totalCount = workItems.length
  return {
    completionRate: totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0,
    doneCount,
    highPriorityOpenCount,
    inProgressCount,
    openCount,
    overdueCount,
    totalCount,
  }
}

/**
 * Finds the update target of one Team-qualified Project.
 *
 * @param targets - Update target summaries from the Planning snapshot.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @returns The Project's update target, or `undefined` when none is configured or readable.
 */
export function findProjectOverviewUpdateTarget(
  targets: readonly PlanningUpdateTargetSummary[],
  teamId: string,
  projectId: string,
): PlanningUpdateTargetSummary | undefined {
  return targets.find((candidate) =>
    candidate.target.type === 'project' &&
    candidate.target.teamId === teamId &&
    candidate.target.projectId === projectId
  )
}

/**
 * Selects the Project's live Phases, Milestones, and Releases, nearest forecast end first.
 *
 * @param entities - Planning entities from the snapshot.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param limit - Most rows to return.
 * @returns The bounded schedule with the number of rows left out and of delayed rows.
 */
export function selectProjectOverviewSchedule(
  entities: readonly PlanningEntity[],
  teamId: string,
  projectId: string,
  limit = PROJECT_OVERVIEW_SCHEDULE_LIMIT,
): ProjectOverviewSchedule {
  const rows = entities
    .filter((entity) =>
      projectOverviewScheduleTypes.has(entity.type) &&
      entity.teamId === teamId &&
      entity.projectId === projectId &&
      entity.archivedAt === undefined
    )
    .map((entity): ProjectOverviewScheduleItem => ({
      baselineEndDate: entity.baseline.endDate,
      delayDays: countCalendarDaysBetween(entity.baseline.endDate, entity.forecast.endDate),
      forecastEndDate: entity.forecast.endDate,
      health: entity.rollupHealth,
      id: entity.id,
      progress: entity.progress,
      status: entity.status,
      title: entity.title,
      type: entity.type,
    }))
    .sort((left, right) =>
      left.forecastEndDate.localeCompare(right.forecastEndDate) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    )
  const boundedLimit = Math.max(0, limit)

  return {
    delayedCount: rows.filter((row) => row.delayDays > 0).length,
    hiddenCount: Math.max(0, rows.length - boundedLimit),
    items: rows.slice(0, boundedLimit),
  }
}

/**
 * Groups Project members by role and keeps a bounded list, managers first.
 *
 * @param members - Project members returned by the member API.
 * @param limit - Most members to list by name.
 * @returns Role counts and the bounded member list.
 */
export function summarizeProjectOverviewMembers(
  members: readonly ProjectMember[],
  limit = PROJECT_OVERVIEW_MEMBER_LIMIT,
): ProjectOverviewMembers {
  const roleOrder: Record<ProjectMemberRole, number> = { manager: 0, member: 1, viewer: 2 }
  const roleCounts: Record<ProjectMemberRole, number> = { manager: 0, member: 0, viewer: 0 }
  for (const member of members) {
    roleCounts[member.role] += 1
  }
  const sorted = [...members].sort((left, right) =>
    roleOrder[left.role] - roleOrder[right.role] ||
    resolveProjectOverviewMemberName(left).localeCompare(resolveProjectOverviewMemberName(right)) ||
    left.id.localeCompare(right.id)
  )
  const boundedLimit = Math.max(0, limit)

  return {
    hiddenCount: Math.max(0, sorted.length - boundedLimit),
    roleCounts,
    shown: sorted.slice(0, boundedLimit),
    totalCount: members.length,
  }
}

/** Agent Run lane counts of one Project, taken from its Team's Factory board. */
export type ProjectOverviewAgentRuns = {
  /** Work Items of the Project in each Factory board lane. */
  laneCounts: Record<FactoryBoardLane, number>
  /** Work Items of the Project on the board, across every lane. */
  totalCount: number
  /** Whether the board stopped at a read bound, so the counts can be low. */
  isIncomplete: boolean
}

/**
 * Counts one Project's Work Items in each Factory board lane.
 *
 * The lanes come from the shared `classifyFactoryBoardItem` rule evaluated at the board's
 * `generatedAt`, the same way the Factory board places its tiles, so both screens agree.
 *
 * @param board - The Team's Factory board.
 * @param projectId - Project whose Work Items are counted.
 * @returns Lane counts and whether the board read was bounded.
 */
export function summarizeProjectOverviewAgentRuns(
  board: TeamAgentRunBoardResponse,
  projectId: string,
): ProjectOverviewAgentRuns {
  const laneCounts: Record<FactoryBoardLane, number> = {
    processing: 0,
    'no-run': 0,
    decision: 0,
    stalled: 0,
    failed: 0,
    completed: 0,
  }
  const evaluatedAt = new Date(board.generatedAt)
  const now = Number.isFinite(evaluatedAt.getTime()) ? evaluatedAt : new Date()
  let totalCount = 0
  for (const item of board.items) {
    if (item.workItem.assignedProjectId !== projectId) continue
    const lane = classifyFactoryBoardItem(item, now)
    if (lane === undefined) continue
    laneCounts[lane] += 1
    totalCount += 1
  }
  return {
    isIncomplete: board.activeRunsHasMore || board.finishedRunsHasMore || board.startedWorkItemsHasMore,
    laneCounts,
    totalCount,
  }
}

/**
 * Resolves the label shown for one Project member.
 *
 * @param member - Project member.
 * @returns The display name, or the email address when no name is set.
 */
export function resolveProjectOverviewMemberName(member: ProjectMember) {
  return member.name?.trim() || member.email
}

/**
 * Counts calendar days from one `YYYY-MM-DD` date to another.
 *
 * @param from - Start date.
 * @param to - End date.
 * @returns Whole days from `from` to `to`, or 0 when either date is invalid.
 */
function countCalendarDaysBetween(from: string, to: string) {
  const fromTime = Date.parse(`${from}T00:00:00.000Z`)
  const toTime = Date.parse(`${to}T00:00:00.000Z`)
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) return 0
  return Math.round((toTime - fromTime) / 86_400_000)
}
