import {
  AUTOMATION_BASELINE_SLIP_MAX_DAYS,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  AUTOMATION_APPROVAL_DECISIONS,
  RECURRING_MAX_BUSINESS_DAY,
  RECURRING_MONTHLY_DAYS,
  WORK_ITEM_RELATION_EVENT_TYPES,
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
  type AutomationApprovalDecision,
  type RecurringMonthlyDay,
  type WorkItemRelationEventType,
} from '@mukuroji/contracts'
import { useId, useMemo, useState, type FormEvent } from 'react'
import { createTranslator, type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { WorkflowConfigurationSection } from '../../work-items/ui/WorkItemConfigurationPanel'
import {
  automationTriggerRequiresConfiguration,
  automationTriggerUsesConfiguration,
  createDefaultAutomationWorkflowTemplatePayload,
  createAutomationScheduleTrigger,
  readAutomationDueDaysBefore,
  createAutomationTrigger,
  createAutomationTemplateEditorInput,
  createAutomationConditions,
  isAutomationActionConfigurationValid,
  isAutomationConditionField,
  isAutomationProjectTemplatePayloadValid,
  isAutomationScheduleConfigurationValid,
  isAutomationTriggerConfigurationValid,
  isAutomationWorkflowTemplatePayloadValid,
  parseAutomationTemplatePayload,
  readAutomationActionTypesForTrigger,
  type AutomationWorkItemTypeTriggerDirection,
  type AutomationTemplatePayloadError,
} from '../model/editorValidation'
import { submitAutomationEditorCreate } from '../model/editorSubmission'
import {
  formatProjectTemplateWorkItemOutline,
  parseProjectTemplateWorkItemOutline,
  type ProjectTemplateWorkItemOutlineErrorReason,
  type ProjectTemplateWorkItemOutlineResult,
} from '../model/projectTemplateWorkItems'
import {
  formatProjectTemplateDependencyLines,
  formatProjectTemplatePlanningOutline,
  parseProjectTemplateDependencyLines,
  parseProjectTemplatePlanningOutline,
  type ProjectTemplateDependencyLinesErrorReason,
  type ProjectTemplateDependencyLinesResult,
  type ProjectTemplatePlanningOutlineErrorReason,
  type ProjectTemplatePlanningOutlineResult,
} from '../model/projectTemplatePlanning'
import {
  createRecurringSchedule,
  currentDateInTimeZone,
  dayOfMonthFromLocalDate,
  isRecurringCadenceConfigurationValid,
  weekdayFromLocalDate,
} from '../model/recurringSchedule'
import {
  applyWorkItemTemplateFormValue,
  createInitialWorkItemTemplateJson,
  readWorkItemTemplateFormValues,
  type WorkItemTemplateFormValues,
} from '../model/workItemTemplateForm'

const automationTriggerTypes = [
  'status',
  'assignee',
  'due',
  'baseline-slip',
  'budget-threshold',
  'custom-field',
  'work-item-type',
  'comment',
  'approval',
  'relation',
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

/** Triggers that use Workspace endpoints and secrets, which Team rules cannot use (ADR 0087). */
const teamExcludedTriggerTypes: ReadonlySet<AutomationTriggerType> = new Set(['form', 'webhook'])

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

/** Monthly day rules a schedule rule can use; business days are only for Recurring Work. */
const ruleMonthlyDays = ['day-of-month', 'last-day'] as const satisfies readonly RecurringMonthlyDay[]

/** Monthly day rule a schedule rule can use. */
type RuleMonthlyDay = (typeof ruleMonthlyDays)[number]

const monthlyDayLabelKeys: Record<RecurringMonthlyDay, MessageKey> = {
  'day-of-month': 'automation.recurring.monthlyDay.dayOfMonth',
  'last-day': 'automation.recurring.monthlyDay.lastDay',
  'business-day': 'automation.recurring.monthlyDay.businessDay',
}

/** Automation rule editor で選択できる trigger type です。 */
type AutomationTriggerType = (typeof automationTriggerTypes)[number]
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
  'baseline-slip': 'automation.trigger.baselineSlip',
  'budget-threshold': 'automation.trigger.budgetThreshold',
  'custom-field': 'automation.trigger.customFieldChange',
  'work-item-type': 'automation.trigger.workItemTypeChange',
  comment: 'automation.trigger.comment',
  approval: 'automation.trigger.approval',
  relation: 'automation.trigger.relationChange',
  form: 'automation.trigger.formSubmission',
  webhook: 'automation.trigger.webhook',
  schedule: 'automation.trigger.schedule',
}

const approvalDecisionLabelKeys: Record<AutomationApprovalDecision, MessageKey> = {
  approved: 'automation.approvalDecision.approved',
  rejected: 'automation.approvalDecision.rejected',
  'changes-requested': 'automation.approvalDecision.changesRequested',
}

const relationEventLabelKeys: Record<WorkItemRelationEventType, MessageKey> = {
  'work-item.parent-changed': 'automation.relationEvent.parentChanged',
  'work-item.child-added': 'automation.relationEvent.childAdded',
  'work-item.child-removed': 'automation.relationEvent.childRemoved',
  'work-item.blocker-added': 'automation.relationEvent.blockerAdded',
  'work-item.blocker-removed': 'automation.relationEvent.blockerRemoved',
  'work-item.blocking-added': 'automation.relationEvent.blockingAdded',
  'work-item.blocking-removed': 'automation.relationEvent.blockingRemoved',
  'work-item.relation-added': 'automation.relationEvent.relationAdded',
  'work-item.relation-removed': 'automation.relationEvent.relationRemoved',
  'work-item.sibling-order-changed': 'automation.relationEvent.siblingOrderChanged',
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

const projectTemplateWorkItemOutlineErrorKeys: Record<ProjectTemplateWorkItemOutlineErrorReason, MessageKey> = {
  format: 'automation.template.project.workItemsError.format',
  indent: 'automation.template.project.workItemsError.indent',
  title: 'automation.template.project.workItemsError.title',
  days: 'automation.template.project.workItemsError.days',
  limit: 'automation.template.project.workItemsError.limit',
  depth: 'automation.template.project.workItemsError.depth',
}

const projectTemplatePlanningOutlineErrorKeys: Record<ProjectTemplatePlanningOutlineErrorReason, MessageKey> = {
  format: 'automation.template.project.planningError.format',
  indent: 'automation.template.project.planningError.indent',
  title: 'automation.template.project.planningError.title',
  days: 'automation.template.project.planningError.days',
  limit: 'automation.template.project.planningError.limit',
}

const projectTemplateDependencyLinesErrorKeys: Record<ProjectTemplateDependencyLinesErrorReason, MessageKey> = {
  format: 'automation.template.project.dependenciesError.format',
  reference: 'automation.template.project.dependenciesError.reference',
  self: 'automation.template.project.dependenciesError.self',
  hierarchy: 'automation.template.project.dependenciesError.hierarchy',
  duplicate: 'automation.template.project.dependenciesError.duplicate',
  limit: 'automation.template.project.dependenciesError.limit',
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
  /**
   * Whether the rule is owned by a Team, which hides the form and webhook triggers and the
   * outbound webhook action that the server rejects for Team rules (ADR 0087).
   */
  teamScoped?: boolean
}

/** Props of the baseline-slip day field. */
type BaselineSlipDaysFieldProps = {
  /** Translator of the editor locale. */
  t: ReturnType<typeof createTranslator>
  /** Day count as typed; blank means 1 day. */
  value: string
  /** Called with the typed value. */
  onChange: (value: string) => void
}

/**
 * Day count field of a baseline-slip trigger that explains an out-of-range value next to it.
 *
 * @param props - Field props.
 * @returns The field.
 */
export function BaselineSlipDaysField({ t, value, onChange }: BaselineSlipDaysFieldProps) {
  const invalid = !isAutomationTriggerConfigurationValid('baseline-slip', value.trim())
  return (
    <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
      {t('automation.rule.baselineSlipDays')}
      <input
        aria-describedby={invalid
          ? 'automation-rule-baseline-slip-days-error automation-rule-baseline-slip-days-hint'
          : 'automation-rule-baseline-slip-days-hint'}
        aria-invalid={invalid ? true : undefined}
        className="workbench-input min-h-10 px-3 tabular-nums text-[var(--workbench-text)]"
        data-testid="automation-rule-trigger-configuration"
        inputMode="numeric"
        maxLength={String(AUTOMATION_BASELINE_SLIP_MAX_DAYS).length}
        pattern="[0-9]*"
        placeholder="1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {invalid ? (
        <span
          className="text-xs font-semibold leading-5 text-[var(--workbench-danger)]"
          id="automation-rule-baseline-slip-days-error"
        >
          {t('automation.rule.baselineSlipDaysInvalid')}
        </span>
      ) : null}
      <span
        className="text-xs font-medium leading-5 text-[var(--workbench-muted)]"
        id="automation-rule-baseline-slip-days-hint"
      >
        {t('automation.rule.baselineSlipDaysHint')}
      </span>
    </label>
  )
}

/** Trigger、condition、action、実行制御を入力する rule editor です。 */
export function AutomationRuleEditor({
  initialSchedule,
  initialTriggerType = 'status',
  isSaving = false,
  locale,
  onCreate,
  teamScoped = false,
  teams = [],
  webhookEndpoints = [],
}: AutomationRuleEditorProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const triggerTypes = teamScoped
    ? automationTriggerTypes.filter((type) => !teamExcludedTriggerTypes.has(type))
    : automationTriggerTypes
  const scopedActionTypes = teamScoped
    ? automationActionTypes.filter((type) => type !== 'webhook')
    : automationActionTypes
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
  const [triggerFromConfiguration, setTriggerFromConfiguration] = useState('')
  const [workItemTypeTriggerDirection, setWorkItemTypeTriggerDirection] = useState<AutomationWorkItemTypeTriggerDirection>('to')
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
  const [scheduleMonthlyDay, setScheduleMonthlyDay] = useState<RuleMonthlyDay>(
    initialSchedule?.monthlyDay === 'last-day' ? 'last-day' : 'day-of-month',
  )
  const [scheduleDueDaysBefore, setScheduleDueDaysBefore] = useState('')
  const [actionType, setActionType] = useState<AutomationActionType>(() => {
    // A trigger without a Work Item, such as a budget threshold, starts on an action it can run.
    const allowed = readAutomationActionTypesForTrigger(scopedActionTypes, initialSchedule ? 'schedule' : initialTriggerType)
    return allowed.includes('move') ? 'move' : allowed.includes('notify') ? 'notify' : allowed[0] ?? 'notify'
  })
  const [actionConfiguration, setActionConfiguration] = useState('')
  const [notifyAssignee, setNotifyAssignee] = useState(false)
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
  const isWorkItemTypeTriggerValid = workItemTypeTriggerDirection === 'from'
    ? Boolean(triggerFromConfiguration.trim())
    : workItemTypeTriggerDirection === 'to'
      ? Boolean(triggerConfiguration.trim())
      : Boolean(triggerFromConfiguration.trim() && triggerConfiguration.trim())
  const isTriggerValid = triggerType === 'webhook'
    ? activeWebhookEndpoints.some((endpoint) => endpoint.id === resolvedTriggerConfiguration)
    : triggerType === 'work-item-type'
      ? Boolean(resolvedTriggerTeamId.trim()) && isWorkItemTypeTriggerValid
      : isAutomationTriggerConfigurationValid(triggerType, resolvedTriggerConfiguration)
  const actionTypes = readAutomationActionTypesForTrigger(scopedActionTypes, triggerType)
  const allowsAssigneeNotification = triggerType !== 'budget-threshold'
  const notifiesAssignee = allowsAssigneeNotification && notifyAssignee
  const notifiesAssigneeOnly = actionType === 'notify' && notifiesAssignee &&
    !actionConfiguration.trim()
  const isActionValid = actionTypes.includes(actionType) && (notifiesAssigneeOnly ||
    isAutomationActionConfigurationValid(actionType, actionConfiguration))
  const dueDaysBefore = readAutomationDueDaysBefore(scheduleDueDaysBefore)
  const isScheduleTimeValid = isAutomationScheduleConfigurationValid(
    scheduleTimeZone,
    scheduleLocalTime,
  )
  const isScheduleCadenceValid = isRecurringCadenceConfigurationValid(
    scheduleFrequency,
    scheduleWeekday,
    scheduleDayOfMonth,
    scheduleMonthlyDay,
  )
  const isScheduleValid = triggerType !== 'schedule' || (
    isScheduleTimeValid && isScheduleCadenceValid && dueDaysBefore !== undefined
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedName = name.trim()

    if (!trimmedName || !isTriggerValid || !isActionValid || !isConditionValid || !isScheduleValid) return

    try {
      await onCreate({
        actions: [createAutomationAction(actionType, actionConfiguration, trimmedName, notifiesAssignee)],
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
              monthlyDay: scheduleMonthlyDay,
              startDate: currentDateInTimeZone(scheduleTimeZone),
              timeZone: scheduleTimeZone,
            }, dueDaysBefore ?? undefined)
          : createAutomationTrigger(
              triggerType,
              resolvedTriggerConfiguration,
              resolvedTriggerTeamId,
              {
                direction: workItemTypeTriggerDirection,
                fromConfiguration: triggerFromConfiguration,
              },
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
          options={triggerTypes.map((value) => ({ label: t(triggerLabelKeys[value]), value }))}
          testId="automation-rule-trigger"
          value={triggerType}
          onChange={(value) => {
            const nextType = readTriggerType(value)
            setTriggerType(nextType)
            setTriggerConfiguration(
              nextType === 'webhook' ? activeWebhookEndpoints[0]?.id ?? '' : '',
            )
            setTriggerFromConfiguration('')
            setWorkItemTypeTriggerDirection('to')
            setTriggerTeamId(nextType === 'work-item-type' ? teams[0]?.id ?? '' : '')
            const nextActionTypes = readAutomationActionTypesForTrigger(scopedActionTypes, nextType)
            if (!nextActionTypes.includes(actionType)) {
              setActionType(nextActionTypes.includes('notify') ? 'notify' : nextActionTypes[0] ?? 'notify')
              setActionConfiguration('')
            }
            if (nextType === 'budget-threshold') setNotifyAssignee(false)
          }}
        />
        <SelectField
          label={t('automation.rule.action')}
          options={actionTypes.map((value) => ({ label: t(actionLabelKeys[value]), value }))}
          testId="automation-rule-action"
          value={actionType}
          onChange={(value) => {
            setActionType(readActionType(value))
            setActionConfiguration('')
            setNotifyAssignee(false)
          }}
        />
      </div>
      <div className={`grid gap-3 max-[760px]:grid-cols-1 ${triggerType === 'schedule' ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {triggerType === 'work-item-type' ? (
          <div className="grid gap-3">
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
                {t('automation.rule.triggerWorkItemTypeDirection')}
                <select
                  className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                  data-testid="automation-rule-trigger-type-direction"
                  value={workItemTypeTriggerDirection}
                  onChange={(event) => setWorkItemTypeTriggerDirection(readWorkItemTypeTriggerDirection(event.target.value))}
                >
                  <option value="from">{t('automation.rule.triggerWorkItemTypeDirection.from')}</option>
                  <option value="to">{t('automation.rule.triggerWorkItemTypeDirection.to')}</option>
                  <option value="both">{t('automation.rule.triggerWorkItemTypeDirection.both')}</option>
                </select>
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
              {workItemTypeTriggerDirection !== 'to' ? (
                <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                  {t('automation.rule.triggerWorkItemTypeFrom')}
                  <input
                    className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                    data-testid="automation-rule-trigger-from-work-item-type"
                    required
                    value={triggerFromConfiguration}
                    onChange={(event) => setTriggerFromConfiguration(event.target.value)}
                  />
                </label>
              ) : null}
              {workItemTypeTriggerDirection !== 'from' ? (
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
              ) : null}
            </div>
          </div>
        ) : triggerType === 'relation' ? (
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.rule.relationEvent')}
            <select
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-rule-relation-event"
              value={triggerConfiguration}
              onChange={(event) => setTriggerConfiguration(event.target.value)}
            >
              <option value="">{t('automation.rule.relationEventAny')}</option>
              {WORK_ITEM_RELATION_EVENT_TYPES.map((eventType) => (
                <option key={eventType} value={eventType}>
                  {t(relationEventLabelKeys[eventType])}
                </option>
              ))}
            </select>
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('automation.rule.relationEventHint')}
            </span>
          </label>
        ) : triggerType === 'approval' ? (
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.rule.approvalDecision')}
            <select
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-rule-approval-decision"
              value={triggerConfiguration}
              onChange={(event) => setTriggerConfiguration(event.target.value)}
            >
              <option value="">{t('automation.rule.approvalDecisionAny')}</option>
              {AUTOMATION_APPROVAL_DECISIONS.map((decision) => (
                <option key={decision} value={decision}>
                  {t(approvalDecisionLabelKeys[decision])}
                </option>
              ))}
            </select>
            <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
              {t('automation.rule.approvalDecisionHint')}
            </span>
          </label>
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
        ) : triggerType === 'baseline-slip' ? (
          <BaselineSlipDaysField
            t={t}
            value={triggerConfiguration}
            onChange={setTriggerConfiguration}
          />
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
            required={!(actionType === 'notify' && notifiesAssignee)}
            type={actionType === 'webhook' ? 'url' : 'text'}
            value={actionConfiguration}
            onChange={(event) => setActionConfiguration(event.target.value)}
          />
        </label>
        {actionType === 'notify' && allowsAssigneeNotification ? (
          <label className="flex items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            <input
              checked={notifyAssignee}
              data-testid="automation-rule-notify-assignee"
              type="checkbox"
              onChange={(event) => setNotifyAssignee(event.target.checked)}
            />
            {t('automation.rule.notifyAssignee')}
          </label>
        ) : null}
      </div>
      {triggerType === 'schedule' ? (
        <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-3">
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
              <SelectField
                label={t('automation.recurring.monthlyDay')}
                options={ruleMonthlyDays.map((value) => ({ label: t(monthlyDayLabelKeys[value]), value }))}
                testId="automation-rule-schedule-monthly-day"
                value={scheduleMonthlyDay}
                onChange={(value) => setScheduleMonthlyDay(readRuleMonthlyDay(value))}
              />
            ) : null}
            {scheduleFrequency === 'monthly' && scheduleMonthlyDay !== 'last-day' ? (
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
            <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
              {t('automation.rule.dueDaysBefore')}
              <input
                aria-invalid={dueDaysBefore === undefined}
                className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
                data-testid="automation-rule-schedule-due-days-before"
                inputMode="numeric"
                placeholder={t('automation.rule.dueDaysBeforePlaceholder')}
                value={scheduleDueDaysBefore}
                onChange={(event) => setScheduleDueDaysBefore(event.target.value)}
              />
              <span className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
                {t('automation.rule.dueDaysBeforeHint')}
              </span>
            </label>
          </div>
          {!isScheduleTimeValid ? (
            <p className="text-xs font-semibold text-fg-red-700" data-testid="automation-rule-schedule-error" role="alert">
              {t('automation.rule.scheduleInvalid')}
            </p>
          ) : null}
          {!isScheduleCadenceValid ? (
            <p className="text-xs font-semibold text-fg-red-700" data-testid="automation-rule-schedule-cadence-error" role="alert">
              {t('automation.recurring.cadenceInvalid')}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-3">
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
  const [payloadJson, setPayloadJson] = useState(createInitialWorkItemTemplateJson)
  const [projectPayload, setProjectPayload] = useState<AutomationProjectTemplatePayload>({
    tone: 'blue',
  })
  const outlines = useProjectTemplateOutlines()
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
      ? isAutomationProjectTemplatePayloadValid(projectPayload) && outlines.isValid
      : isAutomationWorkflowTemplatePayloadValid(workflowPayload)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!name.trim() || !payloadIsValid) return

    await submitAutomationEditorCreate(
      () => {
        if (kind === 'project') {
          const payload = outlines.applyTo(projectPayload)
          if (!payload) return
          return onCreate(createAutomationTemplateEditorInput(name, kind, payload))
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
        setPayloadJson(createInitialWorkItemTemplateJson())
        setProjectPayload({ tone: 'blue' })
        outlines.reset()
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
          outlines={outlines}
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
  const outlines = useProjectTemplateOutlines(template.kind === 'project' ? template.payload : undefined)
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
      ? isAutomationProjectTemplatePayloadValid(projectPayload) && outlines.isValid
      : isAutomationWorkflowTemplatePayloadValid(workflowPayload)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!name.trim() || !payloadIsValid) return
    const payload = template.kind === 'project'
      ? outlines.applyTo(projectPayload)
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
          outlines={outlines}
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
  const formValues = readWorkItemTemplateFormValues(value)
  const textField = (
    field: Exclude<keyof WorkItemTemplateFormValues, 'priority' | 'description'>,
    labelKey: MessageKey,
  ) => (
    <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
      {t(labelKey)}
      <input
        className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
        data-testid={`automation-template-field-${field}`}
        disabled={!formValues}
        required={field === 'title'}
        value={formValues?.[field] ?? ''}
        onChange={(event) => onChange(applyWorkItemTemplateFormValue(value, field, event.target.value))}
      />
    </label>
  )
  return (
    <>
      <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-3">
        <legend className="px-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.template.workItemFields')}
        </legend>
        {textField('title', 'automation.template.field.title')}
        <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.template.field.description')}
          <textarea
            className="workbench-input min-h-20 resize-y px-3 py-2 text-sm text-[var(--workbench-text)]"
            data-testid="automation-template-field-description"
            disabled={!formValues}
            rows={3}
            value={formValues?.description ?? ''}
            onChange={(event) => onChange(applyWorkItemTemplateFormValue(value, 'description', event.target.value))}
          />
        </label>
        <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
          <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('automation.template.field.priority')}
            <select
              className="workbench-input min-h-10 px-3 text-[var(--workbench-text)]"
              data-testid="automation-template-field-priority"
              disabled={!formValues}
              value={formValues?.priority ?? ''}
              onChange={(event) => onChange(applyWorkItemTemplateFormValue(value, 'priority', event.target.value))}
            >
              <option value="">{t('automation.template.field.priorityNone')}</option>
              <option value="high">{t('automation.template.field.priorityHigh')}</option>
              <option value="medium">{t('automation.template.field.priorityMedium')}</option>
              <option value="low">{t('automation.template.field.priorityLow')}</option>
            </select>
          </label>
          {textField('assigneeUserId', 'automation.template.field.assignee')}
          {textField('workItemTypeId', 'automation.template.field.workItemType')}
          {textField('workflowStatusId', 'automation.template.field.workflowStatus')}
          {textField('assignedProjectId', 'automation.template.field.project')}
        </div>
        {!formValues ? (
          <p className="text-xs font-semibold text-fg-red-700" role="alert">
            {t('automation.template.formUnavailable')}
          </p>
        ) : null}
      </fieldset>
      <details>
        <summary className="cursor-pointer text-xs font-semibold text-[var(--workbench-muted)]">
          {t('automation.template.payloadAdvanced')}
        </summary>
        <label className="mt-2 grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
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
      </details>
      <p
        className={`text-xs font-medium leading-5 ${error ? 'text-fg-red-700' : 'text-[var(--workbench-muted)]'}`}
        id={messageId}
        role={error ? 'alert' : undefined}
      >
        {error ?? t('automation.template.payloadHint')}
      </p>
    </>
  )
}

/**
 * Shows the Project template fields, including the WBS outline.
 *
 * @param props - Field values and change callbacks.
 * @returns The Project template fieldset.
 */
function ProjectTemplatePayloadFields({
  locale,
  onChange,
  outlines,
  payload,
}: {
  /** 表示 locale です。 */
  locale: Locale
  /** Project payload 更新 callback です。 */
  onChange: (payload: AutomationProjectTemplatePayload) => void
  /** WBS, Phase / Milestone, and dependency text being edited, with their parsed results. */
  outlines: ProjectTemplateOutlines
  /** 編集中 Project payload です。 */
  payload: AutomationProjectTemplatePayload
}) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const outlineMessageId = useId()
  const planningMessageId = useId()
  const dependencyMessageId = useId()
  const { workItemOutline, workItemOutlineResult, planningOutline, planningOutlineResult } = outlines
  const { dependencyLines, dependencyLinesResult } = outlines
  const tone = payload.tone ?? 'blue'
  return (
    <fieldset className="grid gap-3 rounded-lg border border-[var(--workbench-border)] bg-surface p-4">
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
        <p className="text-xs font-semibold text-fg-red-700" role="alert">
          {t('automation.template.project.nameRequired')}
        </p>
      ) : null}
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.template.project.workItems')}
        <textarea
          aria-describedby={outlineMessageId}
          aria-invalid={'error' in workItemOutlineResult}
          className="workbench-input min-h-32 px-3 py-2 font-mono text-[var(--workbench-text)]"
          data-testid="automation-template-project-work-items"
          placeholder={t('automation.template.project.workItemsPlaceholder')}
          spellCheck={false}
          value={workItemOutline}
          onChange={(event) => outlines.setWorkItemOutline(event.target.value)}
        />
      </label>
      <p
        className={'error' in workItemOutlineResult
          ? 'text-xs font-semibold text-fg-red-700'
          : 'text-xs font-medium leading-5 text-[var(--workbench-muted)]'}
        id={outlineMessageId}
        role={'error' in workItemOutlineResult ? 'alert' : undefined}
      >
        {'error' in workItemOutlineResult
          ? t(projectTemplateWorkItemOutlineErrorKeys[workItemOutlineResult.error])
            .replace('{line}', String(workItemOutlineResult.line))
          : t('automation.template.project.workItemsHint')}
      </p>
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.template.project.planning')}
        <textarea
          aria-describedby={planningMessageId}
          aria-invalid={'error' in planningOutlineResult}
          className="workbench-input min-h-24 px-3 py-2 font-mono text-[var(--workbench-text)]"
          data-testid="automation-template-project-planning"
          placeholder={t('automation.template.project.planningPlaceholder')}
          spellCheck={false}
          value={planningOutline}
          onChange={(event) => outlines.setPlanningOutline(event.target.value)}
        />
      </label>
      <p
        className={'error' in planningOutlineResult
          ? 'text-xs font-semibold text-fg-red-700'
          : 'text-xs font-medium leading-5 text-[var(--workbench-muted)]'}
        id={planningMessageId}
        role={'error' in planningOutlineResult ? 'alert' : undefined}
      >
        {'error' in planningOutlineResult
          ? t(projectTemplatePlanningOutlineErrorKeys[planningOutlineResult.error])
            .replace('{line}', String(planningOutlineResult.line))
          : t('automation.template.project.planningHint')}
      </p>
      <label className="grid gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('automation.template.project.dependencies')}
        <textarea
          aria-describedby={dependencyMessageId}
          aria-invalid={'error' in dependencyLinesResult}
          className="workbench-input min-h-20 px-3 py-2 font-mono text-[var(--workbench-text)]"
          data-testid="automation-template-project-dependencies"
          placeholder={t('automation.template.project.dependenciesPlaceholder')}
          spellCheck={false}
          value={dependencyLines}
          onChange={(event) => outlines.setDependencyLines(event.target.value)}
        />
      </label>
      <p
        className={'error' in dependencyLinesResult
          ? 'text-xs font-semibold text-fg-red-700'
          : 'text-xs font-medium leading-5 text-[var(--workbench-muted)]'}
        id={dependencyMessageId}
        role={'error' in dependencyLinesResult ? 'alert' : undefined}
      >
        {'error' in dependencyLinesResult
          ? t(projectTemplateDependencyLinesErrorKeys[dependencyLinesResult.error])
            .replace('{line}', String(dependencyLinesResult.line))
          : t('automation.template.project.dependenciesHint')}
      </p>
    </fieldset>
  )
}

/** WBS, Phase / Milestone, and dependency text of a Project template editor, with parsed results. */
type ProjectTemplateOutlines = {
  /** WBS outline text. */
  workItemOutline: string
  /** Parsed WBS outline, or its first problem. */
  workItemOutlineResult: ProjectTemplateWorkItemOutlineResult
  /** Replaces the WBS outline text. */
  setWorkItemOutline: (value: string) => void
  /** Phase / Milestone outline text. */
  planningOutline: string
  /** Parsed Phase / Milestone outline, or its first problem. */
  planningOutlineResult: ProjectTemplatePlanningOutlineResult
  /** Replaces the Phase / Milestone outline text. */
  setPlanningOutline: (value: string) => void
  /** Dependency text. */
  dependencyLines: string
  /** Parsed dependencies, or their first problem. */
  dependencyLinesResult: ProjectTemplateDependencyLinesResult
  /** Replaces the dependency text. */
  setDependencyLines: (value: string) => void
  /** Whether every text parses. */
  isValid: boolean
  /** Clears every text. */
  reset: () => void
  /** Returns the payload with the parsed WBS, Planning, and dependencies, or undefined while any text is invalid. */
  applyTo: (payload: AutomationProjectTemplatePayload) => AutomationProjectTemplatePayload | undefined
}

/**
 * Holds the text fields a Project template editor writes its WBS, Phases, Milestones, and
 * dependencies in.
 *
 * @param initialPayload - Saved payload to start from, or undefined for a new template.
 * @returns The text, parsed results, and helpers.
 */
function useProjectTemplateOutlines(initialPayload?: AutomationProjectTemplatePayload): ProjectTemplateOutlines {
  const [workItemOutline, setWorkItemOutline] = useState(() =>
    formatProjectTemplateWorkItemOutline(initialPayload?.workItems)
  )
  const [planningOutline, setPlanningOutline] = useState(() =>
    formatProjectTemplatePlanningOutline(initialPayload?.phases, initialPayload?.milestones)
  )
  const [dependencyLines, setDependencyLines] = useState(() =>
    formatProjectTemplateDependencyLines(initialPayload?.dependencies)
  )
  const workItemOutlineResult = useMemo(
    () => parseProjectTemplateWorkItemOutline(workItemOutline),
    [workItemOutline],
  )
  const planningOutlineResult = useMemo(
    () => parseProjectTemplatePlanningOutline(planningOutline),
    [planningOutline],
  )
  const dependencyLinesResult = useMemo(
    () => parseProjectTemplateDependencyLines(
      dependencyLines,
      'workItems' in workItemOutlineResult ? workItemOutlineResult.workItems : [],
    ),
    [dependencyLines, workItemOutlineResult],
  )
  const isValid = 'workItems' in workItemOutlineResult &&
    'phases' in planningOutlineResult &&
    'dependencies' in dependencyLinesResult
  return {
    workItemOutline,
    workItemOutlineResult,
    setWorkItemOutline,
    planningOutline,
    planningOutlineResult,
    setPlanningOutline,
    dependencyLines,
    dependencyLinesResult,
    setDependencyLines,
    isValid,
    reset() {
      setWorkItemOutline('')
      setPlanningOutline('')
      setDependencyLines('')
    },
    applyTo(payload) {
      if (
        !('workItems' in workItemOutlineResult) ||
        !('phases' in planningOutlineResult) ||
        !('dependencies' in dependencyLinesResult)
      ) {
        return undefined
      }
      const fields = { ...payload }
      delete fields.workItems
      delete fields.phases
      delete fields.milestones
      delete fields.dependencies
      const { workItems } = workItemOutlineResult
      const { phases, milestones } = planningOutlineResult
      const { dependencies } = dependencyLinesResult
      return {
        ...fields,
        ...(workItems.length > 0 ? { workItems } : {}),
        ...(dependencies.length > 0 ? { dependencies } : {}),
        ...(phases.length > 0 ? { phases } : {}),
        ...(milestones.length > 0 ? { milestones } : {}),
      }
    },
  }
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
      value: template.id,
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
  const [monthlyDay, setMonthlyDay] = useState<RecurringMonthlyDay>('day-of-month')
  const isScheduleTimeValid = isAutomationScheduleConfigurationValid(timeZone, localTime)
  const isScheduleCadenceValid = isRecurringCadenceConfigurationValid(
    cadence,
    weekday,
    dayOfMonth,
    monthlyDay,
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
          monthlyDay,
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
          <SelectField
            label={t('automation.recurring.monthlyDay')}
            options={RECURRING_MONTHLY_DAYS.map((value) => ({ label: t(monthlyDayLabelKeys[value]), value }))}
            testId="automation-recurring-monthly-day"
            value={monthlyDay}
            onChange={(value) => setMonthlyDay(readRecurringMonthlyDay(value))}
          />
        ) : null}
        {cadence === 'monthly' && monthlyDay !== 'last-day' ? (
          <NumberField
            isInvalid={!isScheduleCadenceValid}
            label={t(monthlyDay === 'business-day'
              ? 'automation.recurring.businessDay'
              : 'automation.recurring.dayOfMonth')}
            max={monthlyDay === 'business-day' ? RECURRING_MAX_BUSINESS_DAY : 31}
            min={1}
            testId="automation-recurring-day-of-month"
            value={dayOfMonth}
            onChange={setDayOfMonth}
          />
        ) : null}
        {cadence === 'monthly' && monthlyDay === 'business-day' ? (
          <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
            {t('automation.recurring.businessDayHint')}
          </p>
        ) : null}
        <SelectField
          label={t('automation.recurring.catchUp')}
          options={catchUpPolicies.map((value) => ({ label: t(catchUpLabelKeys[value]), value }))}
          value={catchUpPolicy}
          onChange={(value) => setCatchUpPolicy(readCatchUpPolicy(value))}
        />
      </div>
      {!isScheduleTimeValid ? (
        <p className="text-xs font-semibold text-fg-red-700" data-testid="automation-recurring-schedule-error" role="alert">
          {t('automation.recurring.scheduleInvalid')}
        </p>
      ) : null}
      {!isScheduleCadenceValid ? (
        <p className="text-xs font-semibold text-fg-red-700" data-testid="automation-recurring-cadence-error" role="alert">
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

/** Narrows an editor value to a supported Work Item Type trigger direction. */
function readWorkItemTypeTriggerDirection(value: string): AutomationWorkItemTypeTriggerDirection {
  return value === 'from' || value === 'both' ? value : 'to'
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

/**
 * Reads a monthly day rule chosen in the schedule rule editor.
 *
 * @param value - Select value.
 * @returns The rule, `day-of-month` when unknown.
 */
function readRuleMonthlyDay(value: string): RuleMonthlyDay {
  return ruleMonthlyDays.find((candidate) => candidate === value) ?? 'day-of-month'
}

/**
 * Reads a monthly day rule chosen in the Recurring Work editor.
 *
 * @param value - Select value.
 * @returns The rule, `day-of-month` when unknown.
 */
function readRecurringMonthlyDay(value: string): RecurringMonthlyDay {
  return RECURRING_MONTHLY_DAYS.find((candidate) => candidate === value) ?? 'day-of-month'
}

function readRecurringWeekday(value: number): RecurringWeekday {
  return recurringWeekdays.find((candidate) => candidate === value) ?? 1
}

/**
 * Returns a resource name, or the fallback label when the name is blank.
 *
 * @param resource - Named automation resource.
 * @param fallback - Label shown for a blank name.
 * @returns The display name.
 */
function readResourceName(resource: { name: string }, fallback: string) {
  return resource.name.trim() ? resource.name : fallback
}

function createAutomationAction(
  type: AutomationActionType,
  configuration: string,
  ruleName: string,
  notifyAssignee = false,
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
        ...(notifyAssignee ? { notifyAssignee } : {}),
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
