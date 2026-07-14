import type {
  CustomFieldDefinition,
  CustomFieldValue,
  ResolvedWorkItemConfiguration,
  WorkflowStatusCategory,
  WorkflowStatusDefinition,
  WorkItem,
  WorkItemConfiguration,
  WorkItemStatus,
} from '@mukuroji/contracts'
import {
  formatCustomFieldValue,
  matchesCustomFieldFilter,
  type FormatCustomFieldValueOptions,
} from './customFields'

/**
 * Status 解決 helper が受け取れる configuration です。
 */
export type WorkItemConfigurationLike =
  | WorkItemConfiguration
  | ResolvedWorkItemConfiguration
  | undefined

const legacyStatusCategories: Record<WorkItemStatus, WorkflowStatusCategory> = {
  todo: 'unstarted',
  'in-progress': 'started',
  review: 'started',
  done: 'completed',
}

/**
 * Work Item の status ID に対応する解決済み definition を返します。
 *
 * @param workItem - Status を表示する Work Item です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @returns 一致する status definition、または未知の status では undefined です。
 */
export function resolveWorkflowStatusDefinition(
  workItem: Pick<WorkItem, 'status' | 'workflowStatusId'>,
  configuration: WorkItemConfigurationLike,
) {
  const statusId = workItem.workflowStatusId ?? workItem.status

  return getWorkItemConfiguration(configuration)?.workflow.statuses.find(
    (status) => status.id === statusId,
  )
}

/**
 * Work Item の status label を configuration の literal 名から解決します。
 *
 * @param workItem - Status を表示する Work Item です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @param resolveLegacyLabel - Built-in legacy status の任意 label resolver です。
 * @returns Configuration 名、legacy label、status ID の順で解決した表示名です。
 */
export function resolveWorkflowStatusLabel(
  workItem: Pick<WorkItem, 'status' | 'workflowStatusId'>,
  configuration: WorkItemConfigurationLike,
  resolveLegacyLabel?: (status: WorkItemStatus) => string,
) {
  return resolveWorkflowStatusDefinition(workItem, configuration)?.name ??
    (workItem.workflowStatusId ? workItem.workflowStatusId : resolveLegacyLabel?.(workItem.status)) ??
    workItem.status
}

/**
 * Work Item の標準 status category を snapshot、definition、legacy status の順で解決します。
 *
 * @param workItem - Category を解決する Work Item です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @returns 横断集計に利用できる status category です。
 */
export function resolveWorkflowStatusCategory(
  workItem: Pick<WorkItem, 'status' | 'statusCategory' | 'workflowStatusId'>,
  configuration?: WorkItemConfigurationLike,
): WorkflowStatusCategory {
  return workItem.statusCategory ??
    resolveWorkflowStatusDefinition(workItem, configuration)?.category ??
    resolveLegacyStatusCategory(workItem.status)
}

/**
 * Legacy status を標準 workflow category へ安全に変換します。
 *
 * @param status - Canonical v1 の legacy status です。
 * @returns Built-in workflow と同じ意味を持つ標準 category です。
 */
export function resolveLegacyStatusCategory(status: WorkItemStatus): WorkflowStatusCategory {
  return legacyStatusCategories[status] ?? 'backlog'
}

/**
 * Status category に対応する既存 workbench badge class を返します。
 *
 * @param category - 表示対象 status category です。
 * @returns 既存 palette に沿う badge class です。
 */
export function resolveWorkflowCategoryToneClassName(category: WorkflowStatusCategory) {
  const classes: Record<WorkflowStatusCategory, string> = {
    backlog: 'workbench-badge',
    unstarted: 'workbench-badge',
    started: 'workbench-badge-primary',
    completed: 'workbench-badge-success',
    canceled: 'workbench-badge-danger',
  }

  return classes[category]
}

/**
 * 現在 status から選択できる遷移先を workflow の表示順で返します。
 *
 * 現在 status は form の値を保持できるよう必ず一覧へ含めます。
 *
 * @param currentStatusId - 現在の workflow status ID です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @returns 現在 status と許可 transition 先の status definition です。
 */
export function resolveAllowedWorkflowStatuses(
  currentStatusId: string,
  configuration: WorkItemConfigurationLike,
) {
  const workflow = getWorkItemConfiguration(configuration)?.workflow

  if (!workflow) {
    return []
  }

  const allowedStatusIds = new Set([
    currentStatusId,
    ...workflow.transitions
      .filter((transition) => transition.fromStatusId === currentStatusId)
      .map((transition) => transition.toStatusId),
  ])

  return sortWorkflowStatuses(workflow.statuses).filter((status) => allowedStatusIds.has(status.id))
}

/**
 * Work Item が completed category か判定します。
 *
 * @param workItem - 判定対象 Work Item です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @returns 完了として進捗率へ加算する場合は true です。
 */
export function isCompletedWorkItem(
  workItem: Pick<WorkItem, 'status' | 'statusCategory' | 'workflowStatusId'>,
  configuration?: WorkItemConfigurationLike,
) {
  return resolveWorkflowStatusCategory(workItem, configuration) === 'completed'
}

/**
 * Work Item が進行中の open category か判定します。
 *
 * Completed と canceled は closed とし、それ以外を open とします。
 *
 * @param workItem - 判定対象 Work Item です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @returns 未完了で操作対象に残る場合は true です。
 */
export function isOpenWorkItem(
  workItem: Pick<WorkItem, 'status' | 'statusCategory' | 'workflowStatusId'>,
  configuration?: WorkItemConfigurationLike,
) {
  const category = resolveWorkflowStatusCategory(workItem, configuration)

  return category !== 'completed' && category !== 'canceled'
}

/**
 * Work Item に保存された custom field value を definition に従って表示します。
 *
 * @param workItem - Custom field value を持つ Work Item です。
 * @param definition - 表示対象 field definition です。
 * @param options - Locale と person/boolean label です。
 * @returns List、board、report で共通利用できる表示文字列です。
 */
export function formatWorkItemCustomFieldValue(
  workItem: Pick<WorkItem, 'customFieldValues'>,
  definition: CustomFieldDefinition,
  options: FormatCustomFieldValueOptions = {},
) {
  return formatCustomFieldValue(definition, workItem.customFieldValues?.[definition.id], options)
}

/**
 * Work Item の custom field value が filter と一致するか判定します。
 *
 * @param workItem - Custom field value を持つ Work Item です。
 * @param definition - Filter 対象 field definition です。
 * @param filterValue - UI から指定された typed filter value です。
 * @returns Filter に一致する場合は true です。
 */
export function matchesWorkItemCustomFieldFilter(
  workItem: Pick<WorkItem, 'customFieldValues'>,
  definition: CustomFieldDefinition,
  filterValue: CustomFieldValue | undefined,
) {
  return matchesCustomFieldFilter(
    definition,
    workItem.customFieldValues?.[definition.id],
    filterValue,
  )
}

/**
 * Workflow status definition を表示順へ安定 sort します。
 *
 * @param statuses - Workflow status definition 一覧です。
 * @returns 元配列を変更しない sort 済み配列です。
 */
export function sortWorkflowStatuses(
  statuses: readonly WorkflowStatusDefinition[],
) {
  return [...statuses].sort(
    (first, second) => first.sortOrder - second.sortOrder || first.name.localeCompare(second.name),
  )
}

function getWorkItemConfiguration(configuration: WorkItemConfigurationLike) {
  if (!configuration) {
    return undefined
  }

  return 'configuration' in configuration ? configuration.configuration : configuration
}
