import type { WorkItemConfiguration } from '@mukuroji/contracts'
import { useState } from 'react'
import { type Locale, type MessageKey } from '../../shared/i18n/i18n'
import { type CreateTeamIssueInput } from '../api'
import { type ProjectDirectoryTeam, type ProjectMember } from '../../projects/api'
import {
  createDefaultDueDateTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
} from '../../tasks/model/taskSchedule'
import type { WorkspaceMember } from '../../workspace/api'
import {
  createDefaultCustomFieldValues,
  isCustomFieldApplicable,
  parseCustomFieldFormData,
} from '../../work-items/model/customFields'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  createCustomFieldErrorMessages,
  resolveCreateWorkflowStatuses,
  resolveWorkItemPersonOptions,
  resolveWorkItemTypeDefinition,
  resolveWorkItemTypeFormFields,
  resolveCreatableWorkItemTypeId,
  resolveWorkItemTypes,
  resolveWorkItemTypeWorkflow,
} from '../../work-items/model/workItemDisplay'
import {
  formatLocalDateInputValue,
  formatProjectMemberOption,
  issuePriorities,
  resolveIssuePriority,
} from '../model/teamIssueDisplay'

/**
 * Renders the panel that creates a Work Item in the active Team.
 *
 * @param props - Create panel props.
 * @returns The create panel.
 */
export function CreateIssuePanel({
  assigneeOptions,
  canCreateUnassignedIssue,
  configuration,
  errorMessage,
  locale,
  onCancel,
  onSubmit,
  projects,
  t,
  workItemTypeId,
  workflowStatusId,
  workspaceMembers,
}: {
  assigneeOptions: ProjectMember[]
  /** Whether an unassigned Team-owned Work Item is an authorized create destination. */
  canCreateUnassignedIssue: boolean
  configuration?: WorkItemConfiguration
  errorMessage?: string
  locale: Locale
  onCancel: () => void
  onSubmit: (input: CreateTeamIssueInput) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  t: (key: MessageKey) => string
  /** Initial Work Item Type inherited from a Board column. */
  workItemTypeId?: string
  workflowStatusId?: string
  workspaceMembers: WorkspaceMember[]
}) {
  const today = formatLocalDateInputValue()
  const [selectedProjectId, setSelectedProjectId] = useState(
    canCreateUnassignedIssue ? '' : projects[0]?.id ?? '',
  )
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const workItemTypes = resolveWorkItemTypes(configuration)
  const creatableWorkItemTypes = workItemTypes.filter((type) => type.status === 'active')
  const hasLoadedWorkItemConfiguration = configuration !== undefined
  const hasCreatableWorkItemType = hasLoadedWorkItemConfiguration &&
    creatableWorkItemTypes.length > 0
  const contextualWorkItemTypeId = workItemTypeId && creatableWorkItemTypes.some((type) =>
    type.id === workItemTypeId,
  )
    ? workItemTypeId
    : undefined
  const [selectedWorkItemTypeId, setSelectedWorkItemTypeId] = useState(
    contextualWorkItemTypeId ?? creatableWorkItemTypes[0]?.id ?? 'default',
  )
  const effectiveWorkItemTypeId = resolveCreatableWorkItemTypeId(
    workItemTypes,
    selectedWorkItemTypeId,
  )
  const selectedWorkItemType = resolveWorkItemTypeDefinition(configuration, effectiveWorkItemTypeId) ??
    creatableWorkItemTypes[0]
  const customFieldDefinitions = resolveWorkItemTypeFormFields(
    configuration,
    effectiveWorkItemTypeId,
  )
  const selectedWorkflow = resolveWorkItemTypeWorkflow(configuration, effectiveWorkItemTypeId)
  const workflowStatuses = resolveCreateWorkflowStatuses(configuration, effectiveWorkItemTypeId)
  const contextualWorkflowStatusId = workflowStatusId && workflowStatuses.some((status) => status.id === workflowStatusId)
    ? workflowStatusId
    : undefined
  const initialWorkflowStatusId = contextualWorkflowStatusId ?? selectedWorkflow?.initialStatusId ??
    workflowStatuses[0]?.id ?? ''
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const defaultCustomFieldValues = configuration
    ? createDefaultCustomFieldValues(customFieldDefinitions, selectedProjectId || undefined)
    : {}
  const hasCustomFields = customFieldDefinitions.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  ) ?? false

  return (
    <section className="workbench-panel mb-5 min-w-0 p-5">
      <form
        className="grid min-w-0 gap-4"
        data-testid="create-issue-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!hasLoadedWorkItemConfiguration || !hasCreatableWorkItemType) return
          const formData = new FormData(event.currentTarget)
          const title = String(formData.get('title') ?? '').trim()
          const description = String(formData.get('description') ?? '').trim()
          const assignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const assigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const dueDate = String(formData.get('dueDate') ?? '').trim()
          const schedule = dueDate
            ? createDefaultDueDateTaskSchedule(dueDate)
            : createDefaultUnscheduledTaskSchedule()
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? initialWorkflowStatusId,
          ).trim()
          const workflowStatus = workflowStatuses.find((status) => status.id === workflowStatusId)
          const parsedCustomFields = configuration
            ? parseCustomFieldFormData(formData, customFieldDefinitions, {
                applyDefaults: true,
                projectId: assignedProjectId || undefined,
              })
            : { errors: [], values: {} }

          if (!workflowStatus || parsedCustomFields.errors.length > 0) {
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
            description,
            assignedProjectId: assignedProjectId || undefined,
            assigneeUserId,
            customFieldValues: parsedCustomFields.values,
            priority: resolveIssuePriority(formData.get('priority')),
            schedule,
            workItemTypeId: effectiveWorkItemTypeId,
            workflowStatusId,
          })
        }}
      >
        <div className="grid grid-cols-1 gap-3 min-[1180px]:grid-cols-2">
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.title')}
            <input
              className="workbench-input h-10 w-full min-w-0 px-3"
              name="title"
              placeholder={t('issues.create.titlePlaceholder')}
              required
            />
          </label>
          {configuration ? (
            <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.create.workItemType')}
              <select
                className="workbench-input h-10 w-full min-w-0 px-3"
                data-testid="create-issue-work-item-type"
                disabled={!hasCreatableWorkItemType}
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
                <span className="text-xs font-semibold text-fg-amber-700">
                  {t('tasks.create.noActiveWorkItemTypes')}
                </span>
              ) : null}
            </label>
          ) : null}
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.project')}
            <select
              className="workbench-input h-10 w-full min-w-0 px-3"
              name="assignedProjectId"
              onChange={(event) => setSelectedProjectId(event.target.value)}
              value={selectedProjectId}
            >
              {canCreateUnassignedIssue ? (
                <option value="">{t('issues.project.unassigned')}</option>
              ) : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.create.assignee')}
            <select className="workbench-input h-10 w-full min-w-0 px-3" name="assigneeUserId" required>
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
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.dueDate')}
            <input className="workbench-input h-10 w-full min-w-0 px-3" defaultValue={today} name="dueDate" type="date" />
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.status')}
            <select
              className="workbench-input h-10 w-full min-w-0 px-3"
              defaultValue={initialWorkflowStatusId}
              key={effectiveWorkItemTypeId}
              name="workflowStatusId"
            >
              {workflowStatuses.map((status) => (
                <option key={status.id} value={status.id}>
                  {status.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.column.priority')}
            <select className="workbench-input h-10 w-full min-w-0 px-3" defaultValue="medium" name="priority">
              {issuePriorities.map((priority) => (
                <option key={priority} value={priority}>
                  {t(`tasks.priority.${priority}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="grid min-w-0 gap-2 text-sm font-semibold text-[var(--workbench-text)]">
          {t('issues.create.description')}
          <textarea
            className="workbench-input min-h-20 w-full min-w-0 px-3 py-2"
            name="description"
            placeholder={t('issues.create.descriptionPlaceholder')}
          />
        </label>
        {hasCustomFields ? (
          <div className="workbench-panel-muted p-4">
            <WorkItemFieldsEditor
              definitions={customFieldDefinitions}
              errors={fieldErrors}
              locale={locale}
              personOptions={personOptions}
              projectId={selectedProjectId || undefined}
              values={defaultCustomFieldValues}
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <button className="workbench-button-primary h-10 px-4 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300" disabled={!hasCreatableWorkItemType} type="submit">
            {t('issues.create.submit')}
          </button>
          <button className="workbench-button-secondary h-10 px-4" onClick={onCancel} type="button">
            {t('tasks.create.cancel')}
          </button>
          {errorMessage ? <p className="text-sm font-bold text-fg-red-600">{errorMessage}</p> : null}
        </div>
      </form>
    </section>
  )
}
