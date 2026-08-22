import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { useWorkspaceWorkItems } from '../../issues/queries/useWorkItems'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { CanonicalWorkItem } from '../../tasks/api'
import { getUniqueWorkspaceProjectIds } from '../../work-items/model/workspaceWorkItems'
import { useTeamWorkItemConfigurations } from '../../work-items/queries/useWorkItemConfigurations'
import type { TeamWorkItemConfigurationLoadResult } from '../../work-items/queries/teamWorkItemConfigurations'

const emptyWorkspaceTasks: CanonicalWorkItem[] = []
const emptyConfigurationsByTeam: Record<string, ResolvedWorkItemConfiguration> = {}
const emptyConfigurationLoadResult: TeamWorkItemConfigurationLoadResult = {
  configurationsByTeam: emptyConfigurationsByTeam,
  errors: [],
  failedTeamIds: [],
}

/**
 * Loads Workspace Work Items and their owning Team configurations in one SWR cache scope.
 *
 * @param accessToken - Access token used by Workspace APIs.
 * @param enabled - Whether queries may run for the authenticated route.
 * @param teams - Workspace directory used to report the affected Project count.
 * @param includeArchived - Whether archived Work Items should be loaded for the route.
 * @returns Work Items, configurations, query states, and cache mutation callbacks.
 */
export function useWorkspaceWorkItemData(
  accessToken: string | undefined,
  enabled = true,
  teams: readonly ProjectDirectoryTeam[] = [],
  includeArchived = false,
) {
  const workItemsQuery = useWorkspaceWorkItems(accessToken, enabled, includeArchived)
  const tasks = workItemsQuery.data ?? emptyWorkspaceTasks
  const teamIds = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.teamId))).sort(),
    [tasks],
  )
  const configurationsQuery = useTeamWorkItemConfigurations(
    accessToken,
    'workspace',
    teamIds,
    enabled,
  )
  const configurationLoadResult = configurationsQuery.data ?? emptyConfigurationLoadResult

  return {
    configurationErrors: configurationLoadResult.errors,
    configurationFailedTeamIds: configurationLoadResult.failedTeamIds,
    configurationsByTeam: configurationLoadResult.configurationsByTeam,
    configurationsError: configurationsQuery.error,
    configurationsKey: configurationsQuery.key,
    failedProjectCount: workItemsQuery.error
      ? getUniqueWorkspaceProjectIds(teams).length
      : 0,
    isLoading: Boolean(
      workItemsQuery.key && workItemsQuery.isLoading,
    ) || Boolean(
      configurationsQuery.key && configurationsQuery.isLoading,
    ),
    isConfigurationsLoading: configurationsQuery.isLoading,
    isWorkItemsLoading: workItemsQuery.isLoading,
    mutateConfigurations: configurationsQuery.mutate,
    mutateWorkItems: workItemsQuery.mutate,
    tasks,
    workItemsError: workItemsQuery.error,
    workItemsKey: workItemsQuery.key,
  }
}
