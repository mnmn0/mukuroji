import {
  isWorkItemEffortMinutes,
  isWorkItemProgressPercent,
  type WorkItemContributorAssignment,
  type WorkItemSchedule,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import type { WorkItemDependencies } from '../../app/composition/app-dependencies'
import { workItemDependencies } from './app-dependencies'
import { WORK_ITEMS_AGGREGATE_ITEM_LIMIT, WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE } from './constants'
import { stableDigestStringify } from './value-guards'
import { createWorkItemListLimitExceededError } from './work-item-access'

/** Remaining effort and manual progress fields a Work Item update may carry. */
export type WorkItemEffortChange = {
  /** Recorded remaining minutes, or null to clear it. */
  remainingEffortMinutes?: number | null
  /** Manually recorded progress percentage, or null to clear it. */
  progressPercent?: number | null
}

/**
 * Validates the remaining effort and manual progress fields of a Work Item update body.
 *
 * The estimate itself lives in `schedule.plannedEffortMinutes` and is validated with the schedule.
 *
 * @param body - Untrusted update body.
 * @returns Only the effort fields present in the body, validated.
 * @throws ProjectDataError (400) when a present value is not a valid amount.
 */
export function readWorkItemEffortChange(body: Record<string, unknown>): WorkItemEffortChange {
  const change: WorkItemEffortChange = {}
  if ('remainingEffortMinutes' in body) {
    const value = body.remainingEffortMinutes
    if (value !== null && !isWorkItemEffortMinutes(value)) {
      throw new ProjectDataError(400, 'InvalidWorkItemEffort', 'remainingEffortMinutes must be a nonnegative integer or null.')
    }
    change.remainingEffortMinutes = value
  }
  if ('progressPercent' in body) {
    const value = body.progressPercent
    if (value !== null && !isWorkItemProgressPercent(value)) {
      throw new ProjectDataError(400, 'InvalidWorkItemProgress', 'progressPercent must be an integer from 0 to 100 or null.')
    }
    change.progressPercent = value
  }
  return change
}

/**
 * Returns whether a schedule replacement changes calendar placement, not only the estimate.
 *
 * Changing `plannedEffortMinutes` alone moves no date, so it needs no dependency preview or
 * confirmation; any other difference does.
 *
 * @param next - Untrusted replacement schedule from the request body.
 * @param current - Stored schedule.
 * @returns Whether anything other than the planned effort differs.
 */
export function changesWorkItemSchedulePlacement(next: unknown, current: unknown): boolean {
  return stableDigestStringify(withoutPlannedEffort(next)) !== stableDigestStringify(withoutPlannedEffort(current))
}

/**
 * Writes an estimate into a stored schedule, keeping its placement.
 *
 * The Public API accepts `plannedEffortMinutes` on its own so that a client changing only the
 * estimate sends a body that does not depend on the dates it read; a retry under the same
 * idempotency key then stays the same request even if a person moved the dates in between.
 *
 * @param schedule - Stored schedule.
 * @param plannedEffortMinutes - New estimate in minutes, or null to clear it.
 * @returns The schedule with the estimate replaced.
 */
export function withWorkItemPlannedEffort<T extends { plannedEffortMinutes?: number }>(
  schedule: T,
  plannedEffortMinutes: number | null,
): Omit<T, 'plannedEffortMinutes'> & { plannedEffortMinutes?: number } {
  const { plannedEffortMinutes: _previous, ...placement } = schedule
  return plannedEffortMinutes === null ? placement : { ...placement, plannedEffortMinutes }
}

/**
 * Copies a schedule-shaped value without its planned effort.
 *
 * @param schedule - Schedule-shaped value.
 * @returns The value itself when it is not an object, otherwise a shallow copy without the estimate.
 */
function withoutPlannedEffort(schedule: unknown): unknown {
  if (typeof schedule !== 'object' || schedule === null || Array.isArray(schedule)) return schedule
  const { plannedEffortMinutes: _plannedEffortMinutes, ...placement } = Object.fromEntries(Object.entries(schedule))
  return placement
}

/** The estimate fields of one Work Item that capacity and time reports read. */
export type TeamWorkItemEffort = {
  /** Team-local Work Item identifier. */
  workItemId: string
  /** Canonical estimate (`schedule.plannedEffortMinutes`), when set. */
  plannedEffortMinutes?: number
  /** Recorded remaining effort, or 0 for a completed or canceled Work Item; absent otherwise. */
  remainingEffortMinutes?: number
  /** Project the Work Item is assigned to, used to apply the reader's Project visibility. */
  projectId?: string
  /**
   * Local calendar dates over which contributor shares are placed: the schedule's range, or its
   * due date; absent for an unscheduled Work Item.
   */
  window?: { fromDate: string, toDate: string }
  /**
   * Unfinished contributor shares of decided members with planned effort; absent for a completed
   * or canceled Work Item and when there are none.
   */
  contributors?: Array<{
    /** Contributor assignment ID within the Work Item. */
    assignmentId: string
    /** Contributing member. */
    memberId: string
    /** Planned effort of the share in minutes. */
    plannedEffortMinutes: number
  }>
}

/** Which Work Items {@link listTeamWorkItemEffort} reads. */
export type TeamWorkItemEffortReadOptions = {
  /**
   * Also reads archived Work Items. Time reports set it, because archiving finished work must not
   * drop its estimate while its recorded time still counts; capacity planning leaves it unset.
   */
  includeArchived?: boolean
}

/**
 * Reads the estimate and remaining effort of every Work Item in a Team that has one.
 *
 * This is a server-side read for Team reports whose callers already authorized the Team; it reads
 * the Team partition page by page and fails closed past {@link WORK_ITEMS_AGGREGATE_ITEM_LIMIT} rows.
 *
 * @param directoryId - Workspace (directory) identifier.
 * @param teamId - Team identifier.
 * @param options - Whether archived Work Items are read too; they are left out by default.
 * @param teamIssues - Work Item reader; the request's Work Item dependencies by default.
 * @returns One entry per Work Item with an estimate, recorded remaining effort, or terminal status.
 */
export async function listTeamWorkItemEffort(
  directoryId: string,
  teamId: string,
  options: TeamWorkItemEffortReadOptions = {},
  teamIssues: Pick<WorkItemDependencies['teamIssues'], 'getTeamIssues'> = workItemDependencies.teamIssues,
): Promise<TeamWorkItemEffort[]> {
  const result: TeamWorkItemEffort[] = []
  let evaluated = 0
  let startAfterIssueId: string | undefined
  do {
    const response = await teamIssues.getTeamIssues(directoryId, teamId, {
      limit: WORK_ITEMS_AGGREGATE_READ_PAGE_SIZE,
      includeArchived: options.includeArchived === true,
      consistentRead: true,
      limitEvaluatedRows: true,
      ...(startAfterIssueId ? { startAfterIssueId } : {}),
    })
    evaluated += response.evaluatedCount ?? response.issues.length
    if (evaluated > WORK_ITEMS_AGGREGATE_ITEM_LIMIT) {
      throw createWorkItemListLimitExceededError(`Team has more than ${WORK_ITEMS_AGGREGATE_ITEM_LIMIT} Work Items to estimate.`)
    }
    for (const issue of response.issues) {
      const terminal = issue.statusCategory === 'completed' || issue.statusCategory === 'canceled'
      const remainingEffortMinutes = terminal ? 0 : issue.remainingEffortMinutes
      const plannedEffortMinutes = issue.schedule.plannedEffortMinutes
      const contributors = terminal ? [] : listPlannedContributorShares(issue.contributorAssignments ?? [])
      if (plannedEffortMinutes === undefined && remainingEffortMinutes === undefined && contributors.length === 0) {
        continue
      }
      const window = readWorkItemScheduleWindow(issue.schedule)
      result.push({
        workItemId: issue.id,
        ...(plannedEffortMinutes === undefined ? {} : { plannedEffortMinutes }),
        ...(remainingEffortMinutes === undefined ? {} : { remainingEffortMinutes }),
        ...(issue.assignedProjectId ? { projectId: issue.assignedProjectId } : {}),
        ...(window ? { window } : {}),
        ...(contributors.length > 0 ? { contributors } : {}),
      })
    }
    if (response.nextStartAfterIssueId !== undefined && response.nextStartAfterIssueId === startAfterIssueId) {
      throw new ProjectDataError(503, 'WorkItemListReadStalled', `Team "${teamId}" Work Item read did not advance.`)
    }
    startAfterIssueId = response.nextStartAfterIssueId
  } while (startAfterIssueId !== undefined)
  return result
}

/**
 * Lists the contributor shares that still plan effort for a decided member.
 *
 * A role-only share has no member whose capacity it can use, and a `done` share or one without
 * planned effort reserves nothing.
 *
 * @param assignments - Stored contributor assignments.
 * @returns The shares capacity planning places on members.
 */
function listPlannedContributorShares(
  assignments: readonly WorkItemContributorAssignment[],
): NonNullable<TeamWorkItemEffort['contributors']> {
  return assignments.flatMap((assignment) =>
    assignment.memberUserId === undefined ||
      assignment.status === 'done' ||
      !assignment.plannedEffortMinutes
      ? []
      : [{
          assignmentId: assignment.assignmentId,
          memberId: assignment.memberUserId,
          plannedEffortMinutes: assignment.plannedEffortMinutes,
        }])
}

/**
 * Reads the local dates a Work Item's schedule spans.
 *
 * @param schedule - Canonical Work Item schedule.
 * @returns The inclusive date range, the due date alone, or undefined when unscheduled.
 */
function readWorkItemScheduleWindow(schedule: WorkItemSchedule): TeamWorkItemEffort['window'] {
  switch (schedule.mode) {
    case 'unscheduled':
      return undefined
    case 'due-date':
      return { fromDate: schedule.dueDate, toDate: schedule.dueDate }
    case 'date-range':
    case 'milestone':
      return { fromDate: schedule.startDate, toDate: schedule.endDate }
  }
}
