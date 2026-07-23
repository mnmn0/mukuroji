import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { useState } from 'react'
import type { ProjectDirectoryTeam } from '../../projects/api/directory'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import type { ProjectTask } from '../../tasks/api'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
} from '../../work-items/model/workItemDisplay'
import {
  createWorkspaceTaskKey,
  hasApprovalAttention,
  isOpenableWorkspaceTask,
  resolveWorkspaceProjectName,
  resolveWorkspaceTaskConfiguration,
} from '../../work-items/model/workspaceWorkItems'
import {
  PriorityPill,
  StatusPill,
  createWorkspaceTaskTestToken,
} from '../../work-items/ui/WorkspaceWorkItemPrimitives'
import type { InboxNotification } from '../api/inbox'
import {
  createWorkspaceInboxReasons,
  createWorkspaceInboxTasks,
  type WorkspaceInboxReason,
} from '../model/workspaceInbox'
import type { NotificationInboxController } from '../mutations/useNotifications'
import { NotificationInbox } from './NotificationInbox'

/**
 * The attention-source filter selected in the Workspace inbox.
 */
type WorkspaceInboxSourceFilter = 'all' | 'approval'

/**
 * Visual tones used by attention-reason badges in the Workspace inbox.
 */
type WorkspaceInboxReasonTone = 'danger' | 'primary' | 'warning'

/**
 * Presentation metadata for one Workspace inbox attention reason.
 */
type WorkspaceInboxReasonPresentation = {
  /** The localized message key rendered in the reason badge. */
  messageKey: MessageKey
  /** The visual tone applied to the reason badge. */
  tone: WorkspaceInboxReasonTone
}

const workspaceInboxReasonPresentations: Record<
  WorkspaceInboxReason,
  WorkspaceInboxReasonPresentation
> = {
  approval: {
    messageKey: 'workspace.inbox.reason.approval',
    tone: 'primary',
  },
  'approval-overdue': {
    messageKey: 'workspace.inbox.reason.approvalOverdue',
    tone: 'danger',
  },
  'high-priority': {
    messageKey: 'workspace.inbox.reason.high',
    tone: 'danger',
  },
  overdue: {
    messageKey: 'workspace.inbox.reason.overdue',
    tone: 'danger',
  },
  review: {
    messageKey: 'workspace.inbox.reason.review',
    tone: 'warning',
  },
  watch: {
    messageKey: 'workspace.inbox.reason.watch',
    tone: 'primary',
  },
}

const workspaceInboxReasonToneClassNames: Record<WorkspaceInboxReasonTone, string> = {
  danger: 'workbench-badge-danger',
  primary: 'workbench-badge-primary',
  warning: 'workbench-badge-warning',
}

/**
 * Props for the pure Workspace inbox view.
 */
export type WorkspaceInboxViewProps = {
  /** The locale used by the notification inbox. */
  locale: Locale
  /** Notification data and actions used by the notification inbox. */
  notificationInbox: NotificationInboxController
  /** Opens the destination associated with a notification. */
  onOpenNotification?: (notification: InboxNotification) => void
  /** Opens a Workspace Work Item from the attention queue. */
  onOpenTask?: (task: ProjectTask) => void
  /** Resolves localized Workspace labels. */
  t: (key: MessageKey) => string
  /** Work Items available to the Workspace inbox. */
  tasks: readonly ProjectTask[]
  /** Workspace directory teams used to resolve Project labels. */
  teams: readonly ProjectDirectoryTeam[]
  /** Resolved Work Item configurations keyed by Team ID. */
  workItemConfigurationsByTeam: Readonly<
    Record<string, ResolvedWorkItemConfiguration>
  >
}

/**
 * Renders the Workspace attention queue and notification inbox.
 *
 * @param props - Workspace inbox data, actions, and localized labels.
 * @returns The pure Workspace inbox view.
 */
export function WorkspaceInboxView({
  locale,
  notificationInbox,
  onOpenNotification,
  onOpenTask,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: WorkspaceInboxViewProps) {
  const [sourceFilter, setSourceFilter] = useState<WorkspaceInboxSourceFilter>('all')
  const referenceDate = new Date()
  const inboxTasks = createWorkspaceInboxTasks(tasks, referenceDate)
  const approvalTaskCount = inboxTasks.filter(hasApprovalAttention).length
  const filteredTasks = sourceFilter === 'approval'
    ? inboxTasks.filter(hasApprovalAttention)
    : inboxTasks
  const showAttentionQueue = inboxTasks.length > 0 || sourceFilter === 'approval'

  return (
    <div className="grid gap-5" data-testid="inbox-workbench">
      <section className="workbench-toolbar flex min-w-0 flex-wrap items-center justify-between gap-3 p-4">
        <div
          aria-label={t('workspace.inbox.scopeTitle')}
          className="inline-flex min-w-0 flex-wrap gap-1 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-1"
          role="group"
        >
          <button
            aria-pressed={sourceFilter === 'all'}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold tracking-[0.01em] transition ${
              sourceFilter === 'all'
                ? 'bg-white text-[var(--workbench-text)] shadow-[0_1px_2px_rgba(23,32,29,0.08)]'
                : 'text-[var(--workbench-muted)] hover:bg-white/70 hover:text-[var(--workbench-text)]'
            }`}
            data-testid="inbox-filter-all"
            onClick={() => setSourceFilter('all')}
            type="button"
          >
            {t('workspace.inbox.filter.all')}
          </button>
          <button
            aria-pressed={sourceFilter === 'approval'}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold tracking-[0.01em] transition ${
              sourceFilter === 'approval'
                ? 'bg-white text-[var(--workbench-text)] shadow-[0_1px_2px_rgba(23,32,29,0.08)]'
                : 'text-[var(--workbench-muted)] hover:bg-white/70 hover:text-[var(--workbench-text)]'
            }`}
            data-testid="inbox-filter-approval"
            onClick={() => setSourceFilter('approval')}
            type="button"
          >
            {t('workspace.inbox.filter.approval')}
            {approvalTaskCount > 0 ? (
              <span className="ml-2 rounded-full bg-[var(--workbench-primary)] px-2 py-0.5 text-xs font-bold text-white">
                {approvalTaskCount}
              </span>
            ) : null}
          </button>
        </div>
        <p className="text-sm font-semibold text-[var(--workbench-muted)]">
          {t('workspace.inbox.scopeDescription')}
        </p>
      </section>

      {showAttentionQueue ? (
        <InboxAttentionQueue
          onOpenTask={onOpenTask}
          referenceDate={referenceDate}
          t={t}
          tasks={filteredTasks}
          teams={teams}
          workItemConfigurationsByTeam={workItemConfigurationsByTeam}
        />
      ) : null}

      <NotificationInbox
        controller={notificationInbox}
        locale={locale}
        onOpenNotification={onOpenNotification}
      />
    </div>
  )
}

/**
 * Props for the Work Item attention queue in the Workspace inbox.
 */
type InboxAttentionQueueProps = {
  /** Opens a Work Item selected from the attention queue. */
  onOpenTask?: (task: ProjectTask) => void
  /** Reference date used for overdue-reason presentation. */
  referenceDate: Date
  /** Resolves localized Workspace labels. */
  t: (key: MessageKey) => string
  /** Work Items displayed in the attention queue. */
  tasks: readonly ProjectTask[]
  /** Workspace directory teams used to resolve Project labels. */
  teams: readonly ProjectDirectoryTeam[]
  /** Resolved Work Item configurations keyed by Team ID. */
  workItemConfigurationsByTeam: Readonly<
    Record<string, ResolvedWorkItemConfiguration>
  >
}

/**
 * Renders the filtered Work Item attention queue.
 *
 * @param props - Attention queue data, actions, and localized labels.
 * @returns The Work Item attention queue.
 */
function InboxAttentionQueue({
  onOpenTask,
  referenceDate,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: InboxAttentionQueueProps) {
  return (
    <section className="workbench-panel overflow-hidden">
      <SectionHeader
        title={t('workspace.inbox.queueTitle')}
        meta={t('workspace.inbox.queueMeta').replace('{count}', String(tasks.length))}
      />
      <div
        className="divide-y divide-[var(--workbench-border)]"
        data-testid="inbox-task-list"
      >
        {tasks.map((task) => (
          <button
            className="grid w-full grid-cols-[minmax(220px,1fr)_minmax(170px,0.7fr)_auto] items-center gap-5 p-5 text-left transition hover:bg-[var(--workbench-surface-muted)] disabled:hover:bg-transparent max-[860px]:grid-cols-1"
            data-testid={`inbox-task-${createInboxTaskTestId(task)}`}
            disabled={!onOpenTask || !isOpenableWorkspaceTask(task)}
            key={createWorkspaceTaskKey(task)}
            onClick={() => onOpenTask?.(task)}
            type="button"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-[var(--workbench-text)]">
                {resolveWorkItemTitle(task)}
              </span>
              <span className="mt-1 block truncate text-sm font-medium text-[var(--workbench-muted)]">
                {resolveWorkspaceProjectName(task, teams)} · {resolveWorkItemAssignee(task)}
              </span>
              <span className="mt-3 flex flex-wrap gap-2">
                {createWorkspaceInboxReasons(task, referenceDate).map((reason) => {
                  const presentation = workspaceInboxReasonPresentations[reason]

                  return (
                    <span
                      className={workspaceInboxReasonToneClassNames[presentation.tone]}
                      key={reason}
                    >
                      {t(presentation.messageKey)}
                    </span>
                  )
                })}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <StatusPill
                configuration={resolveWorkspaceTaskConfiguration(
                  task,
                  workItemConfigurationsByTeam,
                )}
                task={task}
              />
              <PriorityPill priority={task.priority} t={t} />
              <span className="text-sm font-semibold text-[var(--workbench-muted)]">
                {task.dueDate}
              </span>
            </span>
            <span className="workbench-badge justify-self-end max-[860px]:justify-self-start">
              {t('workspace.action.openTask')}
            </span>
          </button>
        ))}
        {tasks.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.inbox.emptyTitle')}
            </p>
            <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">
              {t('workspace.inbox.emptyDescription')}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/**
 * Creates the stable test token for a Work Item in the Workspace inbox.
 *
 * @param task - Work Item represented by the test identifier.
 * @returns A Team- and Project-scoped test token.
 */
function createInboxTaskTestId(task: ProjectTask) {
  return createWorkspaceTaskTestToken(
    `${task.teamId}:${task.assignedProjectId ?? 'unassigned'}:${task.id}`,
  )
}
