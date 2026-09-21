import type { WorkItemConfiguration, WorkItemSchedule } from '@mukuroji/contracts'
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
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
  /** Normalized Project identity for the authenticated viewer, when available. */
  currentUserProjectKey?: string
  /** Error returned by the create mutation. */
  errorMessage?: string
  /** Initial create mode shown by the panel. */
  initialMode?: CreateTaskMode
  /** Whether assignee candidates are being loaded. */
  isAssigneeOptionsLoading: boolean
  /** Whether a create mutation is currently running. */
  isSubmitting: boolean
  /** Whether the current permission snapshot must prevent submission. */
  isSubmissionDisabled?: boolean
  /** Locale used by custom field editors and validation messages. */
  locale: Locale
  /** Closes the creation panel without submitting. */
  onCancel: () => void
  /** Reports whether user-entered values need an explicit discard decision. */
  onDirtyChange?: (isDirty: boolean) => void
  /** Submits a validated project task creation request. */
  onSubmit: (input: CreateWorkItemInput) => Promise<void>
  /** Project used to resolve project-scoped custom fields. */
  projectId: string
  /** Display name of the destination Project. */
  projectName?: string
  /** Display name of the destination Team. */
  teamName?: string
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
  currentUserProjectKey,
  errorMessage,
  initialMode,
  isAssigneeOptionsLoading,
  isSubmitting,
  isSubmissionDisabled = false,
  locale,
  onCancel,
  onDirtyChange,
  onSubmit,
  projectId,
  projectName,
  teamName,
  t,
  workspaceMembers,
}: CreateTaskPanelProps) {
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const [title, setTitle] = useState('')
  const [isPanelSubmitting, setIsPanelSubmitting] = useState(false)
  const submissionInFlightRef = useRef(false)
  const dirtyRef = useRef(false)
  const detailedOnlyEditsRef = useRef(false)
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
  const hasDetailedScheduleContext = context?.schedule?.mode === 'date-range' ||
    context?.schedule?.mode === 'milestone'
  const defaultInitialMode: CreateTaskMode = hasDetailedScheduleContext ? 'detailed' : 'quick'
  const [mode, setMode] = useState<CreateTaskMode>(initialMode ?? defaultInitialMode)
  const effectiveMode: CreateTaskMode = mode === 'quick' &&
      (!quickCaptureAllowed || hasDetailedScheduleContext)
    ? 'detailed'
    : mode
  const explicitContextAssigneeUserId = context?.assigneeUserId?.trim() ?? ''
  const contextualAssignee = explicitContextAssigneeUserId
    ? assigneeOptions.find((member) => member.id === explicitContextAssigneeUserId)
    : undefined
  const currentUserAssignee = currentUserProjectKey
    ? assigneeOptions.find((member) => member.id.trim().toLowerCase() === currentUserProjectKey)
    : undefined
  const initialAssigneeUserId = explicitContextAssigneeUserId
    ? contextualAssignee?.id ?? ''
    : currentUserAssignee?.id ?? ''
  const hasInvalidContextAssignee = Boolean(
    explicitContextAssigneeUserId && contextualAssignee === undefined,
  )
  const [selectedAssigneeUserId, setSelectedAssigneeUserId] = useState<string | undefined>(undefined)
  const assigneeValue = selectedAssigneeUserId === undefined
    ? initialAssigneeUserId
    : assigneeOptions.some((member) => member.id === selectedAssigneeUserId)
      ? selectedAssigneeUserId
      : ''
  const hasSelectedAssignee = selectedAssigneeUserId !== undefined
  const isSubmitPending = isSubmitting || isPanelSubmitting
  const initialSchedule = context?.schedule ?? createDefaultUnscheduledTaskSchedule()
  const [scheduleMode, setScheduleMode] = useState<WorkItemSchedule['mode']>(initialSchedule.mode)
  const quickCaptureDueDate = resolveTaskScheduleEndDate(initialSchedule) ?? ''
  const initialStartDate = resolveTaskScheduleStartDate(initialSchedule) ?? ''
  const initialEndDate = resolveTaskScheduleEndDate(initialSchedule) ?? ''
  const [quickDueDate, setQuickDueDate] = useState(quickCaptureDueDate)
  const [scheduleDueDate, setScheduleDueDate] = useState(initialEndDate)
  const [scheduleStartDate, setScheduleStartDate] = useState(initialStartDate)
  const [scheduleEndDate, setScheduleEndDate] = useState(initialEndDate)
  const [scheduleMilestoneDate, setScheduleMilestoneDate] = useState(initialStartDate || initialEndDate)
  const [scheduleEffortMinutes, setScheduleEffortMinutes] = useState(
    initialSchedule.plannedEffortMinutes === undefined
      ? ''
      : String(initialSchedule.plannedEffortMinutes),
  )
  const [selectedWorkflowStatusId, setSelectedWorkflowStatusId] = useState(initialWorkflowStatusId)
  const [priority, setPriority] = useState<CreateWorkItemInput['priority']>('medium')
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const defaultCustomFieldValues = configuration
    ? createDefaultCustomFieldValues(customFieldDefinitions, projectId)
    : {}
  const hasCustomFields = customFieldDefinitions.some((definition) =>
    isCustomFieldApplicable(definition, projectId),
  )
  const effectiveWorkflowStatusId = workflowStatuses.some((status) =>
    status.id === selectedWorkflowStatusId,
  )
    ? selectedWorkflowStatusId
    : initialWorkflowStatusId

  /** Marks the local form dirty after the user changes a value. */
  const markDirty = () => {
    if (dirtyRef.current) return
    dirtyRef.current = true
    onDirtyChange?.(true)
  }

  /** Marks edits to fields that cannot be represented safely by quick capture. */
  const markDetailedOnlyEdit = () => {
    markDirty()
    detailedOnlyEditsRef.current = true
  }

  /** Records user edits without parsing uncontrolled custom-field text on every keystroke. */
  const handleFormChange = (event: ChangeEvent<HTMLFormElement>) => {
    const target = event.target
    if (!(target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) {
      return
    }
    const detailedOnlyField = target.name === 'scheduleMode' ||
      target.name === 'scheduleDueDate' ||
      target.name === 'scheduleStartDate' ||
      target.name === 'scheduleEndDate' ||
      target.name === 'scheduleMilestoneDate' ||
      target.name === 'scheduleEffortMinutes' ||
      target.name === 'workflowStatusId' ||
      target.name === 'priority' ||
      target.name.startsWith('custom-field:')
    if (detailedOnlyField) {
      markDetailedOnlyEdit()
      return
    }
    markDirty()
  }

  return (
    <section className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-[clamp(18px,2.5vw,30px)] py-3">
      <form
        className="workbench-panel grid gap-3 p-4"
        data-testid="create-task-form"
        id="create-task-form"
        onChange={handleFormChange}
        onSubmit={(event) => {
          event.preventDefault()
          if (submissionInFlightRef.current || isSubmitPending) return
          if (isSubmissionDisabled) {
            return
          }
          if (!hasLoadedWorkItemConfiguration || !hasCreatableWorkItemType) return

          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? initialAssigneeUserId).trim()
          if (effectiveMode === 'quick' && detailedOnlyEditsRef.current) {
            setFieldErrors({ mode: t('tasks.create.quickDetailsRequireDetailed') })
            return
          }
          const schedule = effectiveMode === 'quick'
            ? createQuickCaptureSchedule(formData, initialSchedule)
            : createDetailedSchedule(formData, initialSchedule)
          const workflowStatusId = effectiveMode === 'quick'
            ? quickCaptureStatusId ?? initialWorkflowStatusId
            : effectiveWorkflowStatusId
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const priority = resolveTaskPriority(formData.get('priority'))

          if (!assigneeUserId || !assigneeOptions.some((member) => member.id === assigneeUserId)) {
            setFieldErrors((currentErrors) => ({
              ...currentErrors,
              assignee: t('tasks.create.assigneeRequired'),
            }))
            event.currentTarget.reportValidity()
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
          submissionInFlightRef.current = true
          setIsPanelSubmitting(true)
          void onSubmit({
            title,
            assigneeUserId,
            schedule,
            workItemTypeId: effectiveWorkItemTypeId,
            ...(workflowStatusId ? { workflowStatusId } : {}),
            customFieldValues: effectiveMode === 'detailed' ? parsedCustomFields.values : {},
            priority,
            ...(effectiveMode === 'quick' ? { quickCapture: true } : {}),
          }).catch((error: unknown) => {
            setFieldErrors({
              submit: error instanceof Error ? error.message : t('tasks.create.error'),
            })
          }).finally(() => {
            submissionInFlightRef.current = false
            setIsPanelSubmitting(false)
          })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
            event.preventDefault()
          }
        }}
      >
        <fieldset className="contents" disabled={isSubmitPending}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--workbench-border)] pb-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-md border border-[var(--workbench-border)] bg-white p-1">
              {quickCaptureAllowed && !hasDetailedScheduleContext ? (
                <button
                  aria-pressed={effectiveMode === 'quick'}
                  className={`min-h-11 rounded px-3 py-1.5 text-sm font-semibold ${effectiveMode === 'quick' ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]' : 'text-[var(--workbench-muted)]'}`}
                  onClick={() => {
                    setMode('quick')
                  }}
                  type="button"
                >
                  {t('tasks.create.quick')}
                </button>
              ) : null}
              <button
                aria-pressed={effectiveMode === 'detailed'}
                className={`min-h-11 rounded px-3 py-1.5 text-sm font-semibold ${effectiveMode === 'detailed' ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]' : 'text-[var(--workbench-muted)]'}`}
                onClick={() => {
                  setMode('detailed')
                  setFieldErrors((currentErrors) => {
                    if (!currentErrors.mode) return currentErrors
                    const nextErrors = { ...currentErrors }
                    delete nextErrors.mode
                    return nextErrors
                  })
                }}
                type="button"
              >
                {t('tasks.create.detailed')}
              </button>
            </div>
            <div className="min-w-0 text-xs font-semibold text-[var(--workbench-muted)]" data-testid="create-task-destination">
              <span>{t('tasks.create.destination')}: </span>
              <span className="break-words text-[var(--workbench-text)]">
                {teamName ? `${teamName} / ` : ''}{projectName ?? projectId}
              </span>
            </div>
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
              disabled={isSubmitPending || isSubmissionDisabled || !hasCreatableWorkItemType}
              name="workItemTypeId"
              onChange={(event) => {
                if (effectiveMode === 'detailed') setMode('detailed')
                markDirty()
                setSelectedWorkItemTypeId(event.target.value)
              }}
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
            <label className="grid max-w-[420px] gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.create.assignee')}
              <select
                aria-describedby={hasInvalidContextAssignee && !hasSelectedAssignee && !isAssigneeOptionsLoading
                  ? 'create-task-assignee-context-error'
                  : fieldErrors.assignee ? 'create-task-assignee-error' : undefined}
                aria-label={t('tasks.create.assignee')}
                className="workbench-input min-h-11 px-3"
                disabled={isSubmitPending || isAssigneeOptionsLoading || Boolean(assigneeErrorMessage)}
                name="assigneeUserId"
                onChange={(event) => {
                  markDirty()
                  setSelectedAssigneeUserId(event.target.value)
                }}
                required
                value={assigneeValue}
              >
                <option disabled hidden value="">
                  {t('tasks.create.assigneeSelectPlaceholder')}
                </option>
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>
                    {formatProjectMemberOption(member, member.id === currentUserAssignee?.id, t)}
                  </option>
                ))}
              </select>
              {hasInvalidContextAssignee && !hasSelectedAssignee && !isAssigneeOptionsLoading ? (
                <span className="text-xs font-semibold text-amber-700" id="create-task-assignee-context-error" role="alert">
                  {t('tasks.create.assigneeContextInvalid')}
                </span>
              ) : null}
              {fieldErrors.assignee ? (
                <span className="text-xs font-semibold text-red-700" id="create-task-assignee-error" role="alert">
                  {fieldErrors.assignee}
                </span>
              ) : null}
            </label>
            <label className="grid max-w-[220px] gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.column.dueDate')}
              <input
                className="workbench-input h-10 px-3"
                onChange={(event) => {
                  const nextDueDate = event.target.value
                  setQuickDueDate(nextDueDate)
                  if (scheduleMode === 'unscheduled' || scheduleMode === 'due-date') {
                    setScheduleDueDate(nextDueDate)
                  }
                  if (nextDueDate && scheduleMode === 'unscheduled') {
                    setScheduleMode('due-date')
                  } else if (!nextDueDate && scheduleMode === 'due-date') {
                    setScheduleMode('unscheduled')
                  }
                }}
                name="dueDate"
                type="date"
                value={quickDueDate}
              />
            </label>
            <div className="flex items-center gap-2">
              <button
                className="workbench-button-primary min-h-11 px-4 disabled:cursor-not-allowed disabled:border-[#b5bdc9] disabled:bg-[#b5bdc9]"
                disabled={isSubmitPending || isSubmissionDisabled || !hasCreatableWorkItemType || isAssigneeOptionsLoading || Boolean(assigneeErrorMessage) || assigneeOptions.length === 0}
                type="submit"
              >
                {isSubmitPending ? t('tasks.create.saving') : t('tasks.create.submit')}
              </button>
              <button
                className="workbench-button-secondary min-h-11 px-4"
                disabled={isSubmitPending}
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
                aria-describedby={hasInvalidContextAssignee && !hasSelectedAssignee && !isAssigneeOptionsLoading
                  ? 'create-task-assignee-context-error'
                  : undefined}
                aria-label={t('tasks.create.assignee')}
                className="workbench-input h-10 px-3"
                disabled={isSubmitPending || isAssigneeOptionsLoading || Boolean(assigneeErrorMessage)}
                name="assigneeUserId"
                onChange={(event) => {
                  markDirty()
                  setSelectedAssigneeUserId(event.target.value)
                }}
                required
                value={assigneeValue}
              >
                <option disabled hidden value="">
                  {t('tasks.create.assigneeSelectPlaceholder')}
                </option>
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>
                    {formatProjectMemberOption(member, member.id === currentUserAssignee?.id, t)}
                  </option>
                ))}
              </select>
              {hasInvalidContextAssignee && !hasSelectedAssignee && !isAssigneeOptionsLoading ? (
                <span className="text-xs font-semibold text-amber-700" id="create-task-assignee-context-error" role="alert">
                  {t('tasks.create.assigneeContextInvalid')}
                </span>
              ) : null}
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.column.status')}
              <select
                className="workbench-input h-10 px-3"
                key={effectiveWorkItemTypeId}
                name="workflowStatusId"
                onChange={(event) => setSelectedWorkflowStatusId(event.target.value)}
                value={effectiveWorkflowStatusId}
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
                name="priority"
                onChange={(event) => setPriority(resolveTaskPriority(event.target.value))}
                value={priority}
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
                className="workbench-button-primary min-h-11 px-4 disabled:cursor-not-allowed disabled:border-[#b5bdc9] disabled:bg-[#b5bdc9]"
                disabled={
                  isSubmitPending ||
                  isSubmissionDisabled ||
                  !hasCreatableWorkItemType ||
                  isAssigneeOptionsLoading ||
                  Boolean(assigneeErrorMessage) ||
                  assigneeOptions.length === 0
                }
                type="submit"
              >
                {isSubmitPending ? t('tasks.create.saving') : t('tasks.create.submit')}
              </button>
              <button
                className="workbench-button-secondary min-h-11 px-4"
                disabled={isSubmitPending}
                onClick={onCancel}
                type="button"
              >
                {t('tasks.create.cancel')}
              </button>
            </div>
          </div>
        ) : null}
        <fieldset
          className={`workbench-panel-muted grid gap-3 p-4 ${effectiveMode === 'quick' ? 'hidden' : ''}`}
          disabled={effectiveMode !== 'detailed'}
        >
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
            <ScheduleDateInput
              disabled={scheduleMode !== 'due-date'}
              hidden={scheduleMode !== 'due-date'}
              label={t('tasks.schedule.dueDate')}
              name="scheduleDueDate"
              onChange={(event) => setScheduleDueDate(event.target.value)}
              value={scheduleDueDate}
            />
            <ScheduleDateInput
              disabled={scheduleMode !== 'date-range'}
              hidden={scheduleMode !== 'date-range'}
              label={t('tasks.schedule.startDate')}
              name="scheduleStartDate"
              onChange={(event) => setScheduleStartDate(event.target.value)}
              value={scheduleStartDate}
            />
            <ScheduleDateInput
              disabled={scheduleMode !== 'date-range'}
              hidden={scheduleMode !== 'date-range'}
              label={t('tasks.schedule.endDate')}
              name="scheduleEndDate"
              onChange={(event) => setScheduleEndDate(event.target.value)}
              value={scheduleEndDate}
            />
            <ScheduleDateInput
              disabled={scheduleMode !== 'milestone'}
              hidden={scheduleMode !== 'milestone'}
              label={t('tasks.schedule.milestoneDate')}
              name="scheduleMilestoneDate"
              onChange={(event) => setScheduleMilestoneDate(event.target.value)}
              value={scheduleMilestoneDate}
            />
            <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
              {t('tasks.schedule.effortMinutes')}
              <input
                className="workbench-input h-10 px-3"
                onChange={(event) => setScheduleEffortMinutes(event.target.value)}
                min="0"
                name="scheduleEffortMinutes"
                type="number"
                value={scheduleEffortMinutes}
              />
            </label>
          </div>
          {fieldErrors.schedule ? (
            <p className="text-sm font-semibold text-red-700" role="alert">
              {fieldErrors.schedule}
            </p>
          ) : null}
        </fieldset>
        {hasCustomFields ? (
          <div className={`workbench-panel-muted p-4 ${effectiveMode === 'quick' ? 'hidden' : ''}`}>
            <WorkItemFieldsEditor
              definitions={customFieldDefinitions}
              disabled={effectiveMode !== 'detailed'}
              errors={fieldErrors}
              locale={locale}
              personOptions={personOptions}
              projectId={projectId}
              values={defaultCustomFieldValues}
            />
          </div>
        ) : null}
        {(isSubmissionDisabled
          ? errorMessage ?? t('tasks.create.permissionUnavailable')
          : fieldErrors.submit ?? fieldErrors.mode ?? errorMessage) ? (
          <p className="text-sm font-semibold text-red-700" role="alert">
            {isSubmissionDisabled
              ? errorMessage ?? t('tasks.create.permissionUnavailable')
              : fieldErrors.submit ?? fieldErrors.mode ?? errorMessage}
          </p>
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
        </fieldset>
      </form>
    </section>
  )
}

/** Props for one schedule date field. */
type ScheduleDateInputProps = {
  /** Current ISO date retained by the owning create form. */
  value: string
  /** Visible and accessible field label. */
  label: string
  /** Form field name read by schedule construction. */
  name: string
  /** Whether this schedule variant is currently active. */
  disabled?: boolean
  /** Whether the inactive schedule variant remains visually hidden. */
  hidden?: boolean
  /** Updates the owning form's retained date. */
  onChange: (event: ChangeEvent<HTMLInputElement>) => void
}

/**
 * Renders a required date input used by the selected schedule mode.
 *
 * @param props - Date field label, name, and initial value.
 * @returns A labeled native calendar input.
 */
function ScheduleDateInput({ disabled = false, hidden = false, label, name, onChange, value }: ScheduleDateInputProps) {
  return (
    <label className={`grid gap-1.5 text-sm font-semibold text-[#505967] ${hidden ? 'hidden' : ''}`}>
      {label}
      <input
        className="workbench-input h-10 px-3"
        disabled={disabled}
        name={name}
        onChange={onChange}
        required={!disabled}
        type="date"
        value={value}
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
 * @param isCurrentViewer - Whether the option represents the authenticated viewer.
 * @param t - Translator used for the self label.
 * @returns A label containing the display name and email address.
 */
function formatProjectMemberOption(
  member: ProjectMember,
  isCurrentViewer: boolean,
  t: (key: MessageKey) => string,
) {
  const label = `${member.name ?? member.email} / ${member.email}`
  return isCurrentViewer ? `${label} (${t('tasks.create.self')})` : label
}
