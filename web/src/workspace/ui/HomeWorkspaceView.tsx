import type { FocusQueueResponse, ResolvedWorkItemConfiguration } from '@mukuroji/contracts'
import { Link } from 'react-router'
import { CollaborationQueue } from '../../features/focus-queue/ui/CollaborationQueue'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { MessageKey } from '../../shared/i18n/i18n'
import { workspaceNavPaths } from '../../shared/routing/paths'
import { ChevronIcon } from '../../shared/ui/icons'
import type { CanonicalWorkItem } from '../../tasks/api'
import type { WorkspaceSummary } from '../../work-items/model/workspaceWorkItems'

/** Inputs for the shared human and coding-agent workspace home. */
export type HomeWorkspaceViewProps = {
  /** Server-ranked, permission-filtered Focus snapshot. */
  focusQueue?: FocusQueueResponse
  /** Whether Focus data is unavailable rather than empty. */
  isFocusUnavailable?: boolean
  /** Opens the task detail, including its handoff brief. */
  onOpenTask?: (task: CanonicalWorkItem) => void
  /** Workspace metrics displayed after actionable work. */
  summary: WorkspaceSummary
  /** Current workspace translator. */
  t: (key: MessageKey) => string
  /** Readable Team and Project directory. */
  teams: readonly ProjectDirectoryTeam[]
  /** Resolved configuration indexed by Team ID. */
  workItemConfigurationsByTeam: Readonly<Record<string, ResolvedWorkItemConfiguration>>
}

/**
 * Combines actionable work, human decisions and coding-agent handoff discovery.
 * @param props - Authorized workspace data and navigation callbacks.
 * @returns The responsive collaboration home.
 */
export function HomeWorkspaceView({ focusQueue, isFocusUnavailable = false, onOpenTask, summary, t, teams, workItemConfigurationsByTeam }: HomeWorkspaceViewProps) {
  return (
    <div className="mx-auto grid w-full max-w-[1440px] gap-6">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 border-l-2 border-teal-600 py-1 pl-4">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.collaboration.handoffTitle')}</p>
          <p className="mt-1 text-xs leading-5 text-[var(--workbench-muted)]">{t('workspace.collaboration.handoffDescription')}</p>
        </div>
        <Link className="inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-md border border-[var(--workbench-border)] bg-white px-3 text-xs font-semibold text-[var(--workbench-primary)] no-underline hover:bg-teal-50" to={`${workspaceNavPaths.help}#coding-agent`}>
          {t('workspace.collaboration.connect')}<ChevronIcon className="size-4 -rotate-90 fill-none stroke-current stroke-2" />
        </Link>
      </div>
      <CollaborationQueue configurations={workItemConfigurationsByTeam} onOpenTask={onOpenTask} response={focusQueue} t={t} teams={teams} unavailable={isFocusUnavailable} />
      <dl className="grid grid-cols-2 border-t border-[var(--workbench-border)] min-[760px]:grid-cols-4">
        {[
          { label: t('workspace.metric.activeProjects'), value: summary.projects },
          { label: t('workspace.metric.openTasks'), value: summary.tasks },
          { label: t('workspace.metric.blocked'), value: isFocusUnavailable ? '—' : summary.blocked, unavailable: isFocusUnavailable, testId: 'workspace-focus-blocked-metric' },
          { label: t('workspace.metric.teams'), value: teams.length },
        ].map((metric) => (
          <div className="min-w-0 px-5 py-5" data-testid={metric.testId} key={metric.label}>
            <dt className="text-xs font-medium text-[var(--workbench-muted)]">{metric.label}</dt>
            <dd className="mt-2 text-2xl font-semibold leading-none tracking-tight text-[var(--workbench-text)] tabular-nums">
              {metric.unavailable ? <><span aria-hidden="true">{metric.value}</span><span className="sr-only">{t('workspace.focus.previewUnavailable')}</span></> : metric.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
