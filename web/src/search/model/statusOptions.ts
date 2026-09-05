import {
  createSearchWorkItemStatusKey,
  readSearchWorkItemStatusKey,
  type ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  resolveWorkItemTypeWorkflow,
  resolveWorkItemTypes,
} from '../../work-items/model/workItemDisplay'

/**
 * Workspace 検索の status filter に表示する選択肢です。
 */
export type SearchStatusOption = {
  /** Workflow status ID です。 */
  id: string
  /** Team configuration から解決した表示名です。 */
  label: string
}

/**
 * Creates collision-safe Search status options from Team configurations and visible filter values.
 *
 * @param configurationsByTeam - Resolved Work Item configuration by Team ID.
 * @param visibleStatusIds - Qualified or legacy status values from the URL and loaded results.
 * @param teamNamesById - Optional human-readable Team names used in option labels.
 * @returns Search options keyed by Team, Work Item Type, and status identity.
 */
export function createSearchStatusOptions(
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  visibleStatusIds: readonly string[],
  teamNamesById: Readonly<Record<string, string>> = {},
): SearchStatusOption[] {
  const optionsByStatusKey = new Map<string, SearchStatusOption>()

  for (const [teamId, resolvedConfiguration] of Object.entries(configurationsByTeam)
    .sort(([firstTeamId], [secondTeamId]) => firstTeamId.localeCompare(secondTeamId))) {
    const teamLabel = teamNamesById[teamId] ?? teamId
    for (const type of resolveWorkItemTypes(resolvedConfiguration)) {
      const workflow = resolveWorkItemTypeWorkflow(resolvedConfiguration, type.id)
      if (!workflow) continue
      const statuses = [...workflow.statuses].sort((first, second) =>
        first.sortOrder - second.sortOrder || first.name.localeCompare(second.name)
      )

      for (const status of statuses) {
        const id = createSearchWorkItemStatusKey(teamId, type.id, status.id)
        optionsByStatusKey.set(id, {
          id,
          label: `${teamLabel} · ${type.name} · ${status.name}`,
        })
      }
    }
  }

  for (const statusId of visibleStatusIds) {
    if (!statusId) continue
    const qualifiedStatus = readSearchWorkItemStatusKey(statusId)
    if (qualifiedStatus) {
      if (!optionsByStatusKey.has(statusId)) {
        const teamLabel = teamNamesById[qualifiedStatus.teamId] ?? qualifiedStatus.teamId
        optionsByStatusKey.set(statusId, {
          id: statusId,
          label: `${teamLabel} · ${qualifiedStatus.workItemTypeId} · ${qualifiedStatus.statusId}`,
        })
      }
    } else if (!optionsByStatusKey.has(statusId)) {
      optionsByStatusKey.set(statusId, { id: statusId, label: statusId })
    }
  }

  return [...optionsByStatusKey.values()]
}
