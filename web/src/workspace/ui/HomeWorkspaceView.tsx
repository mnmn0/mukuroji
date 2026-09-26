import type {
  FocusQueueResponse,
  ResolvedWorkItemConfiguration,
} from '@mukuroji/contracts'
import { Link } from 'react-router'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import { workspaceNavPaths } from '../../shared/routing/paths'
import { CheckCircleIcon, ClockIcon, ChevronIcon } from '../../shared/ui/icons'
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
    <div className="mx-auto grid w-full max-w-[1440px] gap-7">
      <dl className="grid grid-cols-2 overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white min-[760px]:grid-cols-4">
        {[
          { label: t('workspace.metric.activeProjects'), value: summary.projects },
          { label: t('workspace.metric.openTasks'), value: summary.tasks },
          {
            label: t('workspace.metric.blocked'),
            value: isFocusUnavailable ? '—' : summary.blocked,
            unavailable: isFocusUnavailable,
            testId: 'workspace-focus-blocked-metric',
          },
          { label: t('workspace.metric.teams'), value: teams.length },
        ].map((metric) => (
          <div
            className="min-w-0 border-[var(--workbench-border)] px-5 py-5 even:border-l max-[759px]:nth-[n+3]:border-t min-[760px]:not-first:border-l"
            data-testid={metric.testId}
            key={metric.label}
          >
            <dt className="text-xs font-medium text-[var(--workbench-muted)]">{metric.label}</dt>
            <dd className="mt-3 text-3xl font-semibold leading-none tracking-tight text-[var(--workbench-text)] tabular-nums">
              {metric.unavailable ? (
                <>
                  <span aria-hidden="true">{metric.value}</span>
                  <span className="sr-only">{t('workspace.focus.previewUnavailable')}</span>
                </>
              ) : metric.value}
            </dd>
          </div>
        ))}
      </dl>
      <div className="grid items-start gap-6 min-[1180px]:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <section className="min-w-0 overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-5 py-5">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2.5 text-base font-semibold text-[var(--workbench-text)]">
                <CheckCircleIcon className="h-5 w-5 shrink-0 fill-none stroke-current stroke-2 text-[var(--workbench-primary)]" />
                {t('workspace.home.focusTitle')}
              </h2>
              <p className="mt-1.5 text-xs leading-5 text-[var(--workbench-muted)]">
                {t('workspace.home.focusMeta')}
              </p>
            </div>
            <Link
              className="workbench-button-primary inline-flex min-h-[44px] items-center gap-2 px-3.5 no-underline"
              data-testid="workspace-home-focus-now"
              to={`${workspaceNavPaths.focus}?section=${focusPreviewSection}`}
            >
              {t('workspace.home.openFocus')}
              <ChevronIcon className="h-4 w-4 -rotate-90 fill-none stroke-current stroke-2" />
            </Link>
          </div>
          <div className="divide-y divide-[var(--workbench-border)]">
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
                  className="inline-flex min-h-[44px] w-fit items-center rounded-lg border border-[var(--workbench-border)] bg-white px-3 font-bold text-[var(--workbench-primary)] no-underline hover:border-[#99d7cf] hover:bg-[var(--workbench-surface-muted)]"
                  data-testid="workspace-home-my-tasks"
                  to={workspaceNavPaths['my-tasks']}
                >
                  {t('workspace.home.openMyTasks')}
                </Link>
              </div>
            ) : null}
          </div>
        </section>

        <section className="min-w-0 overflow-hidden rounded-lg border border-[var(--workbench-border)] bg-white">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--workbench-border)] px-5 py-5">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2.5 text-base font-semibold text-[var(--workbench-text)]">
                <ClockIcon className="h-5 w-5 shrink-0 fill-none stroke-current stroke-2 text-[var(--workbench-warning)]" />
                {t('workspace.home.waitingTitle')}
              </h2>
              <p className="mt-1.5 text-xs leading-5 text-[var(--workbench-muted)]">
                {t('workspace.home.waitingMeta')}
              </p>
            </div>
            <Link
              className="inline-flex min-h-[44px] items-center gap-1 text-xs font-semibold text-[var(--workbench-primary)] no-underline hover:underline hover:underline-offset-4"
              data-testid="workspace-home-focus-waiting"
              to={`${workspaceNavPaths.focus}?section=waiting`}
            >
              {t('workspace.home.openFocusWaiting')}
            </Link>
          </div>
          <div className="divide-y divide-[var(--workbench-border)]">
            {attentionTasks.map((item) => (
              <button
                className="block w-full min-w-0 px-5 py-4 text-left transition-colors hover:bg-[var(--workbench-surface-muted)] focus-visible:-outline-offset-2 disabled:hover:bg-white"
                disabled={!onOpenTask || !isOpenableWorkspaceTask(item.workItem)}
                key={item.id}
                onClick={() => onOpenTask?.(item.workItem)}
                type="button"
              >
                <p className="break-words text-sm font-semibold leading-6 text-[var(--workbench-text)]">
                  {resolveWorkItemTitle(item.workItem)}
                </p>
                <p className="mt-1 text-xs leading-6 text-[var(--workbench-muted)]">
                  {resolveWorkItemAssignee(item.workItem)} / {resolveWorkItemWorkflowStatusLabel(
                    item.workItem,
                    resolveWorkspaceTaskConfiguration(item.workItem, workItemConfigurationsByTeam),
                  )} / {item.workItem.dueDate}
                </p>
                <p className="mt-2 flex flex-wrap gap-1.5 text-xs font-medium text-[var(--workbench-warning)]">
                  {(item.actionability.reasons.length > 0
                    ? item.actionability.reasons.map((reason) => t(getFocusActionabilityMessageKey(reason)))
                    : item.signals.map((signal) => t(getFocusSignalMessageKey(signal.type)))
                  ).filter((reason, index, reasons) => reasons.indexOf(reason) === index).map((reason) => (
                    <span
                      className="rounded border border-amber-200 bg-amber-50 px-2 py-1"
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
                className="px-5 py-10 text-sm leading-6 text-[var(--workbench-muted)]"
                data-testid="workspace-attention-preview-unavailable"
              >
                {t('workspace.focus.previewUnavailable')}
              </p>
            ) : attentionTasks.length === 0 ? (
              <p className="px-5 py-10 text-sm leading-6 text-[var(--workbench-muted)]">
                {t('workspace.focus.empty.waiting')}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
