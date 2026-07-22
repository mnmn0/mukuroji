import useSWR from 'swr'
import type { ProjectDirectoryTeam } from '../../projects/api/directory'
import {
  loadAutomationManagementData,
  type AutomationManagementData,
} from '../managementData'

/**
 * Automation management panelに必要なrules・templates・executionsを取得します。
 *
 * @param accessToken - Automation API の access token です。
 * @param teams - Workflow target解決に利用するTeam一覧です。
 * @param canManage - 管理者向けresourceを取得できるかどうかです。
 * @returns Automation management data の SWR state です。
 */
export function useAutomationManagement(
  accessToken: string,
  teams: ProjectDirectoryTeam[],
  canManage: boolean,
) {
  return useSWR<AutomationManagementData>(
    ['automation-management', accessToken, canManage, teams.map((team) => team.id).join('\0')],
    () => loadAutomationManagementData(accessToken, teams, canManage),
  )
}
