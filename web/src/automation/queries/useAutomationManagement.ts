import useSWR from 'swr'
import type { ProjectDirectoryTeam } from '../../projects/api/directory'
import {
  loadAutomationManagementData,
  type AutomationManagementData,
} from '../managementData'
import { loadOwnedAutomationExecutions } from './loadOwnedAutomationExecutions'

/**
 * Automation management panelに必要なrules・templates・executionsを取得します。
 *
 * @param accessToken - Automation API の access token です。
 * @param teams - Workflow target解決に利用するTeam一覧です。
 * @param canManage - 管理者向けresourceを取得できるかどうかです。
 * @param ownerTeamId - Team settings で表示する所有 Team です。
 * @returns Automation management data の SWR state です。
 */
export function useAutomationManagement(
  accessToken: string,
  teams: ProjectDirectoryTeam[],
  canManage: boolean,
  ownerTeamId?: string,
) {
  return useSWR<AutomationManagementData>(
    ['automation-management', accessToken, canManage, teams.map((team) => team.id).join('\0'), ownerTeamId ?? ''],
    () => ownerTeamId === undefined
      ? loadAutomationManagementData(accessToken, teams, canManage)
      : loadTeamAutomationManagementData(accessToken, teams, ownerTeamId),
  )
}

/**
 * Loads the management data for the Team settings view, replacing the first Workspace execution
 * page with the runs collected for the owner Team.
 *
 * @param accessToken - Automation API access token.
 * @param teams - Teams used to resolve Workflow targets.
 * @param ownerTeamId - Team whose definitions are shown.
 * @returns Management data whose executions belong to the owner Team.
 */
async function loadTeamAutomationManagementData(
  accessToken: string,
  teams: ProjectDirectoryTeam[],
  ownerTeamId: string,
): Promise<AutomationManagementData> {
  const [data, executions] = await Promise.all([
    loadAutomationManagementData(accessToken, teams, false),
    loadOwnedAutomationExecutions(accessToken, ownerTeamId),
  ])
  return { ...data, executions }
}
