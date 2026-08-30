import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
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
 * Team ごとの configuration と現在表示中の status ID から検索用選択肢を作ります。
 *
 * @param configurationsByTeam - Team ID ごとの解決済み configuration です。
 * @param visibleStatusIds - URL filter または検索結果に含まれる status ID です。
 * @returns Status ID で重複排除した検索用選択肢です。
 */
export function createSearchStatusOptions(
  configurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>,
  visibleStatusIds: readonly string[],
): SearchStatusOption[] {
  const labelsByStatusId = new Map<string, Set<string>>()

  for (const [, resolvedConfiguration] of Object.entries(configurationsByTeam)
    .sort(([firstTeamId], [secondTeamId]) => firstTeamId.localeCompare(secondTeamId))) {
    const workflows = new Map(
      [
        resolvedConfiguration.configuration.workflow,
        ...(resolvedConfiguration.configuration.workflows ?? []),
        ...resolveWorkItemTypes(resolvedConfiguration).flatMap((type) => {
          const workflow = resolveWorkItemTypeWorkflow(resolvedConfiguration, type.id)
          return workflow ? [workflow] : []
        }),
      ].map((workflow) => [workflow.id, workflow]),
    )
    const statuses = [...workflows.values()]
      .flatMap((workflow) => workflow.statuses)
      .sort((first, second) =>
        first.sortOrder - second.sortOrder || first.name.localeCompare(second.name)
      )

    for (const status of statuses) {
      const labels = labelsByStatusId.get(status.id) ?? new Set<string>()
      labels.add(status.name)
      labelsByStatusId.set(status.id, labels)
    }
  }

  for (const statusId of visibleStatusIds) {
    if (statusId && !labelsByStatusId.has(statusId)) {
      labelsByStatusId.set(statusId, new Set())
    }
  }

  return Array.from(labelsByStatusId, ([id, labels]) => ({
    id,
    label: labels.size > 0
      ? Array.from(labels).sort((first, second) => first.localeCompare(second)).join(' / ')
      : id,
  }))
}
