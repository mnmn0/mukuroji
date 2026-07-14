import type {
  CustomFieldValue,
  WorkflowStatusCategory,
  WorkItem,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import { isCustomFieldApplicable } from './customFields'
import {
  matchesWorkItemCustomFieldFilter,
  resolveWorkflowStatusCategory,
} from './workItemDisplay'

/**
 * Workflow category と custom field value を組み合わせる一覧 filter です。
 */
export type WorkItemDefinitionFilter = {
  /** 絞り込む標準 workflow category、または全件です。 */
  category: WorkflowStatusCategory | 'all'
  /** 絞り込む custom field definition ID です。 */
  customFieldId: string
  /** Custom field の型に合わせた絞り込み値です。 */
  customFieldValue?: CustomFieldValue
}

/**
 * Filter value が実際の絞り込み条件を持つか判定します。
 *
 * @param value - Custom field filter value です。
 * @returns 空文字列・空配列・undefined 以外の場合は true です。
 */
export function hasWorkItemDefinitionFilterValue(value: CustomFieldValue | undefined) {
  return value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0)
}

/**
 * Work Item が workflow category と型付き custom field filter の両方に一致するか判定します。
 *
 * @param workItem - 絞り込み対象 Work Item です。
 * @param configuration - Team から解決した configuration です。
 * @param filter - UI で選択された filter です。
 * @returns すべての有効条件に一致する場合は true です。
 */
export function matchesWorkItemDefinitionFilter(
  workItem: Pick<
    WorkItem,
    'assignedProjectId' | 'customFieldValues' | 'status' | 'statusCategory' | 'workflowStatusId'
  >,
  configuration: WorkItemConfiguration | undefined,
  filter: WorkItemDefinitionFilter,
) {
  if (
    filter.category !== 'all' &&
    resolveWorkflowStatusCategory(workItem, configuration) !== filter.category
  ) {
    return false
  }

  if (!filter.customFieldId || !hasWorkItemDefinitionFilterValue(filter.customFieldValue)) {
    return true
  }

  const definition = configuration?.customFields.find(
    (candidate) => candidate.id === filter.customFieldId,
  )

  return Boolean(
    definition &&
    isCustomFieldApplicable(definition, workItem.assignedProjectId) &&
    matchesWorkItemCustomFieldFilter(workItem, definition, filter.customFieldValue),
  )
}
