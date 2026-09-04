import type { WorkItemConfiguration, WorkItemSchedule } from '@mukuroji/contracts'
import { useState } from 'react'
import type { ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import type { WorkspaceMember } from '../../workspace/api'
import {
  createDefaultCustomFieldValues,
  isCustomFieldApplicable,
  parseCustomFieldFormData,
} from '../../work-items/model/customFields'
import {
  createCustomFieldErrorMessages,
  resolveCreateWorkflowStatuses,
  resolveCreatableWorkItemTypeId,
  resolveWorkItemPersonOptions,
  resolveWorkItemTypeDefinition,
  resolveWorkItemTypeFormFields,
  resolveWorkItemTypes,
  resolveWorkItemTypeWorkflow,
} from '../../work-items/model/workItemDisplay'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import type { CreateWorkItemInput } from '../api/tasks'
import {
  resolveTaskPriority,
  taskPriorities,
  type TaskCreateContext,
} from '../model/taskView'
import {
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
  createDefaultMilestoneTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  countTaskSchedulePolicyWorkingDays,
  resolveTaskScheduleEndDate,
  resolveTaskScheduleStartDate,
} from '../model/taskSchedule'

/** Interaction mode shown by the task creation panel. */
type CreateTaskMode = 'quick' | 'detailed'

/** Props accepted by the inline project task creation panel. */
export type CreateTaskPanelProps = {
  /** Error shown when project assignee candidates could not be loaded. */
  assigneeErrorMessage?: string
  /** Active project members that may be assigned to the new task. */
  assigneeOptions: ProjectMember[]
  /** Work Item configuration used to validate workflow and custom fields. */
  configuration?: WorkItemConfiguration
  /** Context inherited from the view that opened the create panel. */
  context?: TaskCreateContext
  /** Error returned by the create mutation. */
  errorMessage?: string
  /** Initial create mode shown by the panel. */
  initialMode?: CreateTaskMode
  /** Whether assignee candidates are being loaded. */
  isAssigneeOptionsLoading: boolean
  /** Whether a create mutation is currently running. */
  isSubmitting: boolean
  /** Locale used by custom field editors and validation messages. */
  locale: Locale
  /** Closes the creation panel without submitting. */
  onCancel: () => void
  /** Submits a validated project task creation request. */
  onSubmit: (input: CreateWorkItemInput) => Promise<void>
  /** Project used to resolve project-scoped custom fields. */
  projectId: string
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** Workspace members used by person custom fields. */
  workspaceMembers: WorkspaceMember[]
}

/**
 * Renders and validates the inline project task creation form.
 *
 * @param props - Configuration, candidates, mutation state, and callbacks.
 * @returns The inline task creation panel.
 */
export function CreateTaskPanel({
  assigneeErrorMessage,
  assigneeOptions,
  configuration,
  context,
  errorMessage,
  initialMode = context?.source === 'header' ||
      (context?.schedule !== undefined && context.schedule.mode !== 'due-date')
    ? 'detailed'
    : context ? 'quick' : 'detailed',
  isAssigneeOptionsLoading,
  isSubmitting,
  locale,
  onCancel,
  onSubmit,
  projectId,
  t,
  workspaceMembers,
}: CreateTaskPanelProps) {
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const [title, setTitle] = useState('')
  const workItemTypes = resolveWorkItemTypes(configuration)
  const creatableWorkItemTypes = workItemTypes.filter((type) => type.status === 'active')
  const hasLoadedWorkItemConfiguration = configuration !== undefined
  const hasCreatableWorkItemType = hasLoadedWorkItemConfiguration &&
    creatableWorkItemTypes.length > 0
  const contextualWorkItemTypeId = context?.workItemTypeId && creatableWorkItemTypes.some((type) =>
    type.id === context.workItemTypeId,
  )
    ? context.workItemTypeId
    : undefined
  const initialWorkItemTypeId = contextualWorkItemTypeId ??
    creatableWorkItemTypes[0]?.id ??
    'default'
  const [selectedWorkItemTypeId, setSelectedWorkItemTypeId] = useState(initialWorkItemTypeId)
  const effectiveWorkItemTypeId = resolveCreatableWorkItemTypeId(
    workItemTypes,
    selectedWorkItemTypeId,
  )
  const selectedWorkItemType = resolveWorkItemTypeDefinition(configuration, effectiveWorkItemTypeId) ??
    creatableWorkItemTypes[0]
  const customFieldDefinitions = resolveWorkItemTypeFormFields(configuration, effectiveWorkItemTypeId)
  const workflowStatuses = resolveCreateWorkflowStatuses(configuration, effectiveWorkItemTypeId)
  const selectedWorkflow = resolveWorkItemTypeWorkflow(configuration, effectiveWorkItemTypeId)
  const configuredInitialWorkflowStatusId = context?.workflowStatusId ??
    selectedWorkflow?.initialStatusId ?? ''
  const initialWorkflowStatusId = workflowStatuses.some((status) =>
    status.id === configuredInitialWorkflowStatusId,
  )
    ? configuredInitialWorkflowStatusId
    : workflowStatuses[0]?.id ?? ''
  const requestedWorkflowStatus = workflowStatuses.find((status) => status.id === initialWorkflowStatusId)
  const quickCaptureStatusId = requestedWorkflowStatus?.category === 'backlog'
    ? requestedWorkflowStatus.id
    : context?.workflowStatusId
      ? undefined
      : workflowStatuses.find((status) => status.category === 'backlog')?.id
  const quickCaptureAllowed = Boolean(quickCaptureStatusId)
  const [mode, setMode] = useState<CreateTaskMode>(initialMode)
  const effectiveMode: CreateTaskMode = mode === 'quick' && !quickCaptureAllowed
    ? 'detailed'
    : mode
  const initialAssigneeUserId = context?.assigneeUserId ?? ''
  const quickCaptureAssigneeUserId = initialAssigneeUserId || assigneeOptions[0]?.id || ''
  const initialSchedule = context?.schedule ?? createDefaultUnscheduledTaskSchedule()
  const [scheduleMode, setScheduleMode] = useState<WorkItemSchedule['mode']>(initialSchedule.mode)
  const quickCaptureDueDate = resolveTaskScheduleEndDate(initialSchedule) ?? ''
  const initialStartDate = resolveTaskScheduleStartDate(initialSchedule) ?? ''
  const initialEndDate = resolveTaskScheduleEndDate(initialSchedule) ?? ''
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const defaultCustomFieldValues = configuration
    ? createDefaultCustomFieldValues(customFieldDefinitions, projectId)
    : {}
  const hasCustomFields = customFieldDefinitions.some((definition) =>
    isCustomFieldApplicable(definition, projectId),
  )

  return (
    <section className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-[clamp(18px,2.5vw,30px)] py-3">
      <form
        className="workbench-panel grid gap-3 p-4"
        data-testid="create-task-form"
        id="create-task-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!hasLoadedWorkItemConfiguration || !hasCreatableWorkItemType) return

          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const assigneeUserId = effectiveMode === 'quick'
            ? quickCaptureAssigneeUserId
            : String(formData.get('assigneeUserId') ?? initialAssigneeUserId).trim()
          const schedule = effectiveMode === 'quick'
            ? createQuickCaptureSchedule(formData, initialSchedule)
            : createDetailedSchedule(formData, initialSchedule)
          const workflowStatusId = effectiveMode === 'quick'
            ? quickCaptureStatusId ?? initialWorkflowStatusId
            : String(formData.get('workflowStatusId') ?? initialWorkflowStatusId).trim()
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const priority = resolveTaskPriority(formData.get('priority'))

          if (effectiveMode === 'quick' && !assigneeUserId) {
            return
          }

          if (!schedule) {
            setFieldErrors((currentErrors) => ({
              ...currentErrors,
              schedule: t('tasks.schedule.invalid'),
            }))
            event.currentTarget.reportValidity()
            return
          }

          const parsedCustomFields = effectiveMode === 'detailed' && configuration
            ? parseCustomFieldFormData(formData, customFieldDefinitions, {
                applyDefaults: true,
                projectId,
              })
            : { errors: [], values: {} }

          if (effectiveMode === 'detailed' && (!assigneeUserId || !workflowStatus)) {
            event.currentTarget.reportValidity()
            return
          }

          if (effectiveMode === 'detailed' && parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              customFieldDefinitions,
              locale,
            ))
            return
          }

          setFieldErrors({})
          void onSubmit({
            title,
            assigneeUserId,
            schedule,
            workItemTypeId: effectiveWorkItemTypeId,
            ...(workflowStatusId ? { workflowStatusId } : {}),
            customFieldValues: effectiveMode === 'detailed' ? parsedCustomFields.values : {},
            priority,
            ...(effectiveMode === 'quick' ? { quickCapture: true } : {}),
          })
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--workbench-border)] pb-3">
          <div className="flex items-center gap-1 rounded-md border border-[var(--workbench-border)] bg-white p-1">
            {quickCaptureAllowed ? (
              <button
                aria-pressed={effectiveMode === 'quick'}
                className={`rounded px-3 py-1.5 text-sm font-semibold ${effectiveMode === 'quick' ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]' : 'text-[var(--workbench-muted)]'}`}
                onClick={() => setMode('quick')}
                type="button"
              >
                {t('tasks.create.quick')}
              </button>
            ) : null}
            <button
              aria-pressed={effectiveMode === 'detailed'}
              className={`rounded px-3 py-1.5 text-sm font-semibold ${effectiveMode === 'detailed' ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]' : 'text-[var(--workbench-muted)]'}`}
              onClick={() => setMode('detailed')}
              type="button"
            >
              {t('tasks.create.detailed')}
            </button>
          </div>
          {context ? (
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">
              {t('tasks.create.context')}
            </p>
          ) : null}
        </div>
        {configuration ? (
          <label className="grid max-w-[360px] gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.create.workItemType')}
            <select
              className="workbench-input h-10 px-3"
              data-testid="create-task-work-item-type"
              disabled={isSubmitting || !hasCreatableWorkItemType}
              name="workItemTypeId"
              onChange={(event) => setSelectedWorkItemTypeId(event.target.value)}
              value={effectiveWorkItemTypeId}
            >
              {workItemTypes.map((type) => (
                <option disabled={type.status === 'archived'} key={type.id} value={type.id}>
                  {type.name}{type.status === 'archived' ? ` (${t('tasks.create.archived')})` : ''}
                </option>
              ))}
            </select>
            {selectedWorkItemType?.description ? (
              <span className="text-xs font-medium text-[var(--workbench-muted)]">
                {selectedWorkItemType.description}
              </span>
            ) : null}
            {!hasCreatableWorkItemType ? (
              <span className="text-xs font-semibold text-amber-700">
                {t('tasks.create.noActiveWorkItemTypes')}
              </span>
            ) : null}
          </label>
        ) : null}
        {effectiveMode === 'quick' ? (
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.create.title')}
              <input
                autoFocus
                className="workbench-input h-10 px-3"
                name="title"
                placeholder={t('tasks.create.titlePlaceholder')}
                required
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </label>
            <p className="text-sm font-medium text-[var(--workbench-muted)]">
              {t('tasks.create.quickDescription')}
            </p>
            <label className="grid max-w-[220px] gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.column.dueDate')}
              <input
                className="workbench-input h-10 px-3"
                defaultValue={quickCaptureDueDate}
                name="dueDate"
                type="date"
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                className="workbench-button-primary h-10 px-4 disabled:cursor-not-allowed disabled:border-[#b5bdc9] disabled:bg-[#b5bdc9]"
                disabled={isSubmitting || !hasCreatableWorkItemType || isAssigneeOptionsLoading || Boolean(assigneeErrorMessage) || !quickCaptureAssigneeUserId}
                type="submit"
              >
                {isSubmitting ? t('tasks.create.saving') : t('tasks.create.submit')}
              </button>
              <button
                className="workbench-button-secondary h-10 px-4"
                disabled={isSubmitting}
                onClick={onCancel}
                type="button"
              >
                {t('tasks.create.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        {effectiveMode === 'detailed' ? (
          <div className="grid grid-cols-[minmax(220px,1.4fr)_minmax(180px,0.9fr)_150px_150px_auto] gap-3 max-[1180px]:grid-cols-2 max-[720px]:grid-cols-1">
            <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.create.title')}
              <input
                className="workbench-input h-10 px-3"
                name="title"
                placeholder={t('tasks.create.titlePlaceholder')}
                required
                onChange={(event) => setTitle(event.target.value)}
                value={title}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.create.assignee')}
              <select
                className="workbench-input h-10 px-3"
                defaultValue={initialAssigneeUserId}
                disabled={isSubmitting || isAssigneeOptionsLoading || Boolean(assigneeErrorMessage)}
                name="assigneeUserId"
                required
              >
                <option disabled hidden value="">
                  {t('tasks.create.assigneeSelectPlaceholder')}
                </option>
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>
                    {formatProjectMemberOption(member)}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.column.status')}
              <select
                className="workbench-input h-10 px-3"
                key={effectiveWorkItemTypeId}
                defaultValue={initialWorkflowStatusId}
                name="workflowStatusId"
              >
                {workflowStatuses.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.column.priority')}
              <select
                className="workbench-input h-10 px-3"
                defaultValue="medium"
                name="priority"
              >
                {taskPriorities.map((priority) => (
                  <option key={priority} value={priority}>
                    {t(`tasks.priority.${priority}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button
                className="workbench-button-primary h-10 px-4 disabled:cursor-not-allowed disabled:border-[#b5bdc9] disabled:bg-[#b5bdc9]"
                disabled={
                  isSubmitting ||
                  !hasCreatableWorkItemType ||
                  isAssigneeOptionsLoading ||
                  Boolean(assigneeErrorMessage) ||
                  assigneeOptions.length === 0
                }
                type="submit"
              >
                {isSubmitting ? t('tasks.create.saving') : t('tasks.create.submit')}
              </button>
              <button
                className="workbench-button-secondary h-10 px-4"
                disabled={isSubmitting}
                onClick={onCancel}
                type="button"
              >
                {t('tasks.create.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        {effectiveMode === 'detailed' ? (
          <fieldset className="workbench-panel-muted grid gap-3 p-4">
            <legend className="px-1 text-sm font-semibold text-[#505967]">
              {t('tasks.schedule.title')}
            </legend>
            <div className="grid grid-cols-[180px_repeat(3,minmax(150px,1fr))] gap-3 max-[900px]:grid-cols-2 max-[640px]:grid-cols-1">
              <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
                {t('tasks.schedule.mode')}
                <select
                  className="workbench-input h-10 px-3"
                  name="scheduleMode"
                  onChange={(event) => setScheduleMode(readScheduleMode(event.currentTarget.value))}
                  value={scheduleMode}
                >
                  <option value="unscheduled">{t('tasks.schedule.unscheduled')}</option>
                  <option value="due-date">{t('tasks.schedule.dueDate')}</option>
                  <option value="date-range">{t('tasks.schedule.dateRange')}</option>
                  <option value="milestone">{t('tasks.schedule.milestone')}</option>
                </select>
              </label>
              {scheduleMode === 'due-date' ? (
                <ScheduleDateInput
                  defaultValue={initialEndDate}
                  label={t('tasks.schedule.dueDate')}
                  name="scheduleDueDate"
                />
              ) : null}
              {scheduleMode === 'date-range' ? (
                <>
                  <ScheduleDateInput
                    defaultValue={initialStartDate}
                    label={t('tasks.schedule.startDate')}
                    name="scheduleStartDate"
                  />
                  <ScheduleDateInput
                    defaultValue={initialEndDate}
                    label={t('tasks.schedule.endDate')}
                    name="scheduleEndDate"
                  />
                </>
              ) : null}
              {scheduleMode === 'milestone' ? (
                <ScheduleDateInput
                  defaultValue={initialStartDate || initialEndDate}
                  label={t('tasks.schedule.milestoneDate')}
                  name="scheduleMilestoneDate"
                />
              ) : null}
              <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
                {t('tasks.schedule.effortMinutes')}
                <input
                  className="workbench-input h-10 px-3"
                  defaultValue={initialSchedule.plannedEffortMinutes}
                  min="0"
                  name="scheduleEffortMinutes"
                  type="number"
                />
              </label>
            </div>
            {fieldErrors.schedule ? (
              <p className="text-sm font-semibold text-red-700" role="alert">
                {fieldErrors.schedule}
              </p>
            ) : null}
          </fieldset>
        ) : null}
        {effectiveMode === 'detailed' && hasCustomFields ? (
          <div className="workbench-panel-muted p-4">
            <WorkItemFieldsEditor
              definitions={customFieldDefinitions}
              errors={fieldErrors}
              locale={locale}
              personOptions={personOptions}
              projectId={projectId}
              values={defaultCustomFieldValues}
            />
          </div>
        ) : null}
        {errorMessage ? (
          <p className="text-sm font-semibold text-red-700">{errorMessage}</p>
        ) : null}
        {isAssigneeOptionsLoading ? (
          <p className="text-sm font-medium text-[#5f6874]">{t('tasks.create.assigneeLoading')}</p>
        ) : null}
        {assigneeErrorMessage ? (
          <p className="text-sm font-semibold text-red-700">{assigneeErrorMessage}</p>
        ) : null}
        {!isAssigneeOptionsLoading && !assigneeErrorMessage && assigneeOptions.length === 0 ? (
          <p className="text-sm font-medium text-[#5f6874]">{t('tasks.create.assigneeEmpty')}</p>
        ) : null}
      </form>
    </section>
  )
}

/** Props for one schedule date field. */
type ScheduleDateInputProps = {
  /** Initial ISO date, if supplied by a contextual create action. */
  defaultValue: string
  /** Visible and accessible field label. */
  label: string
  /** Form field name read by schedule construction. */
  name: string
}

/**
 * Renders a required date input used by the selected schedule mode.
 *
 * @param props - Date field label, name, and initial value.
 * @returns A labeled native calendar input.
 */
function ScheduleDateInput({ defaultValue, label, name }: ScheduleDateInputProps) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
      {label}
      <input
        className="workbench-input h-10 px-3"
        defaultValue={defaultValue}
        name={name}
        required
        type="date"
      />
    </label>
  )
}

/**
 * Creates the quick-capture due-date or explicit unscheduled state.
 *
 * @param formData - Submitted quick-capture fields.
 * @param initialSchedule - Context schedule whose calendar policy and effort are inherited.
 * @returns A complete schedule, or undefined for a malformed date.
 */
function createQuickCaptureSchedule(
  formData: FormData,
  initialSchedule: WorkItemSchedule,
): WorkItemSchedule | undefined {
  const dueDate = String(formData.get('dueDate') ?? '').trim()
  if (!dueDate) {
    return {
      ...createDefaultUnscheduledTaskSchedule(initialSchedule.plannedEffortMinutes),
      calendarPolicy: cloneCreateScheduleCalendarPolicy(initialSchedule),
    }
  }

  try {
    return {
      ...createDefaultDueDateTaskSchedule(dueDate, initialSchedule.plannedEffortMinutes),
      calendarPolicy: cloneCreateScheduleCalendarPolicy(initialSchedule),
    }
  } catch {
    return undefined
  }
}

/**
 * Creates a canonical schedule draft from the detailed form's explicit mode.
 *
 * @param formData - Submitted detailed form values.
 * @param initialSchedule - Context schedule whose calendar policy is inherited.
 * @returns A complete schedule, or undefined when its dates or effort are invalid.
 */
function createDetailedSchedule(
  formData: FormData,
  initialSchedule: WorkItemSchedule,
): WorkItemSchedule | undefined {
  const mode = readScheduleMode(String(formData.get('scheduleMode') ?? 'unscheduled'))
  const plannedEffortMinutes = readPlannedEffortMinutes(formData.get('scheduleEffortMinutes'))
  if (plannedEffortMinutes === null) {
    return undefined
  }
  const calendarPolicy = cloneCreateScheduleCalendarPolicy(initialSchedule)

  try {
    if (mode === 'unscheduled') {
      return {
        ...createDefaultUnscheduledTaskSchedule(plannedEffortMinutes),
        calendarPolicy,
      }
    }
    if (mode === 'due-date') {
      return {
        ...createDefaultDueDateTaskSchedule(
          String(formData.get('scheduleDueDate') ?? ''),
          plannedEffortMinutes,
        ),
        calendarPolicy,
      }
    }
    if (mode === 'milestone') {
      return {
        ...createDefaultMilestoneTaskSchedule(
          String(formData.get('scheduleMilestoneDate') ?? ''),
          plannedEffortMinutes,
        ),
        calendarPolicy,
      }
    }

    const draft = createDefaultDateRangeTaskSchedule(
      String(formData.get('scheduleStartDate') ?? ''),
      String(formData.get('scheduleEndDate') ?? ''),
      plannedEffortMinutes,
    )
    const durationDays = countTaskSchedulePolicyWorkingDays(
      draft.startDate,
      draft.endDate,
      calendarPolicy,
    )
    return durationDays > 0 ? { ...draft, calendarPolicy, durationDays } : undefined
  } catch {
    return undefined
  }
}

/**
 * Detaches the calendar policy inherited by a contextual task creation.
 *
 * @param schedule - Source schedule supplied by the task view.
 * @returns A calendar policy copy safe to place in a new Work Item payload.
 */
function cloneCreateScheduleCalendarPolicy(schedule: WorkItemSchedule) {
  return {
    holidays: [...schedule.calendarPolicy.holidays],
    timeZone: schedule.calendarPolicy.timeZone,
    workingWeekdays: [...schedule.calendarPolicy.workingWeekdays],
  }
}

/**
 * Narrows a form value to a supported schedule mode.
 *
 * @param value - Candidate select value.
 * @returns The selected mode, or explicit unscheduled state for an unknown value.
 */
function readScheduleMode(value: string): WorkItemSchedule['mode'] {
  if (value === 'due-date' || value === 'date-range' || value === 'milestone') {
    return value
  }
  return 'unscheduled'
}

/**
 * Parses optional nonnegative planned effort from a form value.
 *
 * @param value - Candidate effort field value.
 * @returns An integer minute count, undefined when empty, or null when invalid.
 */
function readPlannedEffortMinutes(value: FormDataEntryValue | null): number | undefined | null {
  const text = String(value ?? '').trim()
  if (!text) {
    return undefined
  }
  const minutes = Number(text)
  return Number.isSafeInteger(minutes) && minutes >= 0 ? minutes : null
}

/**
 * Formats a project member for an assignee select option.
 *
 * @param member - Project member to format.
 * @returns A label containing the display name and email address.
 */
function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}
