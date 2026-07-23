import type { ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  MetricCard,
  SectionHeader,
} from '../../shared/ui/WorkbenchPrimitives'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { ProjectTask } from '../../tasks/api'
import { createWorkspaceInboxTasks } from '../../notifications/model/workspaceInbox'
import {
  createWorkspaceActionQueue,
  createWorkspaceTaskKey,
  isOpenableWorkspaceTask,
  resolveWorkspaceTaskConfiguration,
  type WorkspaceSummary,
} from '../../work-items/model/workspaceWorkItems'
import {
  resolveWorkItemAssignee,
  resolveWorkItemTitle,
  resolveWorkItemWorkflowStatusLabel,
} from '../../work-items/model/workItemDisplay'
import { TaskListRow } from '../../work-items/ui/WorkspaceWorkItemPrimitives'

/**
 * Props for the Workspace home view.
 */
export type HomeWorkspaceViewProps = {
  /** Optional callback that opens a selected Work Item. */
  onOpenTask?: (task: ProjectTask) => void
  /** Summary metrics displayed at the top of the view. */
  summary: WorkspaceSummary
  /** Translator used for Workspace labels. */
  t: (key: MessageKey) => string
  /** Workspace Work Items used to build focus and attention queues. */
  tasks: readonly ProjectTask[]
  /** Workspace directory used to display the Team count. */
  teams: readonly ProjectDirectoryTeam[]
  /** Resolved Work Item configurations indexed by Team ID. */
  workItemConfigurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
}

/**
 * Renders the Workspace overview with summary metrics and action queues.
 *
 * @param props - Workspace summary, Work Items, Teams, and optional task action.
 * @returns The Workspace home view.
 */
export function HomeWorkspaceView({
  onOpenTask,
  summary,
  t,
  tasks,
  teams,
  workItemConfigurationsByTeam,
}: HomeWorkspaceViewProps) {
  const referenceDate = new Date()
  const nextTasks = createWorkspaceActionQueue(tasks, referenceDate).slice(0, 3)
  const attentionTasks = createWorkspaceInboxTasks(tasks, referenceDate).slice(0, 3)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard label={t('workspace.metric.blocked')} value={summary.blocked} tone="red" />
        <MetricCard label={t('workspace.metric.teams')} value={teams.length} tone="amber" />
      </div>

      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)] gap-6 max-[1080px]:grid-cols-1">
        <section className="workbench-panel">
          <SectionHeader title={t('workspace.home.focusTitle')} meta={t('workspace.home.focusMeta')} />
          <div className="divide-y divide-slate-100">
            {nextTasks.map((task) => (
              <TaskListRow
                configuration={resolveWorkspaceTaskConfiguration(task, workItemConfigurationsByTeam)}
                key={createWorkspaceTaskKey(task)}
                t={t}
                task={task}
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        </section>

        <section className="workbench-panel">
          <SectionHeader
            title={t('workspace.reports.attentionTitle')}
            meta={t('workspace.reports.attentionMeta')}
          />
          <div className="grid gap-3 px-5 pb-5">
            {attentionTasks.map((task) => (
              <button
                className="rounded-lg border border-[var(--workbench-border)] bg-white p-4 text-left transition hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)] disabled:hover:border-[var(--workbench-border)] disabled:hover:bg-white"
                disabled={!onOpenTask || !isOpenableWorkspaceTask(task)}
                key={createWorkspaceTaskKey(task)}
                onClick={() => onOpenTask?.(task)}
                type="button"
              >
                <p className="text-sm font-semibold text-[var(--workbench-text)]">
                  {resolveWorkItemTitle(task)}
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {resolveWorkItemAssignee(task)} / {resolveWorkItemWorkflowStatusLabel(
                    task,
                    resolveWorkspaceTaskConfiguration(task, workItemConfigurationsByTeam),
                  )} / {task.dueDate}
                </p>
              </button>
            ))}
            {attentionTasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm font-bold text-[#526381]">
                {t('workspace.empty.tasks')}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
