import type { Locale, MessageKey } from '../i18n'
import { IssueCollaborationPanel } from '../issues/IssueCollaborationPanel'
import type { TeamIssueDetail, UpdateTeamIssueInput } from '../issues/api'
import { resolveWorkItemAssignee } from '../issues/workItemDisplay'
import type { IssueCollaborationController } from '../issues/useIssueCollaboration'
import type { ProjectDirectoryTeam, ProjectMember } from '../projects/api'
import type {
  CreateProjectTaskInput,
  ProjectTask,
  TaskPriority,
  TaskStatus,
} from './api'
import type { WorkspaceMember } from '../workspace/api'
import { TaskPriorityBadge } from './TaskViews'
import { resolveProjectTaskStatus } from './api'
import {
  formatDateInputValue,
  formatProjectMemberOption,
  resolveTaskAssignee,
  resolveTaskTitle,
  resolveTeamIssueTitle,
} from './taskPresentation'
import { taskPriorities, taskStatuses } from './taskViewTypes'

/** 新規タスクを入力して保存するフォームパネルです。 */
export function CreateTaskPanel({
  assigneeErrorMessage,
  assigneeOptions,
  errorMessage,
  isAssigneeOptionsLoading,
  isSubmitting,
  onCancel,
  onSubmit,
  t,
}: {
  assigneeErrorMessage?: string
  assigneeOptions: ProjectMember[]
  errorMessage?: string
  isAssigneeOptionsLoading: boolean
  isSubmitting: boolean
  onCancel: () => void
  onSubmit: (input: CreateProjectTaskInput) => Promise<void>
  t: (key: MessageKey) => string
}) {
  const today = new Date().toISOString().slice(0, 10)

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
          const status = resolveTaskStatus(formData.get('status'))
          const priority = resolveTaskPriority(formData.get('priority'))

          if (!assigneeUserId) {
            event.currentTarget.reportValidity()
            return
          }

          void onSubmit({
            title,
            assigneeUserId,
            dueDate,
            workflowStatusId: status,
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
              defaultValue="todo"
              name="status"
            >
              {taskStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`tasks.status.${status}`)}
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

function resolveTaskStatus(value: FormDataEntryValue | null): TaskStatus {
  if (typeof value === 'string' && taskStatuses.includes(value as TaskStatus)) {
    return value as TaskStatus
  }

  return 'todo'
}

function resolveTaskPriority(value: FormDataEntryValue | null): TaskPriority {
  if (typeof value === 'string' && taskPriorities.includes(value as TaskPriority)) {
    return value as TaskPriority
  }

  return 'medium'
}

/** 選択中タスクの詳細編集と共同作業パネルを描画します。 */
export function TaskDetailPane({
  assigneeOptions,
  collaboration,
  currentWorkspaceMemberKey,
  detail,
  errorMessage,
  focusedCommentId,
  focusedRootCommentId,
  isLoading,
  locale,
  onUpdateIssue,
  projects,
  t,
  task,
  workspaceMembers,
}: {
  assigneeOptions: ProjectMember[]
  collaboration?: IssueCollaborationController
  currentWorkspaceMemberKey?: string
  detail?: TeamIssueDetail
  errorMessage?: string
  focusedCommentId?: string
  focusedRootCommentId?: string
  isLoading: boolean
  locale: Locale
  onUpdateIssue?: (
    teamId: string,
    issueId: string,
    input: UpdateTeamIssueInput,
  ) => Promise<void>
  projects: ProjectDirectoryTeam['projects']
  t: (key: MessageKey) => string
  task?: ProjectTask
  workspaceMembers: WorkspaceMember[]
}) {
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

  const issue = detail?.issue
  const needsDetailBeforeEdit = task.source === 'dynamodb' && !issue
  const isReadOnly = !onUpdateIssue || !task.teamId || task.source !== 'dynamodb' || needsDetailBeforeEdit
  const title = issue ? resolveTeamIssueTitle(issue, t) : resolveTaskTitle(task, t)
  const assigneeUserId = issue?.assigneeUserId ?? task.assigneeUserId ?? ''
  const hasSelectedAssigneeOption = assigneeOptions.some((member) => member.id === assigneeUserId)
  const assigneeLabel = issue ? resolveWorkItemAssignee(issue) : resolveTaskAssignee(task, t)
  const dueDate = issue?.dueDate ?? task.dueDate
  const assignedProjectId = issue?.assignedProjectId ?? task.assignedProjectId ?? ''

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
          const nextIssueInput: UpdateTeamIssueInput = {
            assignedProjectId: nextAssignedProjectId || null,
            description: String(formData.get('description') ?? '').trim(),
            dueDate: String(formData.get('dueDate') ?? '').replaceAll('-', '/'),
            priority: resolveTaskPriority(formData.get('priority')),
            workflowStatusId: resolveTaskStatus(formData.get('status')),
            title: String(formData.get('title') ?? '').trim(),
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
                defaultValue={assignedProjectId}
                name="assignedProjectId"
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
                defaultValue={issue ? resolveProjectTaskStatus(issue) : resolveProjectTaskStatus(task)}
                name="status"
              >
                {taskStatuses.map((status) => (
                  <option key={status} value={status}>{t(`tasks.status.${status}`)}</option>
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
      {collaboration ? (
        <IssueCollaborationPanel
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
