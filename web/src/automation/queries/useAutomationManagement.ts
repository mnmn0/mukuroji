import useSWR from 'swr'
import type { ProjectDirectoryTeam } from '../../projects/api/directory'
import {
  loadAutomationManagementData,
  type AutomationManagementData,
} from '../managementData'
import { loadOwnedAutomationExecutions } from './loadOwnedAutomationExecutions'

/** Management data with the cursor where the Team's run search continues. */
export type TeamAwareAutomationManagementData = AutomationManagementData & {
  /** Cursor for older runs of the Team, present while history remains unsearched (Team view only). */
  executionsNextCursor?: string
}

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
  return useSWR<TeamAwareAutomationManagementData>(
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
): Promise<TeamAwareAutomationManagementData> {
  const [data, page] = await Promise.all([
    loadAutomationManagementData(accessToken, teams, false),
    loadOwnedAutomationExecutions(accessToken, ownerTeamId),
  ])
  return { ...data, executions: page.executions, executionsNextCursor: page.nextCursor }
}

/**
 * Continues the search for older runs of the Team and appends them to the loaded data.
 *
 * @param accessToken - Automation API access token.
 * @param ownerTeamId - Team whose runs are collected.
 * @param data - Loaded Team management data that carries the continuation cursor.
 * @returns The data with the older runs appended and the next cursor, if any.
 */
export async function loadMoreOwnedAutomationExecutions(
  accessToken: string,
  ownerTeamId: string,
  data: TeamAwareAutomationManagementData,
): Promise<TeamAwareAutomationManagementData> {
  if (!data.executionsNextCursor) return data
  const page = await loadOwnedAutomationExecutions(accessToken, ownerTeamId, data.executionsNextCursor)
  const seen = new Set(data.executions.map((execution) => execution.id))
  return {
    ...data,
    executions: [...data.executions, ...page.executions.filter((execution) => !seen.has(execution.id))],
    executionsNextCursor: page.nextCursor,
  }
}
