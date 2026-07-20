import type {
  CanonicalWorkItem,
  CustomFieldDefinition,
  CustomFieldValue,
  ResolvedWorkItemConfiguration,
  WorkflowStatusCategory,
  WorkflowStatusDefinition,
  WorkItemConfiguration,
} from '@mukuroji/contracts'
import {
  createTranslator,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import { WorkItemConfigurationApiError } from '../api'
import {
  type CustomFieldValidationCode,
  type CustomFieldValidationError,
  formatCustomFieldValue,
  isCustomFieldApplicable,
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

/**
 * Work Item page helper が利用する翻訳関数です。
 */
type WorkItemTranslator = (key: MessageKey) => string

/**
 * Relation graph revision の取得に必要な Work Item detail の最小構造です。
 */
type WorkItemRelationDetailLike = {
  /**
   * Detail が表す Work Item です。
   */
  issue: Pick<CanonicalWorkItem, 'id'>
  /**
   * Relation mutation の optimistic concurrency に利用する revision です。
   */
  relationGraphRevision?: number
}

/**
 * Work Item の status ID に対応する解決済み definition を返します。
 *
 * @param workItem - Status を表示する Work Item です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @returns 一致する status definition、または未知の status では undefined です。
 */
export function resolveWorkflowStatusDefinition(
  workItem: CanonicalWorkItem,
  configuration: WorkItemConfigurationLike,
) {
  return getWorkItemConfiguration(configuration)?.workflow.statuses.find(
    (status) => status.id === workItem.workflowStatusId,
  )
}

/**
 * Work Item の status label を configuration の literal 名から解決します。
 *
 * @param workItem - Status を表示する Work Item です。
 * @param configuration - Team または Workspace の解決済み configuration です。
 * @returns Configuration 名、status ID の順で解決した表示名です。
 */
export function resolveWorkflowStatusLabel(
  workItem: CanonicalWorkItem,
  configuration: WorkItemConfigurationLike,
) {
  return resolveWorkflowStatusDefinition(workItem, configuration)?.name ?? workItem.workflowStatusId
}

/**
 * Canonical snapshot から標準 category を返します。
 *
 * @param workItem - Category を解決する Work Item です。
 * @returns 横断集計に利用できる status category です。
 */
export function resolveWorkflowStatusCategory(
  workItem: CanonicalWorkItem,
): WorkflowStatusCategory {
  return workItem.statusCategory
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
 * @param configuration - 遷移規則を解決する Work Item configuration です。
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
 * @returns 完了として進捗率へ加算する場合は true です。
 */
export function isCompletedWorkItem(
  workItem: CanonicalWorkItem,
) {
  return resolveWorkflowStatusCategory(workItem) === 'completed'
}

/**
 * Work Item が進行中の open category か判定します。
 *
 * Completed と canceled は closed とし、それ以外を open とします。
 *
 * @param workItem - 判定対象 Work Item です。
 * @returns 未完了で操作対象に残る場合は true です。
 */
export function isOpenWorkItem(
  workItem: CanonicalWorkItem,
) {
  const category = resolveWorkflowStatusCategory(workItem)

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
  workItem: CanonicalWorkItem,
  definition: CustomFieldDefinition,
  options: FormatCustomFieldValueOptions = {},
) {
  return formatCustomFieldValue(
    definition,
    workItem.customFieldValues[definition.id],
    options,
  )
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
  workItem: CanonicalWorkItem,
  definition: CustomFieldDefinition,
  filterValue: CustomFieldValue | undefined,
) {
  return matchesCustomFieldFilter(
    definition,
    workItem.customFieldValues[definition.id],
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

/**
 * Work Item が保持する workflow status ID を返します。
 *
 * @param workItem - Workflow status を解決する Work Item です。
 * @returns Configuration status ID です。
 */
export function resolveWorkItemWorkflowStatusId(
  workItem: CanonicalWorkItem,
) {
  return workItem.workflowStatusId
}

/**
 * Work Item の workflow status label を configuration から解決します。
 *
 * @param workItem - Workflow status を表示する Work Item です。
 * @param configuration - Team または Workspace の configuration です。
 * @returns Configuration 名、status ID の順で解決した表示名です。
 */
export function resolveWorkItemWorkflowStatusLabel(
  workItem: CanonicalWorkItem,
  configuration: WorkItemConfigurationLike,
) {
  return resolveWorkflowStatusLabel(workItem, configuration)
}

/**
 * Configuration status を返します。
 *
 * @param configuration - Team または Workspace の configuration です。
 * @returns Configuration の表示一覧です。
 */
export function resolveDisplayWorkflowStatuses(
  configuration: WorkItemConfigurationLike,
) {
  return resolveCreateWorkflowStatuses(configuration)
}

/**
 * Work Item 作成 form で選択できる workflow status を返します。
 *
 * @param configuration - Team または Workspace の configuration です。
 * @returns 作成時に選択できる表示順付き status definition です。
 */
export function resolveCreateWorkflowStatuses(
  configuration: WorkItemConfigurationLike,
) {
  const resolvedConfiguration = getWorkItemConfiguration(configuration)

  return resolvedConfiguration
    ? sortWorkflowStatuses(resolvedConfiguration.workflow.statuses)
    : []
}

/**
 * Work Item 編集 form で現在 status から選択できる workflow status を返します。
 *
 * @param workItem - 編集対象 Work Item です。
 * @param configuration - Team または Workspace の configuration です。
 * @returns 現在 status と許可 transition 先の status definition です。
 */
export function resolveEditableWorkflowStatuses(
  workItem: CanonicalWorkItem,
  configuration: WorkItemConfigurationLike,
) {
  const resolvedConfiguration = getWorkItemConfiguration(configuration)

  if (!resolvedConfiguration) {
    return []
  }

  return resolveAllowedWorkflowStatuses(workItem.workflowStatusId, resolvedConfiguration)
}

/**
 * Active Workspace member を person custom field の選択候補へ変換します。
 *
 * @param workspaceMembers - Workspace member 一覧です。
 * @returns Active member だけを含む person field option です。
 */
export function resolveWorkItemPersonOptions(
  workspaceMembers: readonly WorkspaceMember[],
) {
  return workspaceMembers
    .filter((member) => member.status === 'active')
    .map((member) => ({
      email: member.email,
      id: member.email,
      name: member.name ?? member.email,
    }))
}

const customFieldValidationMessageKeys: Record<CustomFieldValidationCode, MessageKey> = {
  required: 'workItems.fields.validation.required',
  'invalid-type': 'workItems.fields.validation.invalidType',
  'invalid-option': 'workItems.fields.validation.invalidOption',
  'invalid-date': 'workItems.fields.validation.invalidDate',
  min: 'workItems.fields.validation.min',
  max: 'workItems.fields.validation.max',
  'min-length': 'workItems.fields.validation.minLength',
  'max-length': 'workItems.fields.validation.maxLength',
  pattern: 'workItems.fields.validation.pattern',
}

/**
 * Client custom field validation error を locale 別の field message へまとめます。
 *
 * @param errors - Parser が返した field error 一覧です。
 * @param definitions - 現在 form に表示される field definition です。
 * @param locale - 表示 locale です。
 * @returns Field ID ごとに結合した翻訳済み validation message です。
 */
export function createCustomFieldErrorMessages(
  errors: readonly CustomFieldValidationError[],
  definitions: readonly CustomFieldDefinition[],
  locale: Locale,
) {
  const t = createTranslator(locale)
  const definitionIds = new Set(definitions.map((definition) => definition.id))
  const result: Record<string, string> = {}

  for (const error of errors) {
    if (!definitionIds.has(error.fieldId)) {
      continue
    }

    const message = t(customFieldValidationMessageKeys[error.code])
    result[error.fieldId] = result[error.fieldId]
      ? `${result[error.fieldId]} ${message}`
      : message
  }

  return result
}

/**
 * 編集 form の custom field values を API patch 形式へ変換します。
 *
 * @param definitions - 適用中 custom field definition です。
 * @param existingValues - Work Item に保存済みの値です。
 * @param parsedValues - FormData から検証済みの値です。
 * @param projectId - Field scope を判定する Project ID です。
 * @returns 更新値と明示的な削除 null を含む field patch です。
 */
export function createCustomFieldValuePatch(
  definitions: readonly CustomFieldDefinition[],
  existingValues: Readonly<Record<string, CustomFieldValue>> | undefined,
  parsedValues: Readonly<Record<string, CustomFieldValue>>,
  projectId?: string,
) {
  const patch: Record<string, CustomFieldValue | null> = {}

  for (const definition of definitions) {
    if (definition.type === 'formula' || !isCustomFieldApplicable(definition, projectId)) {
      continue
    }

    if (Object.hasOwn(parsedValues, definition.id)) {
      patch[definition.id] = parsedValues[definition.id]!
    } else if (existingValues?.[definition.id] !== undefined) {
      patch[definition.id] = null
    }
  }

  return patch
}

/**
 * 選択中 Work Item detail から relation graph revision を読み取ります。
 *
 * @param detail - 最新 detail response です。
 * @param workItemId - Mutation 対象 Work Item ID です。
 * @param t - Error message を解決する翻訳関数です。
 * @returns Relation mutation に渡す graph revision です。
 * @throws Detail が未取得または別 Work Item の場合に locale 別 error を投げます。
 */
export function readSelectedRelationGraphRevision(
  detail: WorkItemRelationDetailLike | undefined,
  workItemId: string,
  t: WorkItemTranslator,
) {
  if (detail?.issue.id !== workItemId || detail.relationGraphRevision === undefined) {
    throw new Error(t('workItems.relations.graphNotLoaded'))
  }

  return detail.relationGraphRevision
}

/**
 * Relation graph conflict 時だけ最新 detail を再取得します。
 *
 * @param error - Relation API mutation が返した error です。
 * @param refresh - 最新 detail を取得する callback です。
 */
export async function refreshRelationDetailAfterConflict(
  error: unknown,
  refresh: () => Promise<unknown>,
) {
  if (
    error instanceof WorkItemConfigurationApiError &&
    error.code === 'WorkItemRelationGraphConflict'
  ) {
    await refresh()
  }
}

/**
 * Work Item 一覧を明示指定された Team へ絞り込みます。
 *
 * @param workItems - Project API が返した Work Item 一覧です。
 * @param teamId - URL で明示された Team ID です。
 * @returns 指定 Team が所有する Work Item です。
 */
export function filterWorkItemsByTeam<T extends Pick<CanonicalWorkItem, 'teamId'>>(
  workItems: readonly T[],
  teamId: string,
) {
  return workItems.filter((workItem) => workItem.teamId === teamId)
}

function getWorkItemConfiguration(configuration: WorkItemConfigurationLike) {
  if (!configuration) {
    return undefined
  }

  return 'configuration' in configuration ? configuration.configuration : configuration
}
