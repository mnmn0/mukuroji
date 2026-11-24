import type { AnalyticsReport } from '@mukuroji/contracts'
import { createTaskViewProjectScopeKey } from '../../modules/workspace-search/workspace-search'
import type { WorkspacePrincipal } from './project-access'
import type { WorkspaceSearchContext } from './search-access'

/**
 * Reports whether the current viewer can read a saved Analytics report definition.
 *
 * Shared by the Analytics routes and the Inbox, so a scheduled-delivery notification disappears as
 * soon as its recipient could no longer open the report.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Current directory, saved-view, and Project access of the principal.
 * @param report - Current stored report.
 * @returns Whether the report's visibility admits the principal.
 */
export function canReadAnalyticsReport(
  principal: WorkspacePrincipal,
  context: Pick<WorkspaceSearchContext, 'savedViewAccess' | 'taskViewAccess'>,
  report: AnalyticsReport,
) {
  if (report.visibility === 'personal') {
    return report.ownerMemberKey === principal.userKey
  }
  if (report.visibility === 'shared') {
    return true
  }
  if (report.visibility === 'project') {
    // The Team qualifies the Project, so a same-named Project of another Team does not admit the viewer.
    return typeof report.teamId === 'string' &&
      typeof report.projectId === 'string' &&
      context.taskViewAccess.projectScopeKeys.has(
        createTaskViewProjectScopeKey(report.teamId, report.projectId),
      )
  }
  return report.visibility === 'team' &&
    typeof report.teamId === 'string' &&
    context.savedViewAccess.teamIds.has(report.teamId)
}
