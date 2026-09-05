import type {
  FocusQueueResponse,
  ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import { Link } from 'react-router'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import { workspaceNavPaths } from '../../shared/routing/paths'
import { MetricCard } from '../../shared/ui/WorkbenchPrimitives'
import type { CanonicalWorkItem } from '../../tasks/api'
import {
  getFocusActionabilityMessageKey,
  getFocusQueueItems,
  getFocusSignalMessageKey,
} from '../../features/focus-queue/model/focusQueue'
import {
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
  /** Server-ranked Focus queue used by overview previews. */
  focusQueue?: FocusQueueResponse
  /** Whether Focus metrics and previews are unavailable rather than empty. */
  isFocusUnavailable?: boolean
  /** Optional callback that opens a selected Work Item. */
  onOpenTask?: (task: CanonicalWorkItem) => void
  /** Summary metrics displayed at the top of the view. */
  summary: WorkspaceSummary
  /** Translator used for Workspace labels. */
  t: (key: MessageKey) => string
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
  focusQueue,
  isFocusUnavailable = false,
  onOpenTask,
  summary,
  t,
  teams,
  workItemConfigurationsByTeam,
}: HomeWorkspaceViewProps) {
  const nextTasks = [
    ...getFocusQueueItems(focusQueue, 'now'),
    ...getFocusQueueItems(focusQueue, 'next'),
  ].slice(0, 3)
  const focusPreviewSection = getFocusQueueItems(focusQueue, 'now').length > 0
    ? 'now'
    : getFocusQueueItems(focusQueue, 'next').length > 0
      ? 'next'
      : 'now'
  const attentionTasks = getFocusQueueItems(focusQueue, 'waiting').slice(0, 3)

  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)] gap-6 max-[1080px]:grid-cols-1">
        <section className="workbench-panel">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[var(--workbench-text)]">
                {t('workspace.home.focusTitle')}
              </h2>
              <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
                {t('workspace.home.focusMeta')}
              </p>
            </div>
            <Link
              className="inline-flex min-h-11 items-center text-sm font-bold text-[var(--workbench-primary)] underline decoration-[#99d7cf] underline-offset-4 hover:decoration-[var(--workbench-primary)]"
              data-testid="workspace-home-focus-now"
              to={`${workspaceNavPaths.focus}?section=${focusPreviewSection}`}
            >
              {t('workspace.home.openFocus')}
            </Link>
          </div>
          <div className="divide-y divide-slate-100">
            {nextTasks.map((item) => (
              <TaskListRow
                configuration={resolveWorkspaceTaskConfiguration(item.workItem, workItemConfigurationsByTeam)}
                key={item.id}
                t={t}
                task={item.workItem}
                onOpenTask={onOpenTask}
              />
            ))}
            {isFocusUnavailable ? (
              <p
                className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]"
                data-testid="workspace-focus-preview-unavailable"
              >
                {t('workspace.focus.previewUnavailable')}
              </p>
            ) : nextTasks.length === 0 ? (
              <div className="grid gap-3 px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]">
                <p>{t('workspace.home.emptyNext')}</p>
                <Link
                  className="inline-flex min-h-11 w-fit items-center rounded-lg border border-[var(--workbench-border)] bg-white px-3 font-bold text-[var(--workbench-primary)] no-underline hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]"
                  data-testid="workspace-home-my-tasks"
                  to={workspaceNavPaths['my-tasks']}
                >
                  {t('workspace.home.openMyTasks')}
                </Link>
              </div>
            ) : null}
          </div>
        </section>

        <section className="workbench-panel">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-[var(--workbench-text)]">
                {t('workspace.home.waitingTitle')}
              </h2>
              <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
                {t('workspace.home.waitingMeta')}
              </p>
            </div>
            <Link
              className="inline-flex min-h-11 items-center text-sm font-bold text-[var(--workbench-primary)] underline decoration-[#99d7cf] underline-offset-4 hover:decoration-[var(--workbench-primary)]"
              data-testid="workspace-home-focus-waiting"
              to={`${workspaceNavPaths.focus}?section=waiting`}
            >
              {t('workspace.home.openFocusWaiting')}
            </Link>
          </div>
          <div className="grid gap-3 px-5 pb-5">
            {attentionTasks.map((item) => (
              <button
                className="rounded-lg border border-[var(--workbench-border)] bg-white p-4 text-left transition hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)] disabled:hover:border-[var(--workbench-border)] disabled:hover:bg-white"
                disabled={!onOpenTask || !isOpenableWorkspaceTask(item.workItem)}
                key={item.id}
                onClick={() => onOpenTask?.(item.workItem)}
                type="button"
              >
                <p className="text-sm font-semibold text-[var(--workbench-text)]">
                  {resolveWorkItemTitle(item.workItem)}
                </p>
                <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                  {resolveWorkItemAssignee(item.workItem)} / {resolveWorkItemWorkflowStatusLabel(
                    item.workItem,
                    resolveWorkspaceTaskConfiguration(item.workItem, workItemConfigurationsByTeam),
                  )} / {item.workItem.dueDate}
                </p>
                <p className="mt-2 flex flex-wrap gap-1.5 text-xs font-bold text-[var(--workbench-warning)]">
                  {(item.actionability.reasons.length > 0
                    ? item.actionability.reasons.map((reason) => t(getFocusActionabilityMessageKey(reason)))
                    : item.signals.map((signal) => t(getFocusSignalMessageKey(signal.type)))
                  ).filter((reason, index, reasons) => reasons.indexOf(reason) === index).map((reason) => (
                    <span
                      className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1"
                      key={reason}
                    >
                      {reason}
                    </span>
                  ))}
                </p>
              </button>
            ))}
            {isFocusUnavailable ? (
              <p
                className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm font-bold text-[#526381]"
                data-testid="workspace-attention-preview-unavailable"
              >
                {t('workspace.focus.previewUnavailable')}
              </p>
            ) : attentionTasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm font-bold text-[#526381]">
                {t('workspace.focus.empty.waiting')}
              </p>
            ) : null}
          </div>
        </section>
      </div>

      <div className="grid grid-cols-4 gap-4 max-[1180px]:grid-cols-2 max-[680px]:grid-cols-1">
        <MetricCard label={t('workspace.metric.activeProjects')} value={summary.projects} tone="teal" />
        <MetricCard label={t('workspace.metric.openTasks')} value={summary.tasks} tone="emerald" />
        <MetricCard
          label={t('workspace.metric.blocked')}
          srValue={isFocusUnavailable ? t('workspace.focus.previewUnavailable') : undefined}
          testId="workspace-focus-blocked-metric"
          value={isFocusUnavailable ? '—' : summary.blocked}
          tone="red"
        />
        <MetricCard label={t('workspace.metric.teams')} value={teams.length} tone="amber" />
      </div>
    </div>
  )
}
