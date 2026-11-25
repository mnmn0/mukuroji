import { AGENT_RUN_OUTCOMES, AGENT_RUN_RUNTIMES, type AgentRunOutcome, type AgentRunRuntime } from '@mukuroji/contracts'
import { RUN_HISTORY_PERIOD_DAYS, runDurationMinutes, type RunHistory, type RunHistoryPeriodDays, type RunHistoryRow } from '../model/runHistory'
import type { RunHistoryLabels } from './runHistoryLabels'

/** Filter values of the Run history. */
export type RunHistoryFilterState = {
  /** Period length in days. */
  days: RunHistoryPeriodDays
  /** One Team, or empty for every Team. */
  teamId: string
  /** One outcome, or empty for every outcome. */
  outcome: AgentRunOutcome | ''
  /** One runtime, or empty for every runtime. */
  runtime: AgentRunRuntime | ''
  /** One Project, or empty for every Project. */
  projectId: string
  /** Whether only the viewer's own runs are shown. */
  mineOnly: boolean
}

/** A selectable Team or Project. */
export type RunHistoryOption = {
  /** ID. */
  id: string
  /** Display name. */
  name: string
}

/** Props of the Run history view. */
export type RunHistoryViewProps = {
  /** Page text. */
  labels: RunHistoryLabels
  /** Current filters. */
  filters: RunHistoryFilterState
  /** Teams the viewer can view. */
  teams: readonly RunHistoryOption[]
  /** Projects of the selected Team, or of every Team. */
  projects: readonly RunHistoryOption[]
  /** Merged history, once loaded. */
  history?: RunHistory
  /** True while the first read of the current filters runs. */
  isLoading: boolean
  /** Failure message of the last read. */
  errorMessage?: string
  /** Project names by ID. */
  projectNames: Readonly<Record<string, string>>
  /** Formats a timestamp for display. */
  formatDateTime: (value: string) => string
  /** Link of a row's Work Item. */
  getWorkItemHref: (row: RunHistoryRow) => string
  /** Opens an in-app link. */
  onNavigate: (href: string) => void
  /** Changes the filters. */
  onFiltersChange: (filters: RunHistoryFilterState) => void
  /** Reads the history again. */
  onRetry: () => void
  /** Downloads the shown rows as CSV. */
  onDownload: () => void
}

/**
 * Tells whether a value is a finished-run outcome.
 *
 * @param value - Raw option value.
 * @returns True for a known outcome.
 */
function isOutcome(value: string): value is AgentRunOutcome {
  return AGENT_RUN_OUTCOMES.some((outcome) => outcome === value)
}

/**
 * Tells whether a value is a client runtime.
 *
 * @param value - Raw option value.
 * @returns True for a known runtime.
 */
function isRuntime(value: string): value is AgentRunRuntime {
  return AGENT_RUN_RUNTIMES.some((runtime) => runtime === value)
}

/** Props of one filter select. */
type FilterSelectProps = {
  /** Visible label. */
  label: string
  /** Selected value. */
  value: string
  /** Options in display order. */
  options: readonly { value: string; label: string }[]
  /** Receives the selected value. */
  onChange: (value: string) => void
}

/**
 * Renders one labelled filter select.
 *
 * @param props - Label, value, and options.
 * @returns The select.
 */
function FilterSelect({ label, value, options, onChange }: FilterSelectProps) {
  return (
    <label className="grid min-w-0 gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <select
        className="min-h-[44px] min-w-0 max-w-[16rem] rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-canvas)] px-2 text-sm font-medium text-[var(--workbench-text)]"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

/**
 * Shows finished agent runs across Teams with period, Team, outcome, runtime, Project, and scope
 * filters, and offers the shown rows as CSV.
 *
 * @param props - History, filters, and callbacks.
 * @returns The Run history view.
 */
export function RunHistoryView({
  labels,
  filters,
  teams,
  projects,
  history,
  isLoading,
  errorMessage,
  projectNames,
  formatDateTime,
  getWorkItemHref,
  onNavigate,
  onFiltersChange,
  onRetry,
  onDownload,
}: RunHistoryViewProps) {
  const rows = history?.rows ?? []
  return (
    <section aria-label={labels.title} className="flex flex-col gap-4">
      <div aria-label={labels.filters} className="flex flex-wrap items-end gap-3" role="group">
        <FilterSelect
          label={labels.period}
          onChange={(value) => {
            const days = RUN_HISTORY_PERIOD_DAYS.find((candidate) => String(candidate) === value)
            if (days !== undefined) onFiltersChange({ ...filters, days })
          }}
          options={RUN_HISTORY_PERIOD_DAYS.map((days) => ({ value: String(days), label: labels.periodDays.replace('{days}', String(days)) }))}
          value={String(filters.days)}
        />
        <FilterSelect
          label={labels.team}
          onChange={(teamId) => onFiltersChange({ ...filters, teamId, projectId: '' })}
          options={[{ value: '', label: labels.allTeams }, ...teams.map((team) => ({ value: team.id, label: team.name }))]}
          value={filters.teamId}
        />
        <FilterSelect
          label={labels.project}
          onChange={(projectId) => onFiltersChange({ ...filters, projectId })}
          options={[{ value: '', label: labels.allProjects }, ...projects.map((project) => ({ value: project.id, label: project.name }))]}
          value={filters.projectId}
        />
        <FilterSelect
          label={labels.outcome}
          onChange={(value) => onFiltersChange({ ...filters, outcome: isOutcome(value) ? value : '' })}
          options={[{ value: '', label: labels.allOutcomes }, ...AGENT_RUN_OUTCOMES.map((outcome) => ({ value: outcome, label: labels.outcomes[outcome] }))]}
          value={filters.outcome}
        />
        <FilterSelect
          label={labels.runtime}
          onChange={(value) => onFiltersChange({ ...filters, runtime: isRuntime(value) ? value : '' })}
          options={[{ value: '', label: labels.allRuntimes }, ...AGENT_RUN_RUNTIMES.map((runtime) => ({ value: runtime, label: labels.runtimes[runtime] }))]}
          value={filters.runtime}
        />
        <FilterSelect
          label={labels.scope}
          onChange={(value) => onFiltersChange({ ...filters, mineOnly: value === 'mine' })}
          options={[{ value: 'all', label: labels.scopeAll }, { value: 'mine', label: labels.scopeMine }]}
          value={filters.mineOnly ? 'mine' : 'all'}
        />
        <button
          className="workbench-button min-h-[44px]"
          disabled={rows.length === 0}
          onClick={onDownload}
          type="button"
        >
          {labels.download}
        </button>
      </div>
      {teams.length === 0 ? <p className="text-sm text-[var(--workbench-muted)]">{labels.noTeams}</p> : null}
      {isLoading ? <p aria-live="polite" className="text-sm text-[var(--workbench-muted)]">{labels.loading}</p> : null}
      {errorMessage ? (
        <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-fg-red-800" role="alert">
          <span>{errorMessage}</span>
          <button className="workbench-button" onClick={onRetry} type="button">{labels.retry}</button>
        </div>
      ) : null}
      {history?.hasMore ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-fg-amber-800" role="note">{labels.incomplete}</p>
      ) : null}
      {history && !errorMessage ? (
        <p className="text-xs text-[var(--workbench-muted)]">{labels.count.replace('{count}', String(rows.length))}</p>
      ) : null}
      {history && rows.length === 0 && !errorMessage && teams.length > 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{labels.empty}</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-[var(--workbench-border)]">
          <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
            <thead className="bg-[var(--workbench-surface-muted)] text-xs text-[var(--workbench-muted)]">
              <tr>
                <th className="px-3 py-2 font-semibold" scope="col">{labels.headings.finishedAt}</th>
                <th className="px-3 py-2 font-semibold" scope="col">{labels.headings.team}</th>
                <th className="px-3 py-2 font-semibold" scope="col">{labels.headings.workItem}</th>
                <th className="px-3 py-2 font-semibold" scope="col">{labels.headings.project}</th>
                <th className="px-3 py-2 font-semibold" scope="col">{labels.headings.agentName}</th>
                <th className="px-3 py-2 font-semibold" scope="col">{labels.headings.runtime}</th>
                <th className="px-3 py-2 font-semibold" scope="col">{labels.headings.outcome}</th>
                <th className="px-3 py-2 text-right font-semibold" scope="col">{labels.headings.durationMinutes}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const href = getWorkItemHref(row)
                const duration = runDurationMinutes(row)
                return (
                  <tr className="border-t border-[var(--workbench-border)]" data-testid="run-history-row" key={`${row.teamId}:${row.runId}`}>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{row.finishedAt ? formatDateTime(row.finishedAt) : ''}</td>
                    <td className="px-3 py-2">{row.teamName}</td>
                    <td className="max-w-[24rem] px-3 py-2">
                      <a
                        className="text-[var(--workbench-primary-text)] underline-offset-2 hover:underline"
                        href={href}
                        onClick={(event) => {
                          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                          event.preventDefault()
                          onNavigate(href)
                        }}
                      >
                        {row.workItemTitle}
                      </a>
                    </td>
                    <td className="px-3 py-2">{row.projectId === undefined ? '' : projectNames[row.projectId] ?? row.projectId}</td>
                    <td className="px-3 py-2">{row.agentName}</td>
                    <td className="px-3 py-2">{labels.runtimes[row.runtime]}</td>
                    <td className="px-3 py-2">{row.outcome === undefined ? '' : labels.outcomes[row.outcome]}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{duration === undefined ? '' : String(duration)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
