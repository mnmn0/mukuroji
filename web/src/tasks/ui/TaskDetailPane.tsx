import type { WorkItemConfiguration, WorkItemRelation } from '@mukuroji/contracts'
import { useState } from 'react'
import { RelatedDocuments } from '../../documents/ui/RelatedDocuments'
import type { FileArtifactsController } from '../../files/mutations/useFileArtifacts'
import { IssueArtifactsPanel } from '../../files/ui/IssueArtifactsPanel'
import type {
  IssueCollaborationController,
} from '../../issues/mutations/useIssueCollaboration'
import type { TeamIssue, TeamIssueDetail, UpdateTeamIssueInput } from '../../issues/api'
import { resolveWorkItemAssignee, resolveWorkItemTitle } from '../../issues/model/workItemDisplay'
import { IssueCollaborationPanel } from '../../issues/ui/IssueCollaborationPanel'
import type { ProjectDirectoryTeam, ProjectMember } from '../../projects/api'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
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
import { WorkItemFieldsEditor } from '../../work-items/ui/WorkItemFieldsEditor'
import {
  WorkItemRelationsEditor,
  type WorkItemRelationEditorInput,
} from '../../work-items/ui/WorkItemRelationsEditor'
import type { ProjectTask } from '../api/tasks'
import { resolveTaskPriority, taskPriorities } from '../model/taskView'
import { TaskPriorityBadge } from './TaskViewPrimitives'

/** Props accepted by the selected task detail pane. */
export type TaskDetailPaneProps = {
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
  /** Creates a relation from the selected Work Item. */
  onAddRelation?: (issueId: string, input: WorkItemRelationEditorInput) => Promise<void>
  /** Deletes a relation from the selected Work Item. */
  onDeleteRelation?: (issueId: string, relation: WorkItemRelation) => Promise<void>
  /** Saves editable fields on the selected Work Item. */
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
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
  artifacts,
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
  onAddRelation,
  onDeleteRelation,
  onUpdateIssue,
  projects,
  relationCandidates,
  relationCandidatesErrorMessage,
  t,
  task,
  workspaceMembers,
}: TaskDetailPaneProps) {
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string | undefined>>>({})
  const hasMatchingIssueDetail = Boolean(
    task && detail?.issue.id === task.id && detail.issue.teamId === task.teamId,
  )
  const selectedIssue = hasMatchingIssueDetail ? detail?.issue : undefined
  const resolvedAssignedProjectId = selectedIssue?.assignedProjectId ?? task?.assignedProjectId ?? ''
  const projectSelectionIdentity = `${task?.teamId ?? ''}:${task?.id ?? ''}:${selectedIssue?.revision ?? task?.revision ?? 'loading'}`
  const [selectedProject, setSelectedProject] = useState({
    identity: projectSelectionIdentity,
    value: resolvedAssignedProjectId,
  })
  const selectedProjectId = selectedProject.identity === projectSelectionIdentity
    ? selectedProject.value
    : resolvedAssignedProjectId

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
  const dueDate = issue?.dueDate ?? task.dueDate
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
            dueDate: String(formData.get('dueDate') ?? '').replaceAll('-', '/'),
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
          </div>
          <TaskPriorityBadge priority={issue?.priority ?? task.priority} t={t} />
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
              {t('tasks.column.dueDate')}
              <input
                className="workbench-input h-9 w-full min-w-0 px-3 disabled:bg-[var(--workbench-surface-muted)] disabled:text-[var(--workbench-muted)]"
                defaultValue={formatDateInputValue(dueDate)}
                name="dueDate"
                type="date"
              />
            </label>
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

/** Converts the canonical slash-delimited date into an HTML date input value. */
function formatDateInputValue(value: string) {
  return value.replaceAll('/', '-')
}

/** Formats a project member for an assignee select option. */
function formatProjectMemberOption(member: ProjectMember) {
  return `${member.name ?? member.email} / ${member.email}`
}

/** Resolves a Team Issue title for relation candidate display. */
function resolveTeamIssueTitle(issue: TeamIssue) {
  return resolveWorkItemTitle(issue)
}
