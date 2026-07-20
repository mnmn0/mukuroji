import type {
  CustomFieldOption,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { sortCustomFieldDefinitions } from './customFields'
import { sortWorkflowStatuses } from './workItemDisplay'

/**
 * Configuration を editor draft 用に深く複製します。
 *
 * @param configuration - API から取得した configuration です。
 * @returns Editor が安全に更新できる複製です。
 */
export function cloneWorkItemConfiguration(
  configuration: WorkItemConfiguration,
): WorkItemConfiguration {
  return {
    ...configuration,
    workflow: {
      ...configuration.workflow,
      statuses: configuration.workflow.statuses.map((status) => ({ ...status })),
      transitions: configuration.workflow.transitions.map((transition) => ({ ...transition })),
    },
    customFields: configuration.customFields.map((field) => ({
      ...field,
      defaultValue: Array.isArray(field.defaultValue) ? [...field.defaultValue] : field.defaultValue,
      options: field.options?.map((option) => ({ ...option })),
      projectIds: field.projectIds ? [...field.projectIds] : undefined,
      validation: field.validation ? { ...field.validation } : undefined,
    })),
  }
}

/**
 * Custom field option を editor の表示順へ並べます。
 *
 * @param options - 並べ替え対象の option 一覧です。
 * @returns 元配列を変更せず表示順へ並べた option 一覧です。
 */
export function sortCustomFieldOptions(
  options: readonly CustomFieldOption[],
): CustomFieldOption[] {
  return [...options].sort(
    (first, second) =>
      first.sortOrder - second.sortOrder || first.name.localeCompare(second.name),
  )
}

/**
 * Configuration editor の draft を表示順に正規化して保存 payload を作ります。
 *
 * @param configuration - Editor が保持する未正規化の configuration です。
 * @returns Status、custom field、option の表示順を連番へ変換した configuration です。
 */
export function normalizeWorkItemConfigurationForSave(
  configuration: WorkItemConfiguration,
): WorkItemConfiguration {
  return {
    ...cloneWorkItemConfiguration(configuration),
    workflow: {
      ...configuration.workflow,
      statuses: sortWorkflowStatuses(configuration.workflow.statuses).map((status, index) => ({
        ...status,
        name: status.name.trim(),
        sortOrder: index,
      })),
      transitions: [...configuration.workflow.transitions].sort(
        (first, second) =>
          first.fromStatusId.localeCompare(second.fromStatusId) ||
          first.toStatusId.localeCompare(second.toStatusId),
      ),
    },
    customFields: sortCustomFieldDefinitions(configuration.customFields).map((field, index) => ({
      ...field,
      name: field.name.trim(),
      options: field.options && sortCustomFieldOptions(field.options).map((option, optionIndex) => ({
        ...option,
        name: option.name.trim(),
        sortOrder: optionIndex,
      })),
      sortOrder: index,
    })),
  }
}
