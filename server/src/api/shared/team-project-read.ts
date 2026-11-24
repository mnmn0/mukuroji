import { workItemScheduleInstantToLocalDate, type TeamIssueResponseItem } from '../../modules/work-items'
import { mapInOrderWithConcurrency } from './agent-run-access'
import { workItemDependencies } from './app-dependencies'
import { WORK_ITEMS_SUMMARY_SCAN_LIMIT } from './constants'
import {
  canAccessAssignedProject,
  hasEnterprisePermissionAtResource,
  type WorkspacePrincipal,
} from './project-access'
import { forEachTeamPartitionPage } from './work-item-aggregate-read'
import { createWorkItemListLimitExceededError } from './work-item-access'
import type { TeamPermissionContext } from './workspace-access'

/** Most Project baselines read at once. */
const BASELINE_READ_CONCURRENCY = 8

/**
 * Builds the check that tells whether the reader may read the Work Items of one Project of the
 * Team, or the Team-level Work Items outside any Project (which need only Team access, which the
 * route already required).
 *
 * @param principal - Reader.
 * @param context - Reader's Team context at viewer level.
 * @returns The check, taking a Project ID or `undefined` for Work Items outside any Project.
 */
export function createProjectReadCheck(principal: WorkspacePrincipal, context: TeamPermissionContext) {
  const teamId = context.team.id
  const teamProjectIds = new Set(context.team.projects.map((project) => project.id))
  return (projectId: string | undefined) => {
    // Team access does not imply Work Item access under Enterprise roles: the reader needs
    // `work-items.read` at the Work Item's Project, or at the Team for a Team-level Work Item.
    if (
      principal.enterpriseAuthorizationEvaluation !== undefined &&
      !principal.isSystemAdmin &&
      !hasEnterprisePermissionAtResource(principal, 'work-items.read', projectId === undefined
        ? { workspaceId: principal.directoryId, kind: 'team', targetId: teamId }
        : { workspaceId: principal.directoryId, kind: 'project', targetId: projectId, parentTeamId: teamId })
    ) {
      return false
    }
    if (projectId === undefined) return true
    return (principal.isSystemAdmin || teamProjectIds.has(projectId)) &&
      canAccessAssignedProject(principal, context, projectId, 'viewer')
  }
}

/**
 * Returns today's date in a Work Item's schedule calendar. An unreadable calendar falls back to
 * the UTC date, so one malformed Work Item does not fail the whole summary.
 *
 * @param now - Instant the summary is computed at.
 * @param workItem - Work Item.
 * @returns Local `YYYY-MM-DD` date.
 */
export function readLocalToday(now: Date, workItem: TeamIssueResponseItem) {
  try {
    return workItemScheduleInstantToLocalDate(now, workItem.schedule.calendarPolicy)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

/**
 * Reads the Team's non-archived Work Items the reader may read, for the weekly summary.
 *
 * @param principal - Reader.
 * @param context - Reader's Team context at viewer level.
 * @param canReadProject - Reader's Project check.
 * @returns The readable Work Items.
 * @throws ProjectDataError 413 when the Team has more Work Items than one summary reads.
 */
export async function readSummaryWorkItems(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  canReadProject: (projectId: string | undefined) => boolean,
) {
  const workItems: TeamIssueResponseItem[] = []
  let scanned = 0
  await forEachTeamPartitionPage(principal, context, false, (issues, rawCount) => {
    scanned += rawCount
    if (scanned > WORK_ITEMS_SUMMARY_SCAN_LIMIT) {
      throw createWorkItemListLimitExceededError(
        `This Team has more than ${WORK_ITEMS_SUMMARY_SCAN_LIMIT} Work Items to summarize.`,
      )
    }
    for (const issue of issues) if (canReadProject(issue.assignedProjectId)) workItems.push(issue)
  })
  return workItems
}

/**
 * Reads the latest schedule baseline of each Project.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team ID.
 * @param projectIds - Readable Projects of the Team.
 * @returns Each Project's baseline, or `null` when none was captured.
 */
export async function readProjectBaselines(directoryId: string, teamId: string, projectIds: readonly string[]) {
  const baselines = await mapInOrderWithConcurrency(projectIds, BASELINE_READ_CONCURRENCY, async (projectId) =>
    [projectId, await workItemDependencies.scheduleBaselines.get(directoryId, teamId, projectId)] as const)
  return new Map(baselines)
}
