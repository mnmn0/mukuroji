import type { WorkspaceTimePeriodResult } from '@mukuroji/contracts'
import { useId, useState, type FormEvent } from 'react'
import type { WorkspaceTimePeriodState } from '../api/timePeriods'
import { monthPattern, readReason, type Feedback } from './timePeriodForm'
import { describeTimeTrackingFailure, interpolate, type TimeTrackingTranslator } from './timeTrackingText'

/** Props of the Workspace-wide month close view. */
export type WorkspaceTimePeriodPanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** IANA timezone a new close uses for the month boundaries. */
  timeZone: string
  /** Month chosen in the Workspace section, as `YYYY-MM`. */
  workspaceMonth: string
  /** Chooses the month of the Workspace section. */
  onWorkspaceMonthChange: (month: string) => void
  /** Every Team's state for the Workspace month; absent while loading. */
  workspaceState?: WorkspaceTimePeriodState
  /** Whether the Workspace month is loading. */
  isWorkspaceLoading?: boolean
  /** Whether reading the Workspace month failed. */
  hasWorkspaceLoadError?: boolean
  /** Reloads the Workspace month. */
  onRetryWorkspace: () => void
  /** Closes the Workspace month for every Team. */
  onCloseWorkspaceMonth: (month: string) => Promise<WorkspaceTimePeriodResult>
  /** Reopens the Workspace month for every Team with a reason. */
  onReopenWorkspaceMonth: (month: string, reason: string) => Promise<WorkspaceTimePeriodResult>
}

/**
 * Closes and reopens one month for every Team of the Workspace, for a Workspace administrator.
 * It does not depend on the administrator's access to any Team.
 *
 * @param props - Month, every Team's state, and actions.
 * @returns Workspace month close view.
 */
export function WorkspaceTimePeriodPanel({
  hasWorkspaceLoadError = false,
  isWorkspaceLoading = false,
  onCloseWorkspaceMonth,
  onReopenWorkspaceMonth,
  onRetryWorkspace,
  onWorkspaceMonthChange,
  t,
  timeZone,
  workspaceMonth,
  workspaceState,
}: WorkspaceTimePeriodPanelProps) {
  const id = useId()
  const [pendingKey, setPendingKey] = useState<string>()
  const [isReopeningWorkspace, setIsReopeningWorkspace] = useState(false)
  const [workspaceFeedback, setWorkspaceFeedback] = useState<Feedback>()

  /**
   * Runs one action unless another is pending.
   *
   * @param key - Pending action identity.
   * @param operation - Action to run.
   */
  const run = async (key: string, operation: () => Promise<void>) => {
    if (pendingKey) return
    setPendingKey(key)
    try {
      await operation()
    } finally {
      setPendingKey(undefined)
    }
  }

  /**
   * Describes a Workspace-wide result for the status line.
   *
   * @param result - Outcome of each Team.
   * @param action - Close or reopen.
   * @returns Feedback line.
   */
  const describeWorkspaceResult = (result: WorkspaceTimePeriodResult, action: 'close' | 'reopen'): Feedback => {
    const failed = result.results.filter((team) => team.status === 'failed').length
    if (failed > 0) return { tone: 'error', text: interpolate(t('timeTracking.periods.workspacePartial'), { failed }) }
    const changed = result.results.filter((team) => team.status === (action === 'close' ? 'closed' : 'reopened')).length
    return {
      tone: 'status',
      text: interpolate(t(action === 'close' ? 'timeTracking.periods.workspaceClosed' : 'timeTracking.periods.workspaceReopened'), {
        count: changed,
        skipped: result.results.length - changed,
      }),
    }
  }

  /** Closes the Workspace month for every Team. */
  const closeWorkspace = async () => {
    if (!monthPattern.test(workspaceMonth)) return
    setWorkspaceFeedback(undefined)
    await run('workspace:close', async () => {
      try {
        setWorkspaceFeedback(describeWorkspaceResult(await onCloseWorkspaceMonth(workspaceMonth), 'close'))
      } catch (error) {
        setWorkspaceFeedback({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
      }
    })
  }

  /**
   * Reopens the Workspace month for every Team with the typed reason.
   *
   * @param event - Reason form submission.
   */
  const submitWorkspaceReopen = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const reason = readReason(event)
    if (!reason) {
      setWorkspaceFeedback({ tone: 'error', text: t('timeTracking.periods.reasonRequired') })
      return
    }
    setWorkspaceFeedback(undefined)
    await run('workspace:reopen', async () => {
      try {
        setWorkspaceFeedback(describeWorkspaceResult(await onReopenWorkspaceMonth(workspaceMonth, reason), 'reopen'))
        setIsReopeningWorkspace(false)
      } catch (error) {
        setWorkspaceFeedback({ tone: 'error', text: describeTimeTrackingFailure(t, error) })
      }
    })
  }

  const closedTeamCount = workspaceState?.teams.filter((team) => team.close).length ?? 0

  return (
    <section aria-labelledby={`${id}-workspace`} className="grid min-w-0 gap-3" data-testid="workspace-time-period">
      <div className="grid min-w-0 gap-1">
        <h2 className="text-lg font-semibold text-[var(--workbench-text)]" id={`${id}-workspace`}>{t('timeTracking.periods.workspaceTitle')}</h2>
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.periods.workspaceDescription')}</p>
      </div>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-workspace-month`}>
          {t('timeTracking.periods.workspaceMonth')}
          <input
            className="workbench-input min-h-9 px-3"
            disabled={pendingKey !== undefined}
            id={`${id}-workspace-month`}
            onChange={(event) => {
              setWorkspaceFeedback(undefined)
              setIsReopeningWorkspace(false)
              onWorkspaceMonthChange(event.target.value)
            }}
            pattern="[0-9]{4}-[0-9]{2}"
            placeholder="YYYY-MM"
            required
            type="month"
            value={workspaceMonth}
          />
        </label>
        <button
          className="workbench-button-primary min-h-9 px-3"
          disabled={pendingKey !== undefined || !monthPattern.test(workspaceMonth)}
          onClick={() => { void closeWorkspace() }}
          type="button"
        >
          {t('timeTracking.periods.workspaceClose')}
        </button>
        <button
          className="workbench-button-secondary min-h-9 px-3"
          disabled={pendingKey !== undefined || !monthPattern.test(workspaceMonth) || isReopeningWorkspace}
          onClick={() => setIsReopeningWorkspace(true)}
          type="button"
        >
          {t('timeTracking.periods.workspaceReopen')}
        </button>
        <p className="basis-full text-xs font-medium text-[var(--workbench-muted)]">{interpolate(t('timeTracking.periods.timeZone'), { timeZone })}</p>
      </div>
      {isReopeningWorkspace ? (
        <form className="grid min-w-0 gap-2" onSubmit={(event) => { void submitWorkspaceReopen(event) }}>
          <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]" htmlFor={`${id}-workspace-reason`}>
            {t('timeTracking.periods.reopenReason')}
            <textarea autoFocus className="workbench-input min-h-16 w-full min-w-0 px-3 py-2" id={`${id}-workspace-reason`} maxLength={4000} name="reason" required />
          </label>
          <div className="flex flex-wrap gap-2">
            <button className="workbench-button-primary min-h-8 px-3" disabled={pendingKey !== undefined} type="submit">
              {t('timeTracking.periods.confirmReopen')}
            </button>
            <button className="workbench-button-secondary min-h-8 px-3" onClick={() => setIsReopeningWorkspace(false)} type="button">
              {t('timeTracking.form.cancel')}
            </button>
          </div>
        </form>
      ) : null}
      <div aria-live="polite" role="status">
        {workspaceFeedback?.tone === 'status' ? <p className="text-sm font-medium text-[var(--workbench-muted)]">{workspaceFeedback.text}</p> : null}
      </div>
      {workspaceFeedback?.tone === 'error' ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{workspaceFeedback.text}</p> : null}
      {hasWorkspaceLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.periods.workspaceLoadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetryWorkspace} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isWorkspaceLoading && !workspaceState ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.periods.workspaceLoading')}</p> : null}
      {workspaceState ? (
        <div className="grid min-w-0 gap-2">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {interpolate(t('timeTracking.periods.workspaceSummary'), { closed: closedTeamCount, total: workspaceState.teams.length })}
          </p>
          <ul className="grid min-w-0 gap-1">
            {workspaceState.teams.map((team) => (
              <li className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid="workspace-time-period-team" key={team.teamId}>
                <span className="min-w-0 flex-1 break-words text-[var(--workbench-text)]">{team.name ?? team.teamId}</span>
                <span className={team.close ? 'workbench-badge-primary' : 'workbench-badge'}>
                  {t(team.close ? 'timeTracking.periods.workspaceTeamClosed' : 'timeTracking.periods.workspaceTeamOpen')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
