import {
  WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS,
  WORK_ITEM_SCHEDULE_MAX_HOLIDAYS,
  WORK_ITEM_SCHEDULE_MIN_YEAR,
  type AutomationAction,
  type AutomationConditionOperator,
  type AutomationProjectTemplatePayload,
  type AutomationScheduleTrigger,
  type AutomationTemplateKind,
  type AutomationTemplatePayloadByKind,
  type AutomationTrigger,
  type AutomationValue,
  type AutomationWorkItemTemplatePayload,
  type CreateAutomationRuleInput,
  type CreateAutomationTemplateInputForKind,
  type WorkItemSchedule,
  type WorkItemScheduleCalendarPolicy,
  type WorkItemScheduleWeekday,
  type WorkflowDefinition,
} from '@mukuroji/contracts'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { createRecurringSchedule, type RecurringScheduleInput } from './recurringSchedule'

const automationScheduleWeekdays: readonly WorkItemScheduleWeekday[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
]
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000

/** Trigger type が設定値を必須とするか返します。 */
export function automationTriggerRequiresConfiguration(type: AutomationTrigger['type']) {
  return type === 'custom-field' || type === 'work-item-type' || type === 'form' || type === 'webhook'
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
    parsed = JSON.parse(value)
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
    'priority',
    'schedule',
    'teamId',
    'title',
    'workItemTypeId',
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
    (parsed.teamId !== undefined && typeof parsed.teamId !== 'string') ||
    (parsed.workItemTypeId !== undefined && typeof parsed.workItemTypeId !== 'string') ||
    (parsed.workflowStatusId !== undefined && typeof parsed.workflowStatusId !== 'string')
  ) {
    return { error: 'invalid-value' }
  }
  const schedule = readAutomationWorkItemSchedule(parsed.schedule)
  if (!schedule) return { error: 'invalid-value' }
  const customFieldValues = parsed.customFieldValues === undefined
    ? undefined
    : cloneAutomationValueRecord(parsed.customFieldValues)
  if (parsed.customFieldValues !== undefined && customFieldValues === undefined) {
    return { error: 'invalid-value' }
  }
  return {
    payload: {
      title: parsed.title,
      ...(parsed.assignedProjectId === undefined
        ? {}
        : { assignedProjectId: parsed.assignedProjectId }),
      ...(parsed.assigneeUserId === undefined
        ? {}
        : { assigneeUserId: parsed.assigneeUserId }),
      ...(customFieldValues === undefined ? {} : { customFieldValues }),
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
      ...(parsed.priority === undefined ? {} : { priority: parsed.priority }),
      schedule,
      ...(parsed.teamId === undefined ? {} : { teamId: parsed.teamId }),
      ...(parsed.workItemTypeId === undefined
        ? {}
        : { workItemTypeId: parsed.workItemTypeId }),
      ...(parsed.workflowStatusId === undefined
        ? {}
        : { workflowStatusId: parsed.workflowStatusId }),
    },
  }
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

/** Work Item Type change direction accepted by the Automation rule editor. */
export type AutomationWorkItemTypeTriggerDirection = 'from' | 'to' | 'both'

/** Optional source-side values used when creating an Automation trigger. */
export type AutomationTriggerOptions = {
  /** Work Item Type change direction for a Work Item Type trigger. */
  direction?: AutomationWorkItemTypeTriggerDirection
  /** Source Work Item Type ID for a Work Item Type trigger. */
  fromConfiguration?: string
}

/**
 * Builds a non-schedule trigger from the editor's compact configuration values.
 *
 * @param type - Trigger discriminator selected in the editor.
 * @param configuration - Primary trigger identifier or value.
 * @param teamId - Team identity required by Work Item Type triggers.
 * @param options - Optional source-side Work Item Type trigger values.
 * @returns A normalized Automation trigger.
 */
export function createAutomationTrigger(
  type: Exclude<AutomationTrigger['type'], 'schedule'>,
  configuration: string,
  teamId?: string,
  options: AutomationTriggerOptions = {},
): AutomationTrigger {
  const value = configuration.trim()
  const fromValue = options.fromConfiguration?.trim()

  switch (type) {
    case 'assignee':
      return { type, ...(value ? { assigneeMemberKey: value } : {}) }
    case 'comment':
      return { type, kind: 'any' }
    case 'custom-field':
      return { type, fieldId: value }
    case 'work-item-type':
      return {
        type,
        teamId: teamId?.trim() ?? '',
        ...(options.direction !== 'to' && fromValue ? { fromWorkItemTypeId: fromValue } : {}),
        ...(options.direction !== 'from' && value ? { toWorkItemTypeId: value } : {}),
      }
    case 'due':
      return { type, reason: value === 'changed' || value === 'overdue' ? value : 'due' }
    case 'form':
      return { type, formId: value }
    case 'status':
      return { type, ...(value ? { toStatusId: value } : {}) }
    case 'webhook':
      return { type, webhookId: value }
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

/**
 * Reads a complete canonical Work Item schedule from template-editor JSON.
 *
 * @param value - Untrusted schedule candidate.
 * @returns A detached schedule, or undefined when any mode invariant is invalid.
 */
function readAutomationWorkItemSchedule(value: unknown): WorkItemSchedule | undefined {
  if (!isRecord(value) || typeof value.mode !== 'string') return undefined
  const calendarPolicy = readAutomationScheduleCalendarPolicy(value.calendarPolicy)
  if (!calendarPolicy) return undefined
  const plannedEffortMinutes = value.plannedEffortMinutes
  if (
    plannedEffortMinutes !== undefined &&
    (
      typeof plannedEffortMinutes !== 'number' ||
      !Number.isSafeInteger(plannedEffortMinutes) ||
      plannedEffortMinutes < 0
    )
  ) {
    return undefined
  }
  const plannedEffort = plannedEffortMinutes === undefined
    ? {}
    : { plannedEffortMinutes }

  if (value.mode === 'unscheduled') {
    if (!hasOnlyKeys(value, ['calendarPolicy', 'mode', 'plannedEffortMinutes'])) {
      return undefined
    }
    return { calendarPolicy, mode: value.mode, ...plannedEffort }
  }
  if (value.mode === 'due-date') {
    if (
      !hasOnlyKeys(value, ['calendarPolicy', 'dueDate', 'mode', 'plannedEffortMinutes']) ||
      !isIsoCalendarDate(value.dueDate)
    ) {
      return undefined
    }
    return {
      calendarPolicy,
      dueDate: value.dueDate,
      mode: value.mode,
      ...plannedEffort,
    }
  }
  if (value.mode === 'date-range') {
    if (
      !hasOnlyKeys(value, [
        'calendarPolicy',
        'durationDays',
        'endDate',
        'mode',
        'plannedEffortMinutes',
        'startDate',
      ]) ||
      !isIsoCalendarDate(value.startDate) ||
      !isIsoCalendarDate(value.endDate) ||
      typeof value.durationDays !== 'number' ||
      !Number.isSafeInteger(value.durationDays) ||
      value.durationDays < 1 ||
      value.durationDays > WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS ||
      countAutomationScheduleWorkingDays(
        value.startDate,
        value.endDate,
        calendarPolicy,
      ) !== value.durationDays
    ) {
      return undefined
    }
    return {
      calendarPolicy,
      durationDays: value.durationDays,
      endDate: value.endDate,
      mode: value.mode,
      startDate: value.startDate,
      ...plannedEffort,
    }
  }
  if (value.mode === 'milestone') {
    if (
      !hasOnlyKeys(value, [
        'calendarPolicy',
        'durationDays',
        'endDate',
        'mode',
        'plannedEffortMinutes',
        'startDate',
      ]) ||
      !isIsoCalendarDate(value.startDate) ||
      value.endDate !== value.startDate ||
      value.durationDays !== 0
    ) {
      return undefined
    }
    return {
      calendarPolicy,
      durationDays: 0,
      endDate: value.startDate,
      mode: value.mode,
      startDate: value.startDate,
      ...plannedEffort,
    }
  }
  return undefined
}

/**
 * Reads a canonical calendar policy without silently reordering or deduplicating values.
 *
 * @param value - Untrusted policy candidate.
 * @returns A detached policy, or undefined when it is not canonical.
 */
function readAutomationScheduleCalendarPolicy(
  value: unknown,
): WorkItemScheduleCalendarPolicy | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['holidays', 'timeZone', 'workingWeekdays'])) {
    return undefined
  }
  if (
    typeof value.timeZone !== 'string' ||
    !value.timeZone ||
    value.timeZone.trim() !== value.timeZone ||
    !isCanonicalTimeZone(value.timeZone) ||
    !Array.isArray(value.workingWeekdays) ||
    !Array.isArray(value.holidays)
  ) {
    return undefined
  }
  if (
    value.workingWeekdays.length > automationScheduleWeekdays.length ||
    value.holidays.length > WORK_ITEM_SCHEDULE_MAX_HOLIDAYS
  ) {
    return undefined
  }
  const workingWeekdays: WorkItemScheduleWeekday[] = []
  for (const weekday of value.workingWeekdays) {
    if (!isAutomationScheduleWeekday(weekday)) return undefined
    workingWeekdays.push(weekday)
  }
  const expectedWeekdays = automationScheduleWeekdays
    .filter((weekday) => workingWeekdays.includes(weekday))
  if (
    workingWeekdays.length === 0 ||
    workingWeekdays.length !== expectedWeekdays.length ||
    workingWeekdays.some((weekday, index) => weekday !== expectedWeekdays[index])
  ) {
    return undefined
  }
  const holidays: string[] = []
  for (const holiday of value.holidays) {
    if (!isIsoCalendarDate(holiday)) return undefined
    holidays.push(holiday)
  }
  const expectedHolidays = [...new Set(holidays)].sort()
  if (
    holidays.length !== expectedHolidays.length ||
    holidays.some((holiday, index) => holiday !== expectedHolidays[index])
  ) {
    return undefined
  }
  return {
    holidays: [...holidays],
    timeZone: value.timeZone,
    workingWeekdays: [...workingWeekdays],
  }
}

/**
 * Counts working dates in an inclusive schedule range.
 *
 * @param startDate - Inclusive ISO start date.
 * @param endDate - Inclusive ISO end date.
 * @param policy - Canonical policy used for weekday and holiday exclusions.
 * @returns The working-date count, or undefined for an invalid or excessive range.
 */
function countAutomationScheduleWorkingDays(
  startDate: string,
  endDate: string,
  policy: WorkItemScheduleCalendarPolicy,
): number | undefined {
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  const spanDays = (end - start) / MILLISECONDS_PER_DAY
  if (spanDays < 0 || spanDays >= WORK_ITEM_SCHEDULE_MAX_DATE_SPAN_DAYS) return undefined
  const holidaySet = new Set(policy.holidays)
  const workingWeekdaySet = new Set(policy.workingWeekdays)
  let count = 0
  for (let timestamp = start; timestamp <= end; timestamp += MILLISECONDS_PER_DAY) {
    const date = new Date(timestamp)
    const isoDate = date.toISOString().slice(0, 10)
    if (
      workingWeekdaySet.has(readAutomationScheduleWeekday(date.getUTCDay())) &&
      !holidaySet.has(isoDate)
    ) {
      count += 1
    }
  }
  return count
}

/**
 * Clones a JSON-compatible custom-field record without a type assertion.
 *
 * @param value - Candidate record from parsed template JSON.
 * @returns A detached Automation value record, or undefined when invalid.
 */
function cloneAutomationValueRecord(
  value: unknown,
): Record<string, AutomationValue> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, AutomationValue> = {}
  for (const [key, candidate] of Object.entries(value)) {
    if (!isAutomationValueCompatible(candidate)) return undefined
    result[key] = structuredClone(candidate)
  }
  return result
}

/**
 * Checks whether a record contains only the supplied keys.
 *
 * @param value - Record whose keys are being validated.
 * @param keys - Complete allowlist for the record.
 * @returns Whether every record key belongs to the allowlist.
 */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowedKeys = new Set(keys)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

/**
 * Checks whether a value is a real ISO calendar date.
 *
 * @param value - Untrusted date candidate.
 * @returns Whether the value round-trips through UTC date parsing.
 */
function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number(value.slice(0, 4)) >= WORK_ITEM_SCHEDULE_MIN_YEAR &&
    !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
}

/**
 * Checks whether an IANA timezone is already in its canonical form.
 *
 * @param value - Timezone identifier supplied by the editor.
 * @returns Whether Intl accepts the identifier without canonicalizing it to another value.
 */
function isCanonicalTimeZone(value: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value })
      .resolvedOptions().timeZone === value
  } catch {
    return false
  }
}

/**
 * Narrows an unknown weekday name to the Work Item schedule contract.
 *
 * @param value - Untrusted weekday candidate.
 * @returns Whether the value is one of the seven canonical weekday names.
 */
function isAutomationScheduleWeekday(value: unknown): value is WorkItemScheduleWeekday {
  return value === 'monday' ||
    value === 'tuesday' ||
    value === 'wednesday' ||
    value === 'thursday' ||
    value === 'friday' ||
    value === 'saturday' ||
    value === 'sunday'
}

/**
 * Maps a UTC weekday number to the Work Item schedule contract.
 *
 * @param day - Weekday index returned by `Date#getUTCDay`.
 * @returns The matching canonical weekday name.
 */
function readAutomationScheduleWeekday(day: number): WorkItemScheduleWeekday {
  switch (day) {
    case 0:
      return 'sunday'
    case 1:
      return 'monday'
    case 2:
      return 'tuesday'
    case 3:
      return 'wednesday'
    case 4:
      return 'thursday'
    case 5:
      return 'friday'
    default:
      return 'saturday'
  }
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
