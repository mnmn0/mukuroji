import type {
  CapacityPlanningGranularity,
  WorkspaceWorkloadCell,
  WorkspaceWorkloadSnapshot,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props for the workload heatmap across Teams. */
export type WorkspaceWorkloadViewProps = {
  /** Workspace workload snapshot returned by the API. */
  snapshot?: WorkspaceWorkloadSnapshot
  /** Whether the snapshot is loading. */
  isLoading: boolean
  /** Whether the snapshot failed to load. */
  failed: boolean
  /** Current aggregation granularity. */
  granularity: CapacityPlanningGranularity
  /** Changes the aggregation granularity. */
  onGranularityChange: (granularity: CapacityPlanningGranularity) => void
  /** Re-fetches the snapshot. */
  onRetry: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders each visible member's load with every Team's assignments added together.
 *
 * Each cell shows the total allocation against the Workspace-wide capacity; its title lists the
 * allocation per visible Team and what is hidden from the viewer.
 *
 * @param props - Snapshot, loading state, granularity, and labels.
 * @returns The heatmap section.
 */
export function WorkspaceWorkloadView({
  failed,
  granularity,
  isLoading,
  onGranularityChange,
  onRetry,
  snapshot,
  t,
}: WorkspaceWorkloadViewProps) {
  const members = snapshot?.members ?? []
  const teamNames = new Map((snapshot?.teams ?? []).map((team) => [team.teamId, team.name]))
  const cells = members[0]?.cells ?? []
  return (
    <section className="grid gap-4" data-testid="workspace-workload">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--workbench-primary-text)]">
            {t('workspaceWorkload.eyebrow')}
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-fg-0d1833">{t('workspaceWorkload.title')}</h2>
          <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspaceWorkload.description')}
          </p>
        </div>
        <fieldset className="flex rounded-lg border border-slate-200 bg-surface p-1">
          <legend className="sr-only">{t('workload.granularity.label')}</legend>
          {(['day', 'week', 'month'] as const).map((option) => (
            <label
              className={granularity === option
                ? 'rounded-md bg-tone-0d1833 px-3 py-2 text-xs font-bold text-white'
                : 'rounded-md px-3 py-2 text-xs font-bold text-fg-526381 transition hover:bg-slate-50'}
              key={option}
            >
              <input
                checked={granularity === option}
                className="sr-only"
                name="workspace-workload-granularity"
                type="radio"
                value={option}
                onChange={() => onGranularityChange(option)}
              />
              {t(`workload.granularity.${option}`)}
            </label>
          ))}
        </fieldset>
      </div>
      {failed ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-tone-f2c7c7 bg-tone-fff7f7 px-4 py-3 text-sm font-semibold text-fg-9f3f3f" role="alert">
          <span>{t('workspaceWorkload.error')}</span>
          <button className="rounded-md border border-tone-d99696 px-3 py-2 text-xs font-bold" type="button" onClick={onRetry}>
            {t('workload.retry')}
          </button>
        </div>
      ) : isLoading ? (
        <div className="border border-slate-200 bg-surface px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]" aria-live="polite">
          {t('workload.loading')}
        </div>
      ) : members.length === 0 ? (
        <div className="border border-dashed border-slate-300 bg-surface px-5 py-8" data-testid="workspace-workload-empty">
          <p className="text-sm font-semibold text-fg-0d1833">{t('workspaceWorkload.empty.title')}</p>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('workspaceWorkload.empty.description')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 bg-surface" tabIndex={0}>
          <table className="w-full min-w-[720px] border-collapse text-left" data-testid="workspace-workload-heatmap">
            <caption className="sr-only">{t('workspaceWorkload.table.label')}</caption>
            <thead>
              <tr className="border-b border-slate-200 bg-tone-fbfcfd">
                <th className="sticky left-0 z-10 min-w-[200px] bg-tone-fbfcfd px-4 py-3 text-xs font-bold uppercase tracking-[0.08em] text-fg-69758a" scope="col">
                  {t('workload.table.member')}
                </th>
                {cells.map((cell) => (
                  <th className="min-w-[92px] border-l border-slate-100 px-3 py-3 text-xs font-bold text-fg-69758a" key={cell.fromDate} scope="col">
                    {formatBucket(cell, granularity)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr className="border-b border-slate-100 last:border-b-0" key={member.memberId}>
                  <th className="sticky left-0 z-10 bg-surface px-4 py-3" scope="row">
                    <span className="block truncate text-sm font-bold text-fg-0d1833">{member.displayName ?? member.memberId}</span>
                    <span className="mt-1 block truncate text-xs font-semibold text-[var(--workbench-muted)]">
                      {member.teamIds.map((teamId) => teamNames.get(teamId) ?? teamId).join(' · ')}
                    </span>
                  </th>
                  {member.cells.map((cell) => (
                    <td className="border-l border-slate-100 px-2 py-2" key={`${member.memberId}-${cell.fromDate}`}>
                      <div className={`min-h-[58px] rounded-md px-2 py-2 ${cellClass(cell)}`} title={formatCellTitle(cell, teamNames, t)}>
                        <span className="block text-sm font-bold text-fg-0d1833">{formatMinutes(cell.allocatedMinutes)}</span>
                        <span className="mt-1 block text-[11px] font-semibold text-fg-526381">
                          {formatMinutes(cell.capacityMinutes)} · {cell.utilizationPercent}%
                        </span>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** Returns the heatmap surface for one cell. */
function cellClass(cell: WorkspaceWorkloadCell): string {
  if (cell.status === 'over') return 'border border-tone-efb3b3 bg-tone-fff0f0'
  if (cell.status === 'balanced') return 'border border-tone-f1d18b bg-tone-fff8e6'
  if (cell.status === 'unavailable') return 'border border-slate-100 bg-slate-50'
  return 'border border-tone-a7d8d2 bg-tone-edf9f7'
}

/** Formats a bucket header. */
function formatBucket(cell: WorkspaceWorkloadCell, granularity: CapacityPlanningGranularity): string {
  const date = new Date(`${cell.fromDate}T12:00:00Z`)
  if (granularity === 'month') {
    return new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
  }
  const formatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  if (granularity === 'week') return `${formatter.format(date)}–${formatter.format(new Date(`${cell.toDate}T12:00:00Z`))}`
  return formatter.format(date)
}

/** Formats minutes as compact hours. */
function formatMinutes(minutes: number): string {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

/**
 * Lists a cell's allocation per visible Team and the hidden remainder for its title.
 *
 * @param cell - Workspace workload cell.
 * @param teamNames - Team names by ID.
 * @param t - Translator.
 * @returns Title text.
 */
function formatCellTitle(
  cell: WorkspaceWorkloadCell,
  teamNames: ReadonlyMap<string, string>,
  t: (key: MessageKey) => string,
): string {
  const parts = [
    `${formatMinutes(cell.allocatedMinutes)} ${t('workload.cell.allocated')} · ${formatMinutes(cell.capacityMinutes)} ${t('workload.cell.capacity')}`,
    ...cell.teams.map((team) => `${teamNames.get(team.teamId) ?? team.teamId}: ${formatMinutes(team.allocatedMinutes)}`),
  ]
  if (cell.hiddenAllocatedMinutes > 0) {
    parts.push(t('workspaceWorkload.hidden').replace('{hidden}', formatMinutes(cell.hiddenAllocatedMinutes)))
  }
  return parts.join(' · ')
}
