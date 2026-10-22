import type { AgentRunView } from '@mukuroji/contracts'
import { useMemo, useState } from 'react'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import type { Locale } from '../../shared/i18n/i18n'
import { releaseAgentRun } from '../api/agentRuns'
import { readAgentRunDisplayState, splitAgentRuns, type AgentRunDisplayState } from '../model/agentRunDisplay'
import { useWorkItemAgentRuns } from '../queries/useWorkItemAgentRuns'
import { createWorkItemAgentRunsLabels, type WorkItemAgentRunsLabels } from './agentRunLabels'

/** Props of the pure Agent Run panel. */
export type WorkItemAgentRunsPanelProps = {
  /** Runs, newest first. */
  runs: readonly AgentRunView[]
  /** Locale-aware text. */
  labels: WorkItemAgentRunsLabels
  /** Whether the first page is loading. */
  isLoading?: boolean
  /** Safe loading failure text. */
  errorMessage?: string
  /** Formats an ISO 8601 timestamp for display. */
  formatDateTime: (value: string) => string
  /** Reloads the runs. */
  onRetry?: () => Promise<void> | void
  /** Releases an active run; omitted when releasing is not wired. */
  onRelease?: (run: AgentRunView) => Promise<void>
}

/** Props of the Agent Run panel connected to the Web API. */
export type WorkItemAgentRunsPanelContainerProps = {
  /** Session access token. */
  accessToken: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID. */
  workItemId: string
  /** Display locale. */
  locale: Locale
}

/** Badge class for each display state. */
const stateBadgeClasses: Record<AgentRunDisplayState, string> = {
  running: 'workbench-badge-primary',
  stalled: 'workbench-badge-warning',
  completed: 'workbench-badge-success',
  paused: 'workbench-badge',
  failed: 'workbench-badge-danger',
  released: 'workbench-badge',
  superseded: 'workbench-badge',
}

/**
 * Shows a Work Item's Agent Runs and lets the assignee or a Team manager release the active run.
 *
 * @param props - Connection inputs.
 * @returns Connected panel.
 */
export function WorkItemAgentRunsPanelContainer({
  accessToken,
  locale,
  teamId,
  workItemId,
}: WorkItemAgentRunsPanelContainerProps) {
  const labels = useMemo(() => createWorkItemAgentRunsLabels(locale), [locale])
  const formatDateTime = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
    return (value: string) => formatter.format(new Date(value))
  }, [locale])
  const mutationRunner = useMemo(() => createMutationRequestRunner(), [])
  const { data, error, isLoading, mutate } = useWorkItemAgentRuns(accessToken, teamId, workItemId)

  return (
    <WorkItemAgentRunsPanel
      errorMessage={!data && error ? labels.loadError : undefined}
      formatDateTime={formatDateTime}
      isLoading={isLoading}
      labels={labels}
      onRelease={async (run) => {
        await mutationRunner.run(
          `agent-run:release:${teamId}:${run.runId}`,
          run.runId,
          (context) => releaseAgentRun(accessToken, teamId, run.runId, context),
        )
        await mutate()
      }}
      onRetry={async () => {
        await mutate()
      }}
      runs={data?.items ?? []}
    />
  )
}

/**
 * Pure view of a Work Item's Agent Runs.
 *
 * @param props - Runs, text, and actions.
 * @returns Panel.
 */
export function WorkItemAgentRunsPanel({
  errorMessage,
  formatDateTime,
  isLoading,
  labels,
  onRelease,
  onRetry,
  runs,
}: WorkItemAgentRunsPanelProps) {
  const [releasingRunId, setReleasingRunId] = useState<string>()
  const [releaseFailed, setReleaseFailed] = useState(false)
  const { active, history } = splitAgentRuns(runs)

  /**
   * Releases a run after the viewer confirms it.
   *
   * @param run - Active run to release.
   */
  const release = async (run: AgentRunView) => {
    if (!onRelease || !window.confirm(labels.releaseConfirm)) return
    setReleasingRunId(run.runId)
    setReleaseFailed(false)
    try {
      await onRelease(run)
    } catch {
      setReleaseFailed(true)
    } finally {
      setReleasingRunId(undefined)
    }
  }

  return (
    <section className="grid min-w-0 gap-3" data-testid="work-item-agent-runs-panel">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.title}</h3>
        <p className="mt-1 text-xs font-medium leading-5 text-[var(--workbench-muted)]">{labels.description}</p>
      </div>

      {errorMessage ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{errorMessage}</span>
          {onRetry ? (
            <button className="workbench-button-secondary min-h-8 px-3" onClick={() => { void onRetry() }} type="button">
              {labels.retry}
            </button>
          ) : null}
        </div>
      ) : isLoading ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{labels.loading}</p>
      ) : runs.length === 0 ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">{labels.empty}</p>
      ) : null}

      {releaseFailed ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          {labels.releaseError}
        </p>
      ) : null}

      {active ? (
        <article className="grid min-w-0 gap-2 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3" data-testid="work-item-agent-run-active">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <AgentRunStateBadge labels={labels} run={active} />
              <span className="truncate text-sm font-semibold text-[var(--workbench-text)]">{active.agentName}</span>
              {active.agentName !== labels.runtimes[active.runtime] ? (
                <span className="workbench-badge">{labels.runtimes[active.runtime]}</span>
              ) : null}
            </div>
            {active.canRelease && onRelease ? (
              <button
                className="workbench-button-secondary min-h-8 px-3"
                disabled={releasingRunId === active.runId}
                onClick={() => { void release(active) }}
                type="button"
              >
                {labels.release}
              </button>
            ) : null}
          </div>
          <dl className="grid grid-cols-3 gap-2 text-xs max-[520px]:grid-cols-1">
            <AgentRunTime label={labels.startedAt} value={formatDateTime(active.startedAt)} />
            <AgentRunTime label={labels.lastActivity} value={formatDateTime(active.lastHeartbeatAt)} />
            <AgentRunTime label={labels.leaseExpiresAt} value={formatDateTime(active.leaseExpiresAt)} />
          </dl>
          {active.stalled ? (
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.stalledHint}</p>
          ) : null}
        </article>
      ) : null}

      {history.length > 0 ? (
        <div className="grid min-w-0 gap-2">
          <h4 className="workbench-eyebrow text-[var(--workbench-muted)]">{labels.history}</h4>
          <ol className="grid min-w-0 gap-1.5">
            {history.map((run) => (
              <li className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-medium text-[var(--workbench-muted)]" key={run.runId}>
                <AgentRunStateBadge labels={labels} run={run} />
                <span className="truncate font-semibold text-[var(--workbench-text)]">{run.agentName}</span>
                {run.agentName !== labels.runtimes[run.runtime] ? <span>{labels.runtimes[run.runtime]}</span> : null}
                <span className="whitespace-nowrap">
                  {formatDateTime(run.startedAt)}
                  {run.finishedAt ? ` – ${formatDateTime(run.finishedAt)}` : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  )
}

/**
 * Shows the display state of a run.
 *
 * @param props - Run and text.
 * @returns Badge.
 */
function AgentRunStateBadge({ labels, run }: {
  /** Panel text. */
  labels: WorkItemAgentRunsLabels
  /** Run to describe. */
  run: AgentRunView
}) {
  const state = readAgentRunDisplayState(run)
  return <span className={stateBadgeClasses[state]}>{labels.states[state]}</span>
}

/**
 * Shows one labeled time of a run.
 *
 * @param props - Label and formatted value.
 * @returns Definition list entry.
 */
function AgentRunTime({ label, value }: {
  /** Field label. */
  label: string
  /** Formatted time. */
  value: string
}) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="truncate font-medium text-[var(--workbench-text)]">{value}</dd>
    </div>
  )
}
