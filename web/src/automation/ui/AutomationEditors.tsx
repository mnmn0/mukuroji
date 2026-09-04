import {
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  type AutomationInboundWebhookEndpoint,
  type AutomationProjectTemplatePayload,
  type AutomationProjectTemplateTone,
  type AutomationAction,
  type AutomationConditionOperator,
  type AutomationTemplate,
  type AutomationTemplateKind,
  type AutomationTrigger,
  type CreateAutomationRuleInput,
  type CreateAutomationTemplateInput,
  type CreateRecurringWorkInput,
  type RecurringSchedule,
  type UpdateAutomationTemplateInput,
  type WorkflowDefinition,
  type WorkItemConfiguration,
} from '@mukuroji/contracts'
import { useId, useMemo, useState, type FormEvent } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { WorkflowConfigurationSection } from '../../work-items/ui/WorkItemConfigurationPanel'
import {
  automationTriggerRequiresConfiguration,
  automationTriggerUsesConfiguration,
  createDefaultAutomationWorkflowTemplatePayload,
  createAutomationScheduleTrigger,
  createAutomationTemplateEditorInput,
  createAutomationConditions,
  isAutomationActionConfigurationValid,
  isAutomationConditionField,
  isAutomationProjectTemplatePayloadValid,
  isAutomationScheduleConfigurationValid,
  isAutomationTriggerConfigurationValid,
  isAutomationWorkflowTemplatePayloadValid,
  parseAutomationTemplatePayload,
  type AutomationTemplatePayloadError,
} from '../model/editorValidation'
import { submitAutomationEditorCreate } from '../model/editorSubmission'
import {
  createRecurringSchedule,
  currentDateInTimeZone,
  dayOfMonthFromLocalDate,
  isRecurringCadenceConfigurationValid,
  weekdayFromLocalDate,
} from '../model/recurringSchedule'

const automationTriggerTypes = [
  'status',
  'assignee',
  'due',
  'custom-field',
  'work-item-type',
  'comment',
  'form',
  'webhook',
  'schedule',
] as const

const automationActionTypes = [
  'assign',
  'move',
  'update',
  'create',
  'comment',
  'notify',
  'approval',
  'webhook',
] as const

const conditionOperators = [
  'equals',
  'not-equals',
  'contains',
  'greater-than',
  'greater-than-or-equal',
  'less-than',
  'less-than-or-equal',
  'exists',
  'not-exists',
] as const satisfies readonly AutomationConditionOperator[]

const templateKinds = ['work-item', 'project', 'workflow'] as const
const projectTemplateTones = ['blue', 'purple', 'green', 'yellow'] as const
const recurringCadences = ['daily', 'weekly', 'monthly'] as const
const catchUpPolicies = ['skip', 'latest', 'all'] as const
const recurringWeekdays = [0, 1, 2, 3, 4, 5, 6] as const

/** Automation rule editor で選択できる trigger type です。 */
type AutomationTriggerType = (typeof automationTriggerTypes)[number]
/** Schedule 以外の Automation trigger type です。 */
type NonScheduleAutomationTriggerType = Exclude<AutomationTriggerType, 'schedule'>
/** Automation rule editor で選択できる action type です。 */
type AutomationActionType = (typeof automationActionTypes)[number]
/** Automation condition editor で選択できる operator です。 */
type ConditionOperator = (typeof conditionOperators)[number]
/** Automation template editor で選択できる template kind です。 */
type TemplateKind = (typeof templateKinds)[number]
/** Recurring schedule editor で選択できる cadence です。 */
type RecurringCadence = (typeof recurringCadences)[number]
/** Recurring schedule editor で選択できる catch-up policy です。 */
type CatchUpPolicy = (typeof catchUpPolicies)[number]
/** Recurring schedule editor で選択できる曜日です。 */
type RecurringWeekday = (typeof recurringWeekdays)[number]

const triggerLabelKeys: Record<AutomationTriggerType, MessageKey> = {
  status: 'automation.trigger.statusChange',
  assignee: 'automation.trigger.assigneeChange',
  due: 'automation.trigger.dueDate',
  'custom-field': 'automation.trigger.customFieldChange',
  'work-item-type': 'automation.trigger.workItemTypeChange',
  comment: 'automation.trigger.comment',
  form: 'automation.trigger.formSubmission',
  webhook: 'automation.trigger.webhook',
  schedule: 'automation.trigger.schedule',
}

const actionLabelKeys: Record<AutomationActionType, MessageKey> = {
  assign: 'automation.action.assign',
  move: 'automation.action.moveStatus',
  update: 'automation.action.updateFields',
  create: 'automation.action.createWorkItem',
  comment: 'automation.action.addComment',
  notify: 'automation.action.notify',
  approval: 'automation.action.requestApproval',
  webhook: 'automation.action.webhook',
}

const conditionOperatorLabelKeys: Record<ConditionOperator, MessageKey> = {
  equals: 'automation.condition.equals',
  'not-equals': 'automation.condition.notEquals',
  contains: 'automation.condition.contains',
  'greater-than': 'automation.condition.greaterThan',
  'greater-than-or-equal': 'automation.condition.greaterThanOrEqual',
  'less-than': 'automation.condition.lessThan',
  'less-than-or-equal': 'automation.condition.lessThanOrEqual',
  exists: 'automation.condition.isNotEmpty',
  'not-exists': 'automation.condition.isEmpty',
}

const templateKindLabelKeys: Record<TemplateKind, MessageKey> = {
  'work-item': 'automation.template.kind.workItem',
  project: 'automation.template.kind.project',
  workflow: 'automation.template.kind.workflow',
}

const projectTemplateToneLabelKeys: Record<AutomationProjectTemplateTone, MessageKey> = {
  blue: 'automation.template.project.tone.blue',
  purple: 'automation.template.project.tone.purple',
  green: 'automation.template.project.tone.green',
  yellow: 'automation.template.project.tone.yellow',
}

const templatePayloadErrorLabelKeys: Record<AutomationTemplatePayloadError, MessageKey> = {
  'invalid-json': 'automation.template.payloadInvalidJson',
  'object-required': 'automation.template.payloadObjectRequired',
  'invalid-value': 'automation.template.payloadInvalidValue',
}

const cadenceLabelKeys: Record<RecurringCadence, MessageKey> = {
  daily: 'automation.recurring.cadence.daily',
  weekly: 'automation.recurring.cadence.weekly',
  monthly: 'automation.recurring.cadence.monthly',
}

const catchUpLabelKeys: Record<CatchUpPolicy, MessageKey> = {
  skip: 'automation.recurring.catchUp.skip',
  latest: 'automation.recurring.catchUp.latest',
  all: 'automation.recurring.catchUp.all',
}

const weekdayLabelKeys: Record<RecurringWeekday, MessageKey> = {
  0: 'automation.recurring.weekday.sunday',
  1: 'automation.recurring.weekday.monday',
  2: 'automation.recurring.weekday.tuesday',
  3: 'automation.recurring.weekday.wednesday',
  4: 'automation.recurring.weekday.thursday',
  5: 'automation.recurring.weekday.friday',
  6: 'automation.recurring.weekday.saturday',
}

/** Automation rule editor の props です。 */
export type AutomationRuleEditorProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Rule を作成中かどうかです。 */
  isSaving?: boolean
  /** Story または初期表示に使う schedule 値です。 */
  initialSchedule?: RecurringSchedule
  /** Story または初期表示に使う trigger type です。 */
  initialTriggerType?: AutomationTrigger['type']
  /** Webhook trigger で選択できる active endpoint です。 */
  webhookEndpoints?: AutomationInboundWebhookEndpoint[]
  /** Work Item Type trigger で選択できる Team です。 */
  teams?: RecurringTeamOption[]
  /** Rule 作成 callback です。 */
  onCreate: (input: CreateAutomationRuleInput) => Promise<unknown> | unknown
}

/** Trigger、condition、action、実行制御を入力する rule editor です。 */
export function AutomationRuleEditor({
  initialSchedule,
  initialTriggerType = 'status',
  isSaving = false,
  locale,
  onCreate,
  teams = [],
  webhookEndpoints = [],
}: AutomationRuleEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const activeWebhookEndpoints = useMemo(
    () => webhookEndpoints.filter((endpoint) => endpoint.status === 'active'),
    [webhookEndpoints],
  )
  const initialScheduleStartDate = initialSchedule?.startDate ?? currentDateInTimeZone('UTC')
  const [name, setName] = useState('')
  const [triggerType, setTriggerType] = useState<AutomationTriggerType>(
    initialSchedule ? 'schedule' : initialTriggerType,
  )
  const [triggerConfiguration, setTriggerConfiguration] = useState(
    !initialSchedule && initialTriggerType === 'webhook'
      ? activeWebhookEndpoints[0]?.id ?? ''
      : '',
  )
  const [triggerTeamId, setTriggerTeamId] = useState(
    !initialSchedule && initialTriggerType === 'work-item-type'
      ? teams[0]?.id ?? ''
      : '',
  )
  const [scheduleTimeZone, setScheduleTimeZone] = useState(initialSchedule?.timeZone ?? 'UTC')
  const [scheduleLocalTime, setScheduleLocalTime] = useState(initialSchedule?.localTime ?? '09:00')
  const [scheduleFrequency, setScheduleFrequency] = useState<RecurringCadence>(
    initialSchedule?.frequency ?? 'daily',
  )
  const [scheduleCatchUpPolicy, setScheduleCatchUpPolicy] = useState<CatchUpPolicy>(
    initialSchedule?.catchUpPolicy ?? 'latest',
  )
  const [scheduleWeekday, setScheduleWeekday] = useState<RecurringWeekday>(
    readRecurringWeekday(
      initialSchedule?.daysOfWeek?.[0] ?? weekdayFromLocalDate(initialScheduleStartDate),
    ),
  )
  const [scheduleDayOfMonth, setScheduleDayOfMonth] = useState(
    initialSchedule?.dayOfMonth ?? dayOfMonthFromLocalDate(initialScheduleStartDate),
  )
  const [actionType, setActionType] = useState<AutomationActionType>('move')
  const [actionConfiguration, setActionConfiguration] = useState('')
  const [conditionField, setConditionField] = useState('')
  const [conditionOperator, setConditionOperator] = useState<ConditionOperator>('equals')
  const [conditionValue, setConditionValue] = useState('')
  const [maxAttempts, setMaxAttempts] = useState(3)
  const [rateLimit, setRateLimit] = useState(60)
  const trimmedConditionField = conditionField.trim()
  const trimmedConditionValue = conditionValue.trim()
  const hasConditionInput = Boolean(trimmedConditionField || trimmedConditionValue)
  const resolvedTriggerConfiguration = triggerType === 'webhook' &&
    !activeWebhookEndpoints.some((endpoint) => endpoint.id === triggerConfiguration)
    ? activeWebhookEndpoints[0]?.id ?? ''
    : triggerConfiguration
  const resolvedTriggerTeamId = triggerType === 'work-item-type' &&
    teams.length > 0 &&
    !teams.some((team) => team.id === triggerTeamId)
    ? teams[0]?.id ?? ''
    : triggerTeamId
  const isExistenceCondition = conditionOperator === 'exists' || conditionOperator === 'not-exists'
  const isConditionValid = !hasConditionInput || (
    isAutomationConditionField(trimmedConditionField) &&
    (isExistenceCondition || Boolean(trimmedConditionValue))
  )
  const isTriggerValid = triggerType === 'webhook'
    ? activeWebhookEndpoints.some((endpoint) => endpoint.id === resolvedTriggerConfiguration)
    : isAutomationTriggerConfigurationValid(triggerType, resolvedTriggerConfiguration) &&
      (triggerType !== 'work-item-type' || Boolean(resolvedTriggerTeamId.trim()))
  const isActionValid = isAutomationActionConfigurationValid(actionType, actionConfiguration)
  const isScheduleTimeValid = isAutomationScheduleConfigurationValid(
    scheduleTimeZone,
    scheduleLocalTime,
  )
  const isScheduleCadenceValid = isRecurringCadenceConfigurationValid(
    scheduleFrequency,
    scheduleWeekday,
    scheduleDayOfMonth,
  )
  const isScheduleValid = triggerType !== 'schedule' || (
    isScheduleTimeValid && isScheduleCadenceValid
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedName = name.trim()

    if (!trimmedName || !isTriggerValid || !isActionValid || !isConditionValid || !isScheduleValid) return

    try {
      await onCreate({
        actions: [createAutomationAction(actionType, actionConfiguration, trimmedName)],
        conditions: createAutomationConditions(
          trimmedConditionField,
          conditionOperator,
          trimmedConditionValue,
        ),
        enabled: false,
        name: trimmedName,
        rateLimit: {
          maxExecutions: Math.max(1, rateLimit),
          windowSeconds: 60,
        },
        retryPolicy: {
          backoffMultiplier: 2,
          initialDelayMs: 1_000,
          maxAttempts: Math.max(1, maxAttempts),
          maxDelayMs: 60_000,
        },
        trigger: triggerType === 'schedule'
          ? createAutomationScheduleTrigger({
              catchUpPolicy: scheduleCatchUpPolicy,
              dayOfMonth: scheduleDayOfMonth,
              dayOfWeek: scheduleWeekday,
              frequency: scheduleFrequency,
              localTime: scheduleLocalTime,
              startDate: currentDateInTimeZone(scheduleTimeZone),
              timeZone: scheduleTimeZone,
            })
          : createAutomationTrigger(
              triggerType,
              resolvedTriggerConfiguration,
              resolvedTriggerTeamId,
            ),
      })
    } catch {
      return
    }
    setName('')
  }

  return (
    <form className="grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4" onSubmit={(event) => void handleSubmit(event)}>
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('automation.rule.createTitle')}
        </h3>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('automation.rule.createDescription')}
        </p>
      </div>
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.common.name')}
        <input
          className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
          data-testid="automation-rule-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <SelectField
          label={t('automation.rule.trigger')}
          options={automationTriggerTypes.map((value) => ({ label: t(triggerLabelKeys[value]), value }))}
          testId="automation-rule-trigger"
          value={triggerType}
          onChange={(value) => {
            const nextType = readTriggerType(value)
            setTriggerType(nextType)
            setTriggerConfiguration(
              nextType === 'webhook' ? activeWebhookEndpoints[0]?.id ?? '' : '',
            )
            setTriggerTeamId(nextType === 'work-item-type' ? teams[0]?.id ?? '' : '')
          }}
        />
        <SelectField
          label={t('automation.rule.action')}
          options={automationActionTypes.map((value) => ({ label: t(actionLabelKeys[value]), value }))}
          testId="automation-rule-action"
          value={actionType}
          onChange={(value) => {
            setActionType(readActionType(value))
            setActionConfiguration('')
          }}
        />
      </div>
      <div className={`grid gap-3 max-[760px]:grid-cols-1 ${triggerType === 'schedule' ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {triggerType === 'work-item-type' ? (
          <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('automation.rule.triggerTeam')}
              {teams.length > 0 ? (
                <select
                  className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                  data-testid="automation-rule-trigger-team"
                  required
                  value={resolvedTriggerTeamId}
                  onChange={(event) => setTriggerTeamId(event.target.value)}
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name} · {team.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                  data-testid="automation-rule-trigger-team"
                  required
                  value={resolvedTriggerTeamId}
                  onChange={(event) => setTriggerTeamId(event.target.value)}
                />
              )}
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('automation.rule.triggerWorkItemType')}
              <input
                className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                data-testid="automation-rule-trigger-configuration"
                required
                value={triggerConfiguration}
                onChange={(event) => setTriggerConfiguration(event.target.value)}
              />
            </label>
          </div>
        ) : triggerType === 'webhook' ? (
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.rule.webhookEndpoint')}
            <select
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-rule-webhook-endpoint"
              disabled={activeWebhookEndpoints.length === 0}
              required
              value={resolvedTriggerConfiguration}
              onChange={(event) => setTriggerConfiguration(event.target.value)}
            >
              {activeWebhookEndpoints.length === 0 ? (
                <option value="">{t('automation.rule.webhookEndpointEmpty')}</option>
              ) : activeWebhookEndpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.name} · {endpoint.id}
                </option>
              ))}
            </select>
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {activeWebhookEndpoints.length === 0
                ? t('automation.rule.webhookEndpointEmpty')
                : t('automation.rule.webhookEndpointHint')}
            </span>
          </label>
        ) : triggerType !== 'schedule' ? (
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.rule.triggerConfiguration')}
            <input
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-rule-trigger-configuration"
              disabled={!automationTriggerUsesConfiguration(triggerType)}
              required={automationTriggerRequiresConfiguration(triggerType)}
              value={triggerConfiguration}
              onChange={(event) => setTriggerConfiguration(event.target.value)}
            />
          </label>
        ) : null}
        <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.rule.actionConfiguration')}
          <input
            className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
            data-testid="automation-rule-action-configuration"
            required
            type={actionType === 'webhook' ? 'url' : 'text'}
            value={actionConfiguration}
            onChange={(event) => setActionConfiguration(event.target.value)}
          />
        </label>
      </div>
      {triggerType === 'schedule' ? (
        <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-white p-3">
          <legend className="px-1 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.rule.scheduleConfiguration')}
          </legend>
          <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('automation.recurring.timeZone')}
              <input
                aria-invalid={!isScheduleTimeValid}
                className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                data-testid="automation-rule-schedule-time-zone"
                required
                value={scheduleTimeZone}
                onChange={(event) => setScheduleTimeZone(event.target.value)}
              />
            </label>
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('automation.recurring.localTime')}
              <input
                aria-invalid={!isScheduleTimeValid}
                className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                data-testid="automation-rule-schedule-local-time"
                required
                type="time"
                value={scheduleLocalTime}
                onChange={(event) => setScheduleLocalTime(event.target.value)}
              />
            </label>
            <SelectField
              label={t('automation.recurring.cadence')}
              options={recurringCadences.map((value) => ({ label: t(cadenceLabelKeys[value]), value }))}
              testId="automation-rule-schedule-frequency"
              value={scheduleFrequency}
              onChange={(value) => setScheduleFrequency(readRecurringCadence(value))}
            />
            {scheduleFrequency === 'weekly' ? (
              <SelectField
                label={t('automation.recurring.weekday')}
                options={recurringWeekdays.map((value) => ({
                  label: t(weekdayLabelKeys[value]),
                  value: String(value),
                }))}
                testId="automation-rule-schedule-weekday"
                value={String(scheduleWeekday)}
                onChange={(value) => setScheduleWeekday(readRecurringWeekday(Number(value)))}
              />
            ) : null}
            {scheduleFrequency === 'monthly' ? (
              <NumberField
                isInvalid={!isScheduleCadenceValid}
                label={t('automation.recurring.dayOfMonth')}
                max={31}
                min={1}
                testId="automation-rule-schedule-day-of-month"
                value={scheduleDayOfMonth}
                onChange={setScheduleDayOfMonth}
              />
            ) : null}
            <SelectField
              label={t('automation.recurring.catchUp')}
              options={catchUpPolicies.map((value) => ({ label: t(catchUpLabelKeys[value]), value }))}
              testId="automation-rule-schedule-catch-up"
              value={scheduleCatchUpPolicy}
              onChange={(value) => setScheduleCatchUpPolicy(readCatchUpPolicy(value))}
            />
          </div>
          {!isScheduleTimeValid ? (
            <p className="text-xs font-semibold text-red-700" data-testid="automation-rule-schedule-error" role="alert">
              {t('automation.rule.scheduleInvalid')}
            </p>
          ) : null}
          {!isScheduleCadenceValid ? (
            <p className="text-xs font-semibold text-red-700" data-testid="automation-rule-schedule-cadence-error" role="alert">
              {t('automation.recurring.cadenceInvalid')}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-white p-3">
        <legend className="px-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.rule.condition')}
        </legend>
        <div className="grid grid-cols-3 gap-3 max-[860px]:grid-cols-1">
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.rule.conditionField')}
            <input
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-rule-condition-field"
              value={conditionField}
              onChange={(event) => setConditionField(event.target.value)}
            />
          </label>
          <SelectField
            label={t('automation.rule.conditionOperator')}
            options={conditionOperators.map((value) => ({ label: t(conditionOperatorLabelKeys[value]), value }))}
            value={conditionOperator}
            onChange={(value) => setConditionOperator(readConditionOperator(value))}
          />
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.rule.conditionValue')}
            <input
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-rule-condition-value"
              disabled={isExistenceCondition}
              value={conditionValue}
              onChange={(event) => setConditionValue(event.target.value)}
            />
          </label>
        </div>
      </fieldset>
      <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <NumberField
          label={t('automation.rule.retryAttempts')}
          min={1}
          value={maxAttempts}
          onChange={setMaxAttempts}
        />
        <NumberField
          label={t('automation.rule.rateLimit')}
          min={1}
          value={rateLimit}
          onChange={setRateLimit}
        />
      </div>
      <div className="flex justify-end">
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-rule-create"
          disabled={
            isSaving || !name.trim() || !isTriggerValid || !isActionValid || !isConditionValid || !isScheduleValid
          }
          type="submit"
        >
          {t(isSaving ? 'automation.common.saving' : 'automation.rule.create')}
        </button>
      </div>
    </form>
  )
}

/** Automation template editor の props です。 */
export type AutomationTemplateEditorProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Story や deep-link 表示で最初に選択する kind です。 */
  initialKind?: AutomationTemplateKind
  /** Template を作成中かどうかです。 */
  isSaving?: boolean
  /** Template 作成 callback です。 */
  onCreate: (input: CreateAutomationTemplateInput) => Promise<unknown> | unknown
}

/** Work Item、Project、workflow template の作成 editor です。 */
export function AutomationTemplateEditor({
  initialKind = 'work-item',
  isSaving = false,
  locale,
  onCreate,
}: AutomationTemplateEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const payloadMessageId = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<TemplateKind>(initialKind)
  const [payloadJson, setPayloadJson] = useState('{}')
  const [projectPayload, setProjectPayload] = useState<AutomationProjectTemplatePayload>({
    tone: 'blue',
  })
  const [workflowPayload, setWorkflowPayload] = useState<WorkflowDefinition>(
    () => createDefaultAutomationWorkflowTemplatePayload(locale),
  )
  const payloadResult = useMemo(
    () => parseAutomationTemplatePayload(payloadJson),
    [payloadJson],
  )
  const payloadError = 'error' in payloadResult
    ? t(templatePayloadErrorLabelKeys[payloadResult.error])
    : undefined
  const payloadIsValid = kind === 'work-item'
    ? !payloadError
    : kind === 'project'
      ? isAutomationProjectTemplatePayloadValid(projectPayload)
      : isAutomationWorkflowTemplatePayloadValid(workflowPayload)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!name.trim() || !payloadIsValid) return

    await submitAutomationEditorCreate(
      () => {
        if (kind === 'project') {
          return onCreate(createAutomationTemplateEditorInput(name, kind, projectPayload))
        }
        if (kind === 'workflow') {
          return onCreate(createAutomationTemplateEditorInput(name, kind, workflowPayload))
        }
        if ('error' in payloadResult) return
        return onCreate(createAutomationTemplateEditorInput(name, kind, payloadResult.payload))
      },
      () => {
        setKind(initialKind)
        setName('')
        setPayloadJson('{}')
        setProjectPayload({ tone: 'blue' })
        setWorkflowPayload(createDefaultAutomationWorkflowTemplatePayload(locale))
      },
    )
  }

  return (
    <form className="grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4" onSubmit={(event) => void handleSubmit(event)}>
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('automation.template.createTitle')}
        </h3>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('automation.template.createDescription')}
        </p>
      </div>
      <div className="grid grid-cols-[minmax(180px,1fr)_minmax(180px,280px)] gap-3 max-[760px]:grid-cols-1">
        <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.common.name')}
          <input
            className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
            data-testid="automation-template-name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <SelectField
          label={t('automation.template.kind')}
          options={templateKinds.map((value) => ({ label: t(templateKindLabelKeys[value]), value }))}
          value={kind}
          onChange={(value) => setKind(readTemplateKind(value))}
        />
      </div>
      {kind === 'work-item' ? (
        <WorkItemTemplatePayloadField
          error={payloadError}
          locale={locale}
          messageId={payloadMessageId}
          value={payloadJson}
          onChange={setPayloadJson}
        />
      ) : kind === 'project' ? (
        <ProjectTemplatePayloadFields
          locale={locale}
          payload={projectPayload}
          onChange={setProjectPayload}
        />
      ) : (
        <WorkflowTemplatePayloadFields
          locale={locale}
          payload={workflowPayload}
          onChange={setWorkflowPayload}
        />
      )}
      <div className="flex justify-end">
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-template-create"
          disabled={isSaving || !name.trim() || !payloadIsValid}
          type="submit"
        >
          {t(isSaving ? 'automation.common.saving' : 'automation.template.create')}
        </button>
      </div>
    </form>
  )
}

/** Automation template 更新 editor の props です。 */
export type AutomationTemplateUpdateEditorProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Kind と現在 payload を固定する更新対象です。 */
  template: AutomationTemplate
  /** 更新処理中かどうかです。 */
  isSaving?: boolean
  /** 更新を破棄する callback です。 */
  onCancel: () => void
  /** Kind を含まない更新 callback です。 */
  onUpdate: (input: UpdateAutomationTemplateInput) => Promise<unknown> | unknown
}

/** Kind を変更せず Project/Workflow payload を typed field で更新します。 */
export function AutomationTemplateUpdateEditor({
  isSaving = false,
  locale,
  onCancel,
  onUpdate,
  template,
}: AutomationTemplateUpdateEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const payloadMessageId = useId()
  const [name, setName] = useState(template.name)
  const [payloadJson, setPayloadJson] = useState(() => JSON.stringify(template.payload, null, 2))
  const [projectPayload, setProjectPayload] = useState<AutomationProjectTemplatePayload>(() =>
    template.kind === 'project' ? structuredClone(template.payload) : { tone: 'blue' }
  )
  const [workflowPayload, setWorkflowPayload] = useState<WorkflowDefinition>(() =>
    template.kind === 'workflow'
      ? structuredClone(template.payload)
      : createDefaultAutomationWorkflowTemplatePayload(locale)
  )
  const payloadResult = useMemo(
    () => parseAutomationTemplatePayload(payloadJson),
    [payloadJson],
  )
  const payloadError = 'error' in payloadResult
    ? t(templatePayloadErrorLabelKeys[payloadResult.error])
    : undefined
  const payloadIsValid = template.kind === 'work-item'
    ? !payloadError
    : template.kind === 'project'
      ? isAutomationProjectTemplatePayloadValid(projectPayload)
      : isAutomationWorkflowTemplatePayloadValid(workflowPayload)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || !payloadIsValid) return
    const payload = template.kind === 'project'
      ? projectPayload
      : template.kind === 'workflow'
        ? workflowPayload
        : 'payload' in payloadResult
          ? payloadResult.payload
          : undefined
    if (!payload) return
    try {
      await onUpdate({
        expectedRevision: template.revision,
        name: name.trim(),
        payload,
      })
    } catch {
      return
    }
  }

  return (
    <form
      className="grid gap-4 rounded-lg border border-[var(--workbench-primary)] bg-[var(--workbench-surface-muted)] p-4"
      data-testid={`automation-template-update-editor-${template.id}`}
      onSubmit={(event) => void handleSubmit(event)}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('automation.template.editTitle')}
          </h3>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t('automation.template.kindImmutable')}
          </p>
        </div>
        <span className="workbench-badge">{t(templateKindLabelKeys[template.kind])}</span>
      </div>
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.common.name')}
        <input
          className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
          data-testid="automation-template-update-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {template.kind === 'work-item' ? (
        <WorkItemTemplatePayloadField
          error={payloadError}
          locale={locale}
          messageId={payloadMessageId}
          value={payloadJson}
          onChange={setPayloadJson}
        />
      ) : template.kind === 'project' ? (
        <ProjectTemplatePayloadFields
          locale={locale}
          payload={projectPayload}
          onChange={setProjectPayload}
        />
      ) : (
        <WorkflowTemplatePayloadFields
          locale={locale}
          payload={workflowPayload}
          onChange={setWorkflowPayload}
        />
      )}
      <div className="flex justify-end gap-2">
        <button className="workbench-button-secondary min-h-10 px-4" type="button" onClick={onCancel}>
          {t('automation.template.cancel')}
        </button>
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-template-update"
          disabled={isSaving || !name.trim() || !payloadIsValid}
          type="submit"
        >
          {t(isSaving ? 'automation.common.saving' : 'automation.template.update')}
        </button>
      </div>
    </form>
  )
}

function WorkItemTemplatePayloadField({
  error,
  locale,
  messageId,
  onChange,
  value,
}: {
  /** JSON 検証 message です。 */
  error?: string
  /** 表示 locale です。 */
  locale: Locale
  /** Textarea と message を接続する ID です。 */
  messageId: string
  /** JSON 文字列の更新 callback です。 */
  onChange: (value: string) => void
  /** 現在の JSON 文字列です。 */
  value: string
}) {
  const t = useMemo(() => createTranslator(locale), [locale])
  return (
    <>
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.template.payload')}
        <textarea
          aria-describedby={messageId}
          aria-invalid={error ? true : undefined}
          className="workbench-input min-h-40 resize-y px-3 py-2 font-mono text-sm text-[var(--workbench-text)]"
          data-testid="automation-template-payload"
          rows={8}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      <p
        className={`text-xs font-medium leading-5 ${error ? 'text-red-700' : 'text-[var(--workbench-muted)]'}`}
        id={messageId}
        role={error ? 'alert' : undefined}
      >
        {error ?? t('automation.template.payloadHint')}
      </p>
    </>
  )
}

function ProjectTemplatePayloadFields({
  locale,
  onChange,
  payload,
}: {
  /** 表示 locale です。 */
  locale: Locale
  /** Project payload 更新 callback です。 */
  onChange: (payload: AutomationProjectTemplatePayload) => void
  /** 編集中 Project payload です。 */
  payload: AutomationProjectTemplatePayload
}) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const tone = payload.tone ?? 'blue'
  return (
    <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-white p-4">
      <legend className="px-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.template.project.fields')}
      </legend>
      <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <TemplateTextField
          label={t('automation.template.project.name')}
          testId="automation-template-project-name"
          value={payload.name ?? ''}
          onChange={(name) => onChange({ ...payload, name })}
        />
        <SelectField
          label={t('automation.template.project.tone')}
          options={projectTemplateTones.map((value) => ({
            label: t(projectTemplateToneLabelKeys[value]),
            value,
          }))}
          testId="automation-template-project-tone"
          value={tone}
          onChange={(value) => onChange({ ...payload, tone: readProjectTemplateTone(value) })}
        />
        <TemplateTextField
          label={t('automation.template.project.nameJa')}
          testId="automation-template-project-name-ja"
          value={payload.nameJa ?? ''}
          onChange={(nameJa) => onChange({ ...payload, nameJa })}
        />
        <TemplateTextField
          label={t('automation.template.project.nameEn')}
          testId="automation-template-project-name-en"
          value={payload.nameEn ?? ''}
          onChange={(nameEn) => onChange({ ...payload, nameEn })}
        />
      </div>
      {!isAutomationProjectTemplatePayloadValid(payload) ? (
        <p className="text-xs font-semibold text-red-700" role="alert">
          {t('automation.template.project.nameRequired')}
        </p>
      ) : null}
    </fieldset>
  )
}

function WorkflowTemplatePayloadFields({
  locale,
  onChange,
  payload,
}: {
  /** 表示 locale です。 */
  locale: Locale
  /** Workflow payload 更新 callback です。 */
  onChange: (payload: WorkflowDefinition) => void
  /** 編集中 Workflow payload です。 */
  payload: WorkflowDefinition
}) {
  const configuration: WorkItemConfiguration = {
    customFields: [],
    revision: 0,
    schemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    scopeId: 'automation-template-editor',
    scopeType: 'workspace',
    workflow: payload,
  }
  return (
    <div data-testid="automation-template-workflow-editor">
      <WorkflowConfigurationSection
        allowMultipleWorkflows={false}
        configuration={configuration}
        locale={locale}
        onChange={(next) => onChange(next.workflow)}
      />
    </div>
  )
}

function TemplateTextField({
  label,
  onChange,
  testId,
  value,
}: {
  /** Field label です。 */
  label: string
  /** 値変更 callback です。 */
  onChange: (value: string) => void
  /** Test selector です。 */
  testId: string
  /** 現在値です。 */
  value: string
}) {
  return (
    <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <input
        className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
        data-testid={testId}
        maxLength={160}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

/** Recurring Work の Team 選択肢です。 */
export type RecurringTeamOption = {
  /** Team ID です。 */
  id: string
  /** Team 表示名です。 */
  name: string
}

/** Recurring Work editor の props です。 */
export type RecurringWorkEditorProps = {
  /** 表示 locale です。 */
  locale: Locale
  /** Template selector に表示する template です。 */
  templates: AutomationTemplate[]
  /** Team selector に表示する Team です。 */
  teams: RecurringTeamOption[]
  /** Recurring Work を作成中かどうかです。 */
  isSaving?: boolean
  /** Recurring Work 作成 callback です。 */
  onCreate: (input: CreateRecurringWorkInput) => Promise<unknown> | unknown
}

/** Time zone、local time、cadence、catch-up policy を入力する recurring editor です。 */
export function RecurringWorkEditor({
  isSaving = false,
  locale,
  onCreate,
  teams,
  templates,
}: RecurringWorkEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const templateOptions = templates
    .filter((template) => template.enabled && template.kind === 'work-item')
    .map((template) => ({
      label: readResourceName(template, t('automation.common.unnamed')),
      value: readResourceId(template),
    }))
    .filter((option) => option.value)
  const [name, setName] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [timeZone, setTimeZone] = useState('Asia/Tokyo')
  const [localTime, setLocalTime] = useState('09:00')
  const [cadence, setCadence] = useState<RecurringCadence>('weekly')
  const [catchUpPolicy, setCatchUpPolicy] = useState<CatchUpPolicy>('latest')
  const initialStartDate = currentDateInTimeZone('Asia/Tokyo')
  const [weekday, setWeekday] = useState<RecurringWeekday>(
    readRecurringWeekday(weekdayFromLocalDate(initialStartDate)),
  )
  const [dayOfMonth, setDayOfMonth] = useState(dayOfMonthFromLocalDate(initialStartDate))
  const isScheduleTimeValid = isAutomationScheduleConfigurationValid(timeZone, localTime)
  const isScheduleCadenceValid = isRecurringCadenceConfigurationValid(
    cadence,
    weekday,
    dayOfMonth,
  )
  const isScheduleValid = isScheduleTimeValid && isScheduleCadenceValid

  const selectedTemplateId = templateOptions.some((option) => option.value === templateId)
    ? templateId
    : templateOptions[0]?.value || ''
  const selectedTeamId = teams.some((team) => team.id === teamId)
    ? teamId
    : teams[0]?.id || ''

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!name.trim() || !selectedTemplateId || !selectedTeamId || !isScheduleValid) return

    const startDate = currentDateInTimeZone(timeZone)

    try {
      await onCreate({
        enabled: false,
        name: name.trim(),
        schedule: createRecurringSchedule({
          catchUpPolicy,
          dayOfMonth,
          dayOfWeek: weekday,
          frequency: cadence,
          localTime,
          startDate,
          timeZone: timeZone.trim(),
        }),
        templateId: selectedTemplateId,
        teamId: selectedTeamId,
      })
    } catch {
      return
    }
    setName('')
  }

  return (
    <form className="grid gap-4 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-4" onSubmit={(event) => void handleSubmit(event)}>
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('automation.recurring.createTitle')}
        </h3>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('automation.recurring.createDescription')}
        </p>
      </div>
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.common.name')}
        <input
          className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
          data-testid="automation-recurring-name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <SelectField
          label={t('automation.recurring.template')}
          options={templateOptions}
          value={selectedTemplateId}
          onChange={setTemplateId}
        />
        <SelectField
          label={t('automation.recurring.team')}
          options={teams.map((team) => ({ label: team.name, value: team.id }))}
          value={selectedTeamId}
          onChange={setTeamId}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.recurring.timeZone')}
          <input
            aria-invalid={!isScheduleTimeValid}
            className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
            placeholder="Asia/Tokyo"
            required
            value={timeZone}
            onChange={(event) => setTimeZone(event.target.value)}
          />
        </label>
        <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.recurring.localTime')}
          <input
            aria-invalid={!isScheduleTimeValid}
            className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
            required
            type="time"
            value={localTime}
            onChange={(event) => setLocalTime(event.target.value)}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
        <SelectField
          label={t('automation.recurring.cadence')}
          options={recurringCadences.map((value) => ({ label: t(cadenceLabelKeys[value]), value }))}
          value={cadence}
          onChange={(value) => setCadence(readRecurringCadence(value))}
        />
        {cadence === 'weekly' ? (
          <SelectField
            label={t('automation.recurring.weekday')}
            options={recurringWeekdays.map((value) => ({
              label: t(weekdayLabelKeys[value]),
              value: String(value),
            }))}
            testId="automation-recurring-weekday"
            value={String(weekday)}
            onChange={(value) => setWeekday(readRecurringWeekday(Number(value)))}
          />
        ) : null}
        {cadence === 'monthly' ? (
          <NumberField
            isInvalid={!isScheduleCadenceValid}
            label={t('automation.recurring.dayOfMonth')}
            max={31}
            min={1}
            testId="automation-recurring-day-of-month"
            value={dayOfMonth}
            onChange={setDayOfMonth}
          />
        ) : null}
        <SelectField
          label={t('automation.recurring.catchUp')}
          options={catchUpPolicies.map((value) => ({ label: t(catchUpLabelKeys[value]), value }))}
          value={catchUpPolicy}
          onChange={(value) => setCatchUpPolicy(readCatchUpPolicy(value))}
        />
      </div>
      {!isScheduleTimeValid ? (
        <p className="text-xs font-semibold text-red-700" data-testid="automation-recurring-schedule-error" role="alert">
          {t('automation.recurring.scheduleInvalid')}
        </p>
      ) : null}
      {!isScheduleCadenceValid ? (
        <p className="text-xs font-semibold text-red-700" data-testid="automation-recurring-cadence-error" role="alert">
          {t('automation.recurring.cadenceInvalid')}
        </p>
      ) : null}
      <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {t('automation.recurring.dstHint')}
      </p>
      <div className="flex justify-end">
        <button
          className="workbench-button-primary min-h-10 px-5 disabled:cursor-not-allowed disabled:opacity-55"
          data-testid="automation-recurring-create"
          disabled={isSaving || !name.trim() || !selectedTemplateId || !selectedTeamId || !isScheduleValid}
          type="submit"
        >
          {t(isSaving ? 'automation.common.saving' : 'automation.recurring.create')}
        </button>
      </div>
    </form>
  )
}

/** Select field へ表示する option です。 */
type SelectOption = {
  /** Option value です。 */
  value: string
  /** Option label です。 */
  label: string
}

/** Select field の props です。 */
type SelectFieldProps = {
  /** Field label です。 */
  label: string
  /** Select option です。 */
  options: SelectOption[]
  /** 現在値です。 */
  value: string
  /** Test selector です。 */
  testId?: string
  /** 値変更 callback です。 */
  onChange: (value: string) => void
}

function SelectField({ label, onChange, options, testId, value }: SelectFieldProps) {
  return (
    <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <select
        className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

/** Number field の props です。 */
type NumberFieldProps = {
  /** Field label です。 */
  label: string
  /** 許容する最小値です。 */
  min: number
  /** 許容する最大値です。 */
  max?: number
  /** Invalid 表示にするかどうかです。 */
  isInvalid?: boolean
  /** 現在値です。 */
  value: number
  /** Test selector です。 */
  testId?: string
  /** 値変更 callback です。 */
  onChange: (value: number) => void
}

function NumberField({ isInvalid, label, max, min, onChange, testId, value }: NumberFieldProps) {
  return (
    <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <input
        aria-invalid={isInvalid || undefined}
        className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
        data-testid={testId}
        max={max}
        min={min}
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}

function readTriggerType(value: string): AutomationTriggerType {
  return automationTriggerTypes.find((candidate) => candidate === value) ?? 'status'
}

function readActionType(value: string): AutomationActionType {
  return automationActionTypes.find((candidate) => candidate === value) ?? 'move'
}

function readConditionOperator(value: string): ConditionOperator {
  return conditionOperators.find((candidate) => candidate === value) ?? 'equals'
}

function readTemplateKind(value: string): TemplateKind {
  return templateKinds.find((candidate) => candidate === value) ?? 'work-item'
}

function readProjectTemplateTone(value: string): AutomationProjectTemplateTone {
  return projectTemplateTones.find((candidate) => candidate === value) ?? 'blue'
}

function readRecurringCadence(value: string): RecurringCadence {
  return recurringCadences.find((candidate) => candidate === value) ?? 'weekly'
}

function readCatchUpPolicy(value: string): CatchUpPolicy {
  return catchUpPolicies.find((candidate) => candidate === value) ?? 'latest'
}

function readRecurringWeekday(value: number): RecurringWeekday {
  return recurringWeekdays.find((candidate) => candidate === value) ?? 1
}

function readResourceId(resource: unknown) {
  const record = toRecord(resource)
  const value = record.id ?? record.templateId

  return typeof value === 'string' ? value : ''
}

function readResourceName(resource: unknown, fallback: string) {
  const value = toRecord(resource).name

  return typeof value === 'string' && value.trim() ? value : fallback
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}

/**
 * Builds a non-schedule trigger from the editor's compact configuration values.
 *
 * @param type - Trigger discriminator selected in the editor.
 * @param configuration - Primary trigger identifier or value.
 * @param teamId - Team identity required by Work Item Type triggers.
 * @returns A normalized Automation trigger.
 */
function createAutomationTrigger(
  type: NonScheduleAutomationTriggerType,
  configuration: string,
  teamId?: string,
): AutomationTrigger {
  const value = configuration.trim()

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
        ...(value ? { toWorkItemTypeId: value } : {}),
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

function createAutomationAction(
  type: AutomationActionType,
  configuration: string,
  ruleName: string,
): AutomationAction {
  const value = configuration.trim()

  switch (type) {
    case 'approval':
      return {
        dueInHours: 24,
        reviewerMemberKeys: splitCommaSeparated(value),
        type,
      }
    case 'assign':
      return { assigneeMemberKey: value, type }
    case 'comment':
      return { body: value, type }
    case 'create':
      return { templateId: value, type }
    case 'move':
      return { targetProjectId: value, type }
    case 'notify':
      return {
        recipientMemberKeys: splitCommaSeparated(value),
        title: ruleName,
        type,
      }
    case 'update':
      return { patch: { title: value }, type }
    case 'webhook':
      return { type, url: value }
  }
}

function splitCommaSeparated(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}
