import type {
  PlanningSnapshot,
  WorkItemDependencyEndpoint,
  WorkItemConfiguration,
  WorkItemRelation,
  WorkItemSchedule,
  WorkItemScheduleCalendarPolicy,
  WorkItemScheduleDependency,
  WorkItemScheduleDependencyPatch,
} from '@mukuroji/contracts'
import { useId, useState } from 'react'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { IssueArtifactsPanel } from '../../files/ui/IssueArtifactsPanel'
import type {
  IssueCollaborationController,
} from '../../issues/mutations/useIssueCollaboration'
import type { TeamIssue, TeamIssueDetail, UpdateTeamIssueInput } from '../../issues/api'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import { IssueCollaborationPanel } from '../../issues/ui/IssueCollaborationPanel'
import type { ProjectDirectoryTeam, ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { createTeamTriagePath } from '../../shared/routing/paths'
import { useTriageWorkItemSources } from '../../triage/queries/useTriageQueries'
import type { WorkspaceMember } from '../../workspace/api'
import {
  isCustomFieldApplicable,
  parseCustomFieldFormData,
} from '../../work-items/model/customFields'
import {
  createCustomFieldErrorMessages,
  createCustomFieldValuePatch,
  resolveEditableWorkflowStatuses,
  resolveWorkItemPersonOptions,
  resolveWorkItemWorkflowStatusId,
} from '../../work-items/model/workItemDisplay'
import type { WorkItemDependencyCreateDraft } from '../../work-items/model/workItemDependencies'
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import { WorkItemDependencyPanel } from '../../work-items/ui/WorkItemDependencyPanel'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../../work-items/ui/WorkItemRelationsEditor'
import type { ProjectTask } from '../api/tasks'
import { resolveTaskPriority, taskPriorities } from '../model/taskView'
import {
  areTaskSchedulesEqual,
  countTaskSchedulePolicyWorkingDays,
  createDefaultDateRangeTaskSchedule,
  createDefaultDueDateTaskSchedule,
  createDefaultMilestoneTaskSchedule,
  createDefaultUnscheduledTaskSchedule,
  resolveTaskScheduleEndDate,
  resolveTaskScheduleStartDate,
} from '../model/taskSchedule'
import { TaskPriorityBadge } from './TaskViewPrimitives'

/** Props accepted by the selected task detail pane. */
export type TaskDetailPaneProps = {
  /** Determines whether the current user may manage one canonical dependency endpoint. */
  canManageScheduleDependencyEndpoint?: (endpoint: WorkItemDependencyEndpoint) => boolean
  /** Whether the current Workspace member may read Team Triage source links. */
  canAccessTriage?: boolean
  /** Access token used by the related-document panel. */
  accessToken?: string
  /** Active project members available as assignees. */
  assigneeOptions: ProjectMember[]
  /** File controller scoped to the selected Work Item. */
  artifacts?: FileArtifactsController
  /** Collaboration controller scoped to the selected Work Item. */
  collaboration?: IssueCollaborationController
  /** Work Item configuration resolved for the selected task. */
  configuration?: WorkItemConfiguration
  /** Current Workspace member key used by collaboration and approval controls. */
  currentWorkspaceMemberKey?: string
  /** Latest detail response for the selected Work Item. */
  detail?: TeamIssueDetail
  /** Detail load or mutation error shown below the form. */
  errorMessage?: string
  /** Comment selected by a notification deep link. */
  focusedCommentId?: string
  /** Root comment containing the selected reply. */
  focusedRootCommentId?: string
  /** Whether the selected Work Item detail is loading. */
  isLoading: boolean
  /** Whether relation candidates are loading. */
  isRelationCandidatesLoading: boolean
  /** Locale used by form controls and nested panels. */
  locale: Locale
  /** Authoritative canonical Work Item dependency graph. */
  planningSnapshot?: PlanningSnapshot
  /** Creates a relation from the selected Work Item. */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Deletes a relation from the selected Work Item. */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Creates a canonical schedule dependency involving any visible Work Item. */
  onCreateScheduleDependency?: (input: WorkItemDependencyCreateDraft) => void | Promise<void>
  /** Deletes a canonical schedule dependency. */
  onDeleteScheduleDependency?: (dependency: WorkItemScheduleDependency) => void | Promise<void>
  /** Closes the detail pane while keeping the list selection and scroll position. */
  onClose?: () => void
  /** Cancels an accepted Schedule action when explicit save detects no schedule change. */
  onScheduleNoChange?: (teamId: string, issueId: string) => void
  /** Saves editable fields on the selected Work Item. */
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
  /** Updates a canonical schedule dependency rule. */
  onUpdateScheduleDependency?: (
    dependency: WorkItemScheduleDependency,
    patch: WorkItemScheduleDependencyPatch,
  ) => void | Promise<void>
  /** Projects in the selected Work Item's owning Team. */
  projects: ProjectDirectoryTeam['projects']
  /** Same-Team Work Items available as relation targets. */
  relationCandidates: TeamIssue[]
  /** Relation candidate load error shown by the relation editor. */
  relationCandidatesErrorMessage?: string
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
  /** Task selected by the list, board, or route. */
  task?: ProjectTask
  /** Workspace members used by custom fields and collaboration panels. */
  workspaceMembers: WorkspaceMember[]
}

/**
 * Renders the selected Work Item form, files, relations, documents, and collaboration.
 *
 * @param props - Selected task data, scoped controllers, and mutation callbacks.
 * @returns The selected task detail pane.
 */
export function TaskDetailPane({
  accessToken,
  assigneeOptions,
  canAccessTriage = false,
  artifacts,
  canManageScheduleDependencyEndpoint,
  collaboration,
  configuration,
  currentWorkspaceMemberKey,
  detail,
  errorMessage,
  focusedCommentId,
  focusedRootCommentId,
  isLoading,
  isRelationCandidatesLoading,
  locale,
  planningSnapshot,
  onAddRelation,
  onCreateScheduleDependency,
  onClose,
  onDeleteRelation,
  onDeleteScheduleDependency,
  onScheduleNoChange,
  onUpdateIssue,
  onUpdateScheduleDependency,
  projects,
  relationCandidates,
  relationCandidatesErrorMessage,
  t,
  task,
  workspaceMembers,
}: TaskDetailPaneProps) {
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const scheduleFormId = useId()
  const {
    data: triageSourcesPages,
    error: triageSourcesError,
    isValidating: isTriageSourcesValidating,
    setSize: setTriageSourcesSize,
    size: triageSourcesSize,
  } = useTriageWorkItemSources(
    accessToken,
    task?.teamId,
    task?.id,
    Boolean(task && canAccessTriage),
  )
  const hasMatchingIssueDetail = Boolean(
    task && detail?.issue.id === task.id && detail.issue.teamId === task.teamId,
  )
  const matchingDetailIssue = hasMatchingIssueDetail ? detail?.issue : undefined
  const selectedIssue = matchingDetailIssue && task && matchingDetailIssue.revision < task.revision
    ? task
    : matchingDetailIssue
  const resolvedAssignedProjectId = selectedIssue?.assignedProjectId ?? task?.assignedProjectId ?? ''
  const projectSelectionIdentity = `${task?.teamId ?? ''}:${task?.id ?? ''}:${selectedIssue?.revision ?? task?.revision ?? 'loading'}`
  const [selectedProject, setSelectedProject] = useState({
    identity: projectSelectionIdentity,
    value: resolvedAssignedProjectId,
  })
  const selectedProjectId = selectedProject.identity === projectSelectionIdentity
    ? selectedProject.value
    : resolvedAssignedProjectId
  const resolvedSchedule = selectedIssue?.schedule ?? task?.schedule
  const scheduleSelectionIdentity = `${task?.teamId ?? ''}:${task?.id ?? ''}:${selectedIssue?.revision ?? task?.revision ?? 'loading'}`
  const [scheduleSelection, setScheduleSelection] = useState<{
    /** Detail revision represented by the selected schedule mode. */
    identity: string
    /** Explicit schedule mode selected in the editor. */
    mode: WorkItemSchedule['mode']
  }>({
    identity: scheduleSelectionIdentity,
    mode: resolvedSchedule?.mode ?? 'unscheduled',
  })
  const selectedScheduleMode = scheduleSelection.identity === scheduleSelectionIdentity
    ? scheduleSelection.mode
    : resolvedSchedule?.mode ?? 'unscheduled'

  if (!task) {
    return (
      <aside
        className="workbench-detail-pane min-h-0 min-w-0 px-5 py-6 max-[1180px]:border-l-0 max-[1180px]:border-t"
        data-testid="task-detail-pane"
      >
        <p className="rounded-md border border-dashed border-[var(--workbench-border-strong)] bg-white px-4 py-8 text-center text-sm font-medium text-[var(--workbench-muted)]">
          {t('tasks.detail.empty')}
        </p>
      </aside>
    )
  }

  const issue = selectedIssue
  const resolvedConfiguration = hasMatchingIssueDetail
    ? detail?.resolvedConfiguration?.configuration ?? configuration
    : configuration
  const needsDetailBeforeEdit = !issue
  const isReadOnly = !onUpdateIssue || needsDetailBeforeEdit
  const title = resolveWorkItemTitle(issue ?? task)
  const assigneeUserId = issue?.assigneeUserId ?? task.assigneeUserId ?? ''
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === assigneeUserId)
  const assigneeLabel = resolveWorkItemAssignee(issue ?? task)
  const schedule = issue?.schedule ?? task.schedule
  const currentWorkflowStatusId = resolveWorkItemWorkflowStatusId(issue ?? task)
  const workflowStatuses = issue
    ? resolveEditableWorkflowStatuses(issue, resolvedConfiguration)
    : []
  const personOptions = resolveWorkItemPersonOptions(workspaceMembers)
  const hasCustomFields = resolvedConfiguration?.customFields.some((definition) =>
    isCustomFieldApplicable(definition, selectedProjectId || undefined),
  ) ?? false
  const relations = hasMatchingIssueDetail ? detail?.relations ?? [] : []
  const canonicalRelationCandidates = relationCandidates.filter((candidate) =>
    candidate.teamId === task.teamId,
  )
  const sourceTriageEntryId = issue?.sourceTriageEntryId ?? task.sourceTriageEntryId
  const triageContextSnapshots = hasMatchingIssueDetail
    ? detail?.triageContextSnapshots ?? []
    : []
  const lastTriageSourcesPage = triageSourcesPages?.at(-1)
  const hasMoreTriageSources = Boolean(lastTriageSourcesPage?.nextCursor)
  const isLoadingMoreTriageSources = Boolean(
    triageSourcesPages && triageSourcesSize > triageSourcesPages.length && isTriageSourcesValidating,
  )
  const reverseTriageSources = triageSourcesPages
    ?.flatMap((page) => page.entries)
    .filter((entry) => entry.id !== sourceTriageEntryId) ?? []

  return (
    <aside
      className="workbench-detail-pane min-h-0 min-w-0 max-[1180px]:border-l-0 max-[1180px]:border-t"
      data-testid="task-detail-pane"
    >
      <form
        className="grid min-w-0 gap-4 border-b border-[var(--workbench-border)] bg-white px-5 py-4"
        key={`${task.teamId}:${task.id}:${issue?.revision ?? 'loading'}`}
        onSubmit={(event) => {
          event.preventDefault()

          if (isReadOnly || !task.teamId) {
            return
          }

          const formData = new FormData(event.currentTarget)
          const nextAssignedProjectId = String(formData.get('assignedProjectId') ?? '').trim()
          const selectedAssigneeUserId = String(formData.get('assigneeUserId') ?? '').trim()
          const workflowStatusId = String(
            formData.get('workflowStatusId') ?? currentWorkflowStatusId,
          ).trim()
          const parsedCustomFields = resolvedConfiguration
            ? parseCustomFieldFormData(formData, resolvedConfiguration.customFields, {
                projectId: nextAssignedProjectId || undefined,
              })
            : { errors: [], values: {} }
          if (parsedCustomFields.errors.length > 0) {
            setFieldErrors(createCustomFieldErrorMessages(
              parsedCustomFields.errors,
              resolvedConfiguration?.customFields ?? [],
              locale,
            ))
            return
          }

          setFieldErrors({})
          const nextIssueInput: UpdateTeamIssueInput = {
            assignedProjectId: nextAssignedProjectId || null,
            customFieldValues: createCustomFieldValuePatch(
              resolvedConfiguration?.customFields ?? [],
              issue?.customFieldValues ?? task.customFieldValues,
              parsedCustomFields.values,
              nextAssignedProjectId || undefined,
            ),
            description: String(formData.get('description') ?? '').trim(),
            priority: resolveTaskPriority(formData.get('priority')),
            title: String(formData.get('title') ?? '').trim(),
            workflowStatusId,
          }

          if (assigneeOptions.some((member) => member.id === selectedAssigneeUserId)) {
            nextIssueInput.assigneeUserId = selectedAssigneeUserId
          }

          void onUpdateIssue?.(task.teamId, task.id, nextIssueInput).catch(() => undefined)
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="workbench-eyebrow text-[var(--workbench-muted)]">
              {t('tasks.detail.title')}
            </p>
            <h2 className="mt-1.5 text-lg font-semibold leading-6 text-[var(--workbench-text)]">{title}</h2>
            {isLoading ? (
              <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">{t('tasks.detail.loading')}</p>
            ) : null}
            {canAccessTriage && sourceTriageEntryId ? (
              <a
                className="mt-2 inline-flex text-sm font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                data-testid="task-detail-triage-source"
                href={createTeamTriagePath(task.teamId, sourceTriageEntryId)}
              >
                {t('tasks.detail.openTriageSource')}
              </a>
            ) : null}
            {reverseTriageSources.length > 0 || triageSourcesError ? (
              <section
                className="mt-3 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5"
                data-testid="task-detail-triage-sources"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--workbench-muted)]">
                  {t('tasks.detail.triageSources.title')}
                </p>
                <ul className="mt-2 grid gap-2">
                  {reverseTriageSources.map((entry) => (
                    <li key={entry.id}>
                      <a
                        className="text-xs font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                        href={createTeamTriagePath(task.teamId, entry.id)}
                      >
                        {entry.sourcePreview.title || t(resolveTriageSourceMessageKey(entry.source.kind))}
                      </a>
                    </li>
                  ))}
                </ul>
                {triageSourcesError ? (
                  <p className="mt-2 text-xs text-red-700" role="alert">
                    {t('tasks.detail.triageSources.error')}
                  </p>
                ) : null}
                {hasMoreTriageSources ? (
                  <button
                    className="workbench-button-secondary mt-3 min-h-9 px-3 text-xs"
                    disabled={isLoadingMoreTriageSources}
                    onClick={() => void setTriageSourcesSize(triageSourcesSize + 1)}
                    type="button"
                  >
                    {isLoadingMoreTriageSources
                      ? t('tasks.detail.triageSources.loadingMore')
                      : t('tasks.detail.triageSources.loadMore')}
                  </button>
                ) : null}
              </section>
            ) : null}
            {canAccessTriage && triageContextSnapshots.length > 0 ? (
              <section
                className="mt-3 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-3 py-2.5"
                data-testid="task-detail-triage-context"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--workbench-muted)]">
                  {t('tasks.detail.triageContext.title')}
                </p>
                <ul className="mt-2 grid gap-2">
                  {triageContextSnapshots.map((snapshot) => (
                    <li className="text-xs leading-5 text-[var(--workbench-muted)]" key={snapshot.triageEntryId}>
                      <a
                        className="font-semibold text-[var(--workbench-primary)] underline-offset-4 hover:underline"
                        href={createTeamTriagePath(task.teamId, snapshot.triageEntryId)}
                      >
                        {t(resolveTriageSourceMessageKey(snapshot.sourceKind))}
                      </a>
                      <span>
                        {' · '}
                        {t('tasks.detail.triageContext.counts')
                          .replace('{comments}', String(snapshot.commentMetadataCount))
                          .replace('{attachments}', String(snapshot.attachmentMetadataCount))
                          .replace('{watchers}', String(snapshot.watcherMetadataCount))}
                      </span>
                      <span className="block">
                        {t(resolveTriageContextAvailabilityMessageKey(snapshot.availability))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <TaskPriorityBadge priority={issue?.priority ?? task.priority} t={t} />
            {onClose ? (
              <button
                aria-label={t('tasks.detail.close')}
                className="rounded px-2 py-1 text-lg leading-none text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-text)]"
                data-testid="task-detail-close"
                onClick={onClose}
                type="button"
              >
                ×
              </button>
            ) : null}
          </div>
        </div>
        <fieldset className="contents" disabled={isReadOnly}>
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('issues.column.title')}
            <input
              className="workbench-input w-full min-w-0 px-3 py-2 text-base font-semibold disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
              defaultValue={title}
              name="title"
              required
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('tasks.detail.description')}
            <textarea
              className="workbench-input min-h-24 w-full min-w-0 px-3 py-2 leading-6 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
              defaultValue={issue?.description ?? ''}
              name="description"
            />
          </label>
          <div className="workbench-panel-muted grid grid-cols-1 gap-3 p-3">
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.project')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                name="assignedProjectId"
                onChange={(event) => setSelectedProject({
                  identity: projectSelectionIdentity,
                  value: event.target.value,
                })}
                value={selectedProjectId}
              >
                <option value="">{t('issues.project.unassigned')}</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('issues.create.assignee')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={assigneeUserId}
                name="assigneeUserId"
              >
                {!hasSelectedAssigneeOption && assigneeUserId ? (
                  <option value={assigneeUserId}>{assigneeLabel}</option>
                ) : null}
                {assigneeOptions.map((member) => (
                  <option key={member.id} value={member.id}>{formatProjectMemberOption(member)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.status')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={currentWorkflowStatusId}
                name="workflowStatusId"
              >
                {workflowStatuses.map((status) => (
                  <option key={status.id} value={status.id}>{status.name}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.column.priority')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={issue?.priority ?? task.priority}
                name="priority"
              >
                {taskPriorities.map((priority) => (
                  <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.schedule.mode')}
              <select
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                form={scheduleFormId}
                name="scheduleMode"
                onChange={(event) => setScheduleSelection({
                  identity: scheduleSelectionIdentity,
                  mode: readDetailScheduleMode(event.currentTarget.value),
                })}
                value={selectedScheduleMode}
              >
                <option value="unscheduled">{t('tasks.schedule.unscheduled')}</option>
                <option value="due-date">{t('tasks.schedule.dueDate')}</option>
                <option value="date-range">{t('tasks.schedule.dateRange')}</option>
                <option value="milestone">{t('tasks.schedule.milestone')}</option>
              </select>
            </label>
            {selectedScheduleMode === 'due-date' ? (
              <DetailScheduleDateInput
                defaultValue={resolveTaskScheduleEndDate(schedule) ?? ''}
                formId={scheduleFormId}
                label={t('tasks.schedule.dueDate')}
                name="scheduleDueDate"
              />
            ) : null}
            {selectedScheduleMode === 'date-range' ? (
              <>
                <DetailScheduleDateInput
                  defaultValue={resolveTaskScheduleStartDate(schedule) ?? ''}
                  formId={scheduleFormId}
                  label={t('tasks.schedule.startDate')}
                  name="scheduleStartDate"
                />
                <DetailScheduleDateInput
                  defaultValue={resolveTaskScheduleEndDate(schedule) ?? ''}
                  formId={scheduleFormId}
                  label={t('tasks.schedule.endDate')}
                  name="scheduleEndDate"
                />
              </>
            ) : null}
            {selectedScheduleMode === 'milestone' ? (
              <DetailScheduleDateInput
                defaultValue={resolveTaskScheduleStartDate(schedule) ?? ''}
                formId={scheduleFormId}
                label={t('tasks.schedule.milestoneDate')}
                name="scheduleMilestoneDate"
              />
            ) : null}
            <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('tasks.schedule.effortMinutes')}
              <input
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={schedule.plannedEffortMinutes}
                form={scheduleFormId}
                min="0"
                name="scheduleEffortMinutes"
                type="number"
              />
            </label>
            <p className="text-xs font-medium text-[var(--workbench-muted)]">
              {schedule.calendarPolicy.timeZone} · {schedule.calendarPolicy.workingWeekdays.join(', ')}
              {schedule.calendarPolicy.holidays.length > 0
                ? ` · ${schedule.calendarPolicy.holidays.join(', ')}`
                : ''}
            </p>
            {fieldErrors.schedule ? (
              <p className="text-sm font-semibold text-red-700" role="alert">
                {fieldErrors.schedule}
              </p>
            ) : null}
            <button
              className="workbench-button-secondary h-9 px-3 disabled:border-slate-300 disabled:bg-slate-300"
              disabled={isReadOnly}
              form={scheduleFormId}
              type="submit"
            >
              {t('tasks.schedule.save')}
            </button>
          </div>
          {hasCustomFields ? (
            <div className="workbench-panel-muted p-4">
              <WorkItemFieldsEditor
                definitions={resolvedConfiguration?.customFields ?? []}
                errors={fieldErrors}
                locale={locale}
                personOptions={personOptions}
                projectId={selectedProjectId || undefined}
                values={issue?.customFieldValues ?? task.customFieldValues}
              />
            </div>
          ) : null}
        </fieldset>
        <button
          className="workbench-button-primary h-10 px-4 disabled:border-slate-300 disabled:bg-slate-300"
          disabled={isReadOnly}
          type="submit"
        >
          {t('issues.detail.save')}
        </button>
        {isReadOnly && !needsDetailBeforeEdit ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">
            {t(!onUpdateIssue ? 'tasks.detail.readOnlyPermission' : 'tasks.detail.readOnly')}
          </p>
        ) : null}
        {errorMessage ? <p className="text-sm font-semibold text-red-700">{errorMessage}</p> : null}
      </form>
      <form
        aria-label={t('tasks.schedule.title')}
        className="hidden"
        id={scheduleFormId}
        onSubmit={(event) => {
          event.preventDefault()
          if (isReadOnly || !task.teamId) return
          const nextSchedule = createDetailSchedule(new FormData(event.currentTarget), schedule)
          if (!nextSchedule) {
            setFieldErrors((current) => ({
              ...current,
              schedule: t('tasks.schedule.invalid'),
            }))
            return
          }
          setFieldErrors((current) => ({ ...current, schedule: undefined }))
          if (areTaskSchedulesEqual(schedule, nextSchedule)) {
            onScheduleNoChange?.(task.teamId, task.id)
            return
          }
          void onUpdateIssue?.(
            task.teamId,
            task.id,
            { schedule: nextSchedule },
          ).catch(() => undefined)
        }}
      />
      {artifacts ? (
        <IssueArtifactsPanel
          completionTransitions={workflowStatuses.filter(
            (status) => status.id !== currentWorkflowStatusId,
          )}
          controller={artifacts}
          currentMemberKey={currentWorkspaceMemberKey}
          locale={locale}
          members={workspaceMembers}
        />
      ) : null}
      <div className="border-b border-[var(--workbench-border)] bg-white px-5 py-5">
        <WorkItemRelationsEditor
          candidates={canonicalRelationCandidates.map((candidate) => ({
            id: candidate.id,
            title: resolveTeamIssueTitle(candidate),
          }))}
          currentWorkItemId={task.id}
          errorMessage={relationCandidatesErrorMessage}
          isLoading={isRelationCandidatesLoading || (isLoading && !issue)}
          locale={locale}
          onAddRelation={onAddRelation
            ? (input) => onAddRelation(task.id, input)
            : undefined}
          onDeleteRelation={onDeleteRelation
            ? (relation) => onDeleteRelation(task.id, relation)
            : undefined}
          readOnly={isReadOnly || (!onAddRelation && !onDeleteRelation)}
          relations={relations}
        />
      </div>
      <div className="border-b border-[var(--workbench-border)] bg-white px-5 py-5">
        <WorkItemDependencyPanel
          canManageEndpoint={canManageScheduleDependencyEndpoint}
          currentEndpoint={{ teamId: task.teamId, workItemId: task.id }}
          onCreate={onCreateScheduleDependency}
          onDelete={onDeleteScheduleDependency}
          onUpdate={onUpdateScheduleDependency}
          snapshot={planningSnapshot}
          t={t}
        />
      </div>
      <RelatedDocuments
        accessToken={accessToken}
        t={t}
        targetId={task.teamId ? `team/${task.teamId}/issue/${task.id}` : undefined}
        targetKind="work-item"
      />
      {collaboration ? (
        <IssueCollaborationPanel
          artifacts={artifacts}
          key={`${task.teamId ?? ''}:${task.id}`}
          controller={collaboration}
          currentMemberKey={currentWorkspaceMemberKey}
          focusedCommentId={focusedCommentId}
          focusedRootCommentId={focusedRootCommentId}
          locale={locale}
          members={workspaceMembers}
        />
      ) : null}
    </aside>
  )
}

/** Props for a schedule date field in the detail editor. */
type DetailScheduleDateInputProps = {
  /** Current ISO date shown by the input. */
  defaultValue: string
  /** Identifier of the standalone schedule form that owns this control. */
  formId: string
  /** Visible and accessible input label. */
  label: string
  /** Form field name used to construct the schedule patch. */
  name: string
}

/**
 * Renders one required native date input for the selected schedule mode.
 *
 * @param props - Current value, label, and form name.
 * @returns A labeled schedule date input.
 */
function DetailScheduleDateInput({
  defaultValue,
  formId,
  label,
  name,
}: DetailScheduleDateInputProps) {
  return (
    <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
      {label}
      <input
        className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
        defaultValue={defaultValue}
        form={formId}
        name={name}
        required
        type="date"
      />
    </label>
  )
}

/**
 * Builds a complete replacement schedule while retaining its persisted calendar policy.
 *
 * @param formData - Submitted detail fields.
 * @param currentSchedule - Current canonical schedule and calendar policy.
 * @returns A replacement schedule, or undefined when its dates or effort are invalid.
 */
function createDetailSchedule(
  formData: FormData,
  currentSchedule: WorkItemSchedule,
): WorkItemSchedule | undefined {
  const mode = readDetailScheduleMode(String(formData.get('scheduleMode') ?? 'unscheduled'))
  const plannedEffortMinutes = readDetailPlannedEffort(
    formData.get('scheduleEffortMinutes'),
  )
  if (plannedEffortMinutes === null) {
    return undefined
  }
  const calendarPolicy = cloneScheduleCalendarPolicy(currentSchedule.calendarPolicy)

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
    return durationDays > 0
      ? { ...draft, calendarPolicy, durationDays }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Narrows an editor value to one explicit schedule mode.
 *
 * @param value - Candidate select value.
 * @returns A supported mode, defaulting unknown values to unscheduled.
 */
function readDetailScheduleMode(value: string): WorkItemSchedule['mode'] {
  if (value === 'due-date' || value === 'date-range' || value === 'milestone') {
    return value
  }
  return 'unscheduled'
}

/**
 * Reads optional nonnegative planned effort.
 *
 * @param value - Submitted effort field.
 * @returns Integer minutes, undefined for an empty field, or null when invalid.
 */
function readDetailPlannedEffort(value: FormDataEntryValue | null): number | undefined | null {
  const text = String(value ?? '').trim()
  if (!text) {
    return undefined
  }
  const minutes = Number(text)
  return Number.isSafeInteger(minutes) && minutes >= 0 ? minutes : null
}

/**
 * Detaches a schedule calendar policy before it is placed in a mutation payload.
 *
 * @param policy - Persisted calendar policy.
 * @returns A detached policy with copied weekday and holiday arrays.
 */
function cloneScheduleCalendarPolicy(
  policy: WorkItemScheduleCalendarPolicy,
): WorkItemScheduleCalendarPolicy {
  return {
    holidays: [...policy.holidays],
    timeZone: policy.timeZone,
    workingWeekdays: [...policy.workingWeekdays],
  }
}

/** Formats a project member for an assignee select option. */
function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}

/**
 * Resolves one provider-neutral Triage source kind to an existing localized label.
 *
 * @param sourceKind - Source channel retained by the duplicate-context snapshot.
 * @returns The message key for the source label.
 */
function resolveTriageSourceMessageKey(
  sourceKind: 'form' | 'chat' | 'email' | 'webhook' | 'manual-handoff',
): MessageKey {
  if (sourceKind === 'manual-handoff') return 'triage.source.manualHandoff'
  return `triage.source.${sourceKind}`
}

/**
 * Resolves retained-context disclosure level to a concise localized explanation.
 *
 * @param availability - Permission-safe context level committed during the merge.
 * @returns The matching Work Item detail message key.
 */
function resolveTriageContextAvailabilityMessageKey(
  availability: 'summary-metadata' | 'counts-only' | 'restricted' | 'redacted',
): MessageKey {
  if (availability === 'summary-metadata') {
    return 'tasks.detail.triageContext.availability.summaryMetadata'
  }
  if (availability === 'counts-only') {
    return 'tasks.detail.triageContext.availability.countsOnly'
  }
  if (availability === 'restricted') {
    return 'tasks.detail.triageContext.availability.restricted'
  }
  return 'tasks.detail.triageContext.availability.redacted'
}

/** Resolves a Team Issue title for relation candidate display. */
function resolveTeamIssueTitle(issue: TeamIssue) {
  return resolveWorkItemTitle(issue)
}
