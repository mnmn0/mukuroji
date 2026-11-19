import type { AnalyticsReport } from '@mukuroji/contracts'
import type { WorkspacePrincipal } from './project-access'
import type { WorkspaceSearchContext } from './search-access'

/**
 * Reports whether the current viewer can read a saved Analytics report definition.
 *
 * Shared by the Analytics routes and the Inbox, so a scheduled-delivery notification disappears as
 * soon as its recipient could no longer open the report.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Current directory and saved-view access of the principal.
 * @param report - Current stored report.
 * @returns Whether the report's visibility admits the principal.
 */
export function canReadAnalyticsReport(
  principal: WorkspacePrincipal,
  context: Pick<WorkspaceSearchContext, 'savedViewAccess'>,
  report: AnalyticsReport,
) {
  if (report.visibility === 'personal') {
    return report.ownerMemberKey === principal.userKey
  }
  if (report.visibility === 'shared') {
    return true
  }
  return report.visibility === 'team' &&
    typeof report.teamId === 'string' &&
    context.savedViewAccess.teamIds.has(report.teamId)
}
