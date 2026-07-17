import type {
  AutomationAction,
  AutomationConditionOperator,
  AutomationProjectTemplatePayload,
  AutomationScheduleTrigger,
  AutomationTemplateKind,
  AutomationTemplatePayloadByKind,
  AutomationTrigger,
  AutomationValue,
  AutomationWorkItemTemplatePayload,
  CreateAutomationRuleInput,
  CreateAutomationTemplateInputForKind,
  WorkflowDefinition,
} from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../i18n'
import { createRecurringSchedule, type RecurringScheduleInput } from './recurringSchedule'

/** Trigger type が設定値を必須とするか返します。 */
export function automationTriggerRequiresConfiguration(type: AutomationTrigger['type']) {
  return type === 'custom-field' || type === 'form' || type === 'webhook'
}

/** Trigger type が汎用設定欄を使用するか返します。 */
export function automationTriggerUsesConfiguration(type: AutomationTrigger['type']) {
  return type !== 'comment' && type !== 'schedule'
}

/** Trigger type ごとの設定値が作成可能か返します。 */
export function isAutomationTriggerConfigurationValid(
  type: AutomationTrigger['type'],
  configuration: string,
) {
  const value = configuration.trim()
  if (automationTriggerRequiresConfiguration(type) && !value) return false
  if (type === 'due' && value && value !== 'changed' && value !== 'due' && value !== 'overdue') return false
  return true
}

/** Action type ごとの設定値が作成可能か返します。 */
export function isAutomationActionConfigurationValid(
  type: AutomationAction['type'],
  configuration: string,
) {
  const value = configuration.trim()
  if (!value) return false
  if ((type === 'approval' || type === 'notify') && splitCommaSeparated(value).length === 0) return false
  if (type !== 'webhook') return true
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** Automation condition で許可する field path か返します。 */
export function isAutomationConditionField(value: string) {
  return value.startsWith('event.') || value.startsWith('workItem.') || value.startsWith('variables.')
}

/** 入力済みの任意 condition だけを API payload へ変換します。 */
export function createAutomationConditions(
  field: string,
  operator: AutomationConditionOperator,
  value: string,
): CreateAutomationRuleInput['conditions'] {
  const normalizedField = field.trim()
  const normalizedValue = value.trim()
  if (!normalizedField && !normalizedValue) return []
  return [{
    field: normalizedField,
    operator,
    type: 'field',
    ...(operator === 'exists' || operator === 'not-exists' ? {} : { value: normalizedValue }),
  }]
}

/** Template payload JSON の検証失敗理由です。 */
export type AutomationTemplatePayloadError =
  | 'invalid-json'
  | 'object-required'
  | 'invalid-value'

/** Template payload textarea を AutomationValue-compatible object として解析します。 */
export function parseAutomationTemplatePayload(value: string):
  | { payload: AutomationWorkItemTemplatePayload }
  | { error: AutomationTemplatePayloadError } {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return { error: 'invalid-json' }
  }

  if (!isRecord(parsed)) return { error: 'object-required' }
  if (!isAutomationValueCompatible(parsed)) return { error: 'invalid-value' }
  const allowedFields = new Set([
    'assignedProjectId',
    'assigneeUserId',
    'customFieldValues',
    'description',
    'dueDate',
    'priority',
    'teamId',
    'title',
    'workflowStatusId',
  ])
  if (Object.keys(parsed).some((key) => !allowedFields.has(key))) {
    return { error: 'invalid-value' }
  }
  if (typeof parsed.title !== 'string' || !parsed.title.trim() || parsed.title.length > 500) {
    return { error: 'invalid-value' }
  }
  if (
    parsed.priority !== undefined &&
    parsed.priority !== 'low' &&
    parsed.priority !== 'medium' &&
    parsed.priority !== 'high'
  ) {
    return { error: 'invalid-value' }
  }
  if (
    parsed.assignedProjectId !== undefined &&
    parsed.assignedProjectId !== null &&
    typeof parsed.assignedProjectId !== 'string'
  ) {
    return { error: 'invalid-value' }
  }
  if (
    (parsed.assigneeUserId !== undefined && typeof parsed.assigneeUserId !== 'string') ||
    (parsed.customFieldValues !== undefined && !isRecord(parsed.customFieldValues)) ||
    (parsed.description !== undefined && typeof parsed.description !== 'string') ||
    (parsed.dueDate !== undefined && typeof parsed.dueDate !== 'string') ||
    (parsed.teamId !== undefined && typeof parsed.teamId !== 'string') ||
    (parsed.workflowStatusId !== undefined && typeof parsed.workflowStatusId !== 'string')
  ) {
    return { error: 'invalid-value' }
  }
  return { payload: parsed as AutomationWorkItemTemplatePayload }
}

/** 検証済み payload を template 作成 API input へ変換します。 */
export function createAutomationTemplateEditorInput(
  name: string,
  kind: 'work-item',
  payload: AutomationTemplatePayloadByKind['work-item'],
): CreateAutomationTemplateInputForKind<'work-item'>
/** 検証済み Project payload を template 作成 API input へ変換します。 */
export function createAutomationTemplateEditorInput(
  name: string,
  kind: 'project',
  payload: AutomationTemplatePayloadByKind['project'],
): CreateAutomationTemplateInputForKind<'project'>
/** 検証済み Workflow payload を template 作成 API input へ変換します。 */
export function createAutomationTemplateEditorInput(
  name: string,
  kind: 'workflow',
  payload: AutomationTemplatePayloadByKind['workflow'],
): CreateAutomationTemplateInputForKind<'workflow'>
export function createAutomationTemplateEditorInput<TKind extends AutomationTemplateKind>(
  name: string,
  kind: TKind,
  payload: AutomationTemplatePayloadByKind[TKind],
): CreateAutomationTemplateInputForKind<TKind> {
  return {
    enabled: true,
    kind,
    name: name.trim(),
    payload: structuredClone(payload),
  }
}

/** Project template の localized name と tone が保存可能か返します。 */
export function isAutomationProjectTemplatePayloadValid(
  payload: AutomationProjectTemplatePayload,
) {
  const names = [payload.name, payload.nameJa, payload.nameEn]
  if (!names.some((name) => typeof name === 'string' && Boolean(name.trim()))) return false
  if (names.some((name) => typeof name === 'string' && name.trim().length > 160)) return false
  return payload.tone === undefined || ['blue', 'purple', 'green', 'yellow'].includes(payload.tone)
}

/** Workflow template の参照、順序、transition が保存可能か返します。 */
export function isAutomationWorkflowTemplatePayloadValid(payload: WorkflowDefinition) {
  if (!isConfigurationId(payload.id) || !isDisplayName(payload.name)) return false
  if (payload.statuses.length < 1 || payload.statuses.length > 32) return false
  const statusIds = payload.statuses.map((status) => status.id)
  const sortOrders = payload.statuses.map((status) => status.sortOrder)
  if (new Set(statusIds).size !== statusIds.length || new Set(sortOrders).size !== sortOrders.length) {
    return false
  }
  if (!statusIds.includes(payload.initialStatusId)) return false
  if (payload.statuses.some((status) =>
    !isConfigurationId(status.id) ||
    !isDisplayName(status.name) ||
    !Number.isSafeInteger(status.sortOrder) ||
    status.sortOrder < 0 ||
    !['backlog', 'unstarted', 'started', 'completed', 'canceled'].includes(status.category)
  )) return false
  if (payload.transitions.length > 1_024) return false
  const transitions = payload.transitions.map((transition) =>
    `${transition.fromStatusId}\0${transition.toStatusId}`
  )
  if (new Set(transitions).size !== transitions.length) return false
  return payload.transitions.every((transition) =>
    transition.fromStatusId !== transition.toStatusId &&
    statusIds.includes(transition.fromStatusId) &&
    statusIds.includes(transition.toStatusId)
  )
}

/** 新しい Workflow template editor に現在 locale の表示名で有効な初期 definition を返します。 */
export function createDefaultAutomationWorkflowTemplatePayload(
  locale: Locale = 'en',
): WorkflowDefinition {
  const t = createTranslator(locale)
  return {
    id: 'workflow-template',
    name: t('workItems.configuration.workflowTitle'),
    initialStatusId: 'backlog',
    statuses: [
      {
        category: 'backlog',
        id: 'backlog',
        name: t('workItems.statusCategory.backlog'),
        sortOrder: 0,
      },
      {
        category: 'started',
        id: 'in-progress',
        name: t('tasks.status.in-progress'),
        sortOrder: 1,
      },
      {
        category: 'completed',
        id: 'done',
        name: t('tasks.status.done'),
        sortOrder: 2,
      },
    ],
    transitions: [
      { fromStatusId: 'backlog', toStatusId: 'in-progress' },
      { fromStatusId: 'in-progress', toStatusId: 'backlog' },
      { fromStatusId: 'in-progress', toStatusId: 'done' },
      { fromStatusId: 'done', toStatusId: 'in-progress' },
    ],
  }
}

/** Schedule trigger の timezone と local time が作成可能か返します。 */
export function isAutomationScheduleConfigurationValid(
  timeZone: string,
  localTime: string,
) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) return false
  const normalizedTimeZone = timeZone.trim()
  if (!normalizedTimeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalizedTimeZone }).format(0)
    return true
  } catch {
    return false
  }
}

/** Schedule editor の値を recurrence を含む trigger payload へ変換します。 */
export function createAutomationScheduleTrigger(
  input: RecurringScheduleInput,
): AutomationScheduleTrigger {
  return {
    type: 'schedule',
    schedule: createRecurringSchedule({
      ...input,
      timeZone: input.timeZone.trim(),
    }),
  }
}

function splitCommaSeparated(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function isConfigurationId(value: string) {
  return /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i.test(value.trim())
}

function isDisplayName(value: string) {
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= 160
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAutomationValueCompatible(value: unknown, depth = 0): value is AutomationValue {
  if (depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    return value.length <= 1_000 && value.every((entry) => isAutomationValueCompatible(entry, depth + 1))
  }
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length <= 1_000 && entries.every(([key, entry]) =>
    key.length > 0 && key.length <= 256 && isAutomationValueCompatible(entry, depth + 1)
  )
}
