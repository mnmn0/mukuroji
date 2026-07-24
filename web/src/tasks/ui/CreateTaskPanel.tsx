import type { WorkItemConfiguration } from '@mukuroji/contracts'
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
  resolveWorkItemPersonOptions,
} from '../../work-items/model/workItemDisplay'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import type { CreateProjectTaskInput } from '../api/tasks'
import {
  formatTaskDateInputValue,
  resolveTaskPriority,
  taskPriorities,
} from '../model/taskView'

/** Props accepted by the inline project task creation panel. */
export type CreateTaskPanelProps = {
  /** Error shown when project assignee candidates could not be loaded. */
  assigneeErrorMessage?: string
  /** Active project members that may be assigned to the new task. */
  assigneeOptions: ProjectMember[]
  /** Work Item configuration used to validate workflow and custom fields. */
  configuration?: WorkItemConfiguration
  /** Error returned by the create mutation. */
  errorMessage?: string
  /** Whether assignee candidates are being loaded. */
  isAssigneeOptionsLoading: boolean
  /** Whether a create mutation is currently running. */
  isSubmitting: boolean
  /** Locale used by custom field editors and validation messages. */
  locale: Locale
  /** Closes the creation panel without submitting. */
  onCancel: () => void
  /** Submits a validated project task creation request. */
  onSubmit: (input: CreateProjectTaskInput) => Promise<void>
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
  errorMessage,
  isAssigneeOptionsLoading,
  isSubmitting,
  locale,
  onCancel,
  onSubmit,
  projectId,
  t,
  workspaceMembers,
}: CreateTaskPanelProps) {
  const today = formatTaskDateInputValue(new Date())
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const workflowStatuses = resolveCreateWorkflowStatuses(configuration)
  const initialWorkflowStatusId = configuration?.workflow.initialStatusId ?? ''
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const defaultCustomFieldValues = configuration
    ? createDefaultCustomFieldValues(configuration.customFields, projectId)
    : {}
  const hasCustomFields = configuration?.customFields.some((definition) =>
    isCustomFieldApplicable(definition, projectId),
  ) ?? false

  return (
    <section className="border-b border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-[clamp(18px,2.5vw,30px)] py-3">
      <form
        className="workbench-panel grid gap-3 p-4"
        data-testid="create-task-form"
        id="create-task-form"
        onSubmit={(event) => {
          event.preventDefault()

          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const dueDate = String(formData.get('dueDate') ?? today).replaceAll('-', '/')
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? initialWorkflowStatusId,
          ).trim()
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const priority = resolveTaskPriority(formData.get('priority'))
          const parsedCustomFields = configuration
            ? parseCustomFieldFormData(formData, configuration.customFields, {
                applyDefaults: true,
                projectId,
              })
            : { errors: [], values: {} }

          if (!assigneeUserId || !workflowStatus) {
            event.currentTarget.reportValidity()
            return
          }

          if (parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              configuration?.customFields ?? [],
              locale,
            ))
            return
          }

          setFieldErrors({})
          void onSubmit({
            title,
            assigneeUserId,
            dueDate,
            workflowStatusId,
            customFieldValues: parsedCustomFields.values,
            priority,
          })
        }}
      >
        <div className="grid grid-cols-[minmax(220px,1.4fr)_minmax(180px,0.9fr)_150px_150px_150px_auto] gap-3 max-[1180px]:grid-cols-2 max-[720px]:grid-cols-1">
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.create.title')}
            <input
              className="workbench-input h-10 px-3"
              name="title"
              placeholder={t('tasks.create.titlePlaceholder')}
              required
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.create.assignee')}
            <select
              className="workbench-input h-10 px-3"
              defaultValue=""
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
            {t('tasks.column.dueDate')}
            <input
              className="workbench-input h-10 px-3"
              defaultValue={today}
              name="dueDate"
              required
              type="date"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-semibold text-[#505967]">
            {t('tasks.column.status')}
            <select
              className="workbench-input h-10 px-3"
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
        {hasCustomFields ? (
          <div className="workbench-panel-muted p-4">
            <WorkItemFieldsEditor
              definitions={configuration?.customFields ?? []}
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

/**
 * Formats a project member for an assignee select option.
 *
 * @param member - Project member to format.
 * @returns A label containing the display name and email address.
 */
function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}
