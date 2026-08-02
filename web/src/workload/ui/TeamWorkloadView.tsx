import type { CapacityPlanningGranularity, WorkloadCell, WorkloadSnapshot } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props for the Team workload heatmap. */
export type TeamWorkloadViewProps = {
  /** Workload snapshot returned by the capacity-planning API. */
  snapshot?: WorkloadSnapshot
  /** Whether the snapshot is loading. */
  isLoading: boolean
  /** API error to display below the heading. */
  error?: Error
  /** Current aggregation granularity. */
  granularity: CapacityPlanningGranularity
  /** Changes the aggregation granularity. */
  onGranularityChange: (granularity: CapacityPlanningGranularity) => void
  /** Re-fetches the current snapshot. */
  onRetry: () => void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** Renders a capacity-aware workload heatmap with an accessible tabular fallback. */
export function TeamWorkloadView({
  error,
  granularity,
  isLoading,
  onGranularityChange,
  onRetry,
  snapshot,
  t,
}: TeamWorkloadViewProps) {
  const members = snapshot?.members ?? []
  const totalCapacity = members.reduce((sum, member) => sum + member.capacityMinutes, 0)
  const totalAllocated = members.reduce((sum, member) => sum + member.allocatedMinutes, 0)
  const overloaded = members.filter((member) => member.overloaded).length
  const totalRemaining = members.reduce((sum, member) => sum + member.remainingEffortMinutes, 0)
  const cells = members[0]?.cells ?? []

  return (
    <section className="grid gap-5 border-t border-slate-200 pt-6" data-testid="team-workload">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--workbench-primary)]">
            {t('workload.eyebrow')}
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-[#0d1833]">
            {t('workload.title')}
          </h2>
          <p className="mt-1 max-w-2xl text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workload.description')}
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-200 bg-white p-1" role="tablist" aria-label={t('workload.granularity.label')}>
          {(['day', 'week', 'month'] as const).map((option) => (
            <button
              aria-selected={granularity === option}
              className={granularity === option
                ? 'rounded-md bg-[#0d1833] px-3 py-2 text-xs font-bold text-white'
                : 'rounded-md px-3 py-2 text-xs font-bold text-[#526381] transition hover:bg-slate-50'}
              key={option}
              role="tab"
              type="button"
              onClick={() => onGranularityChange(option)}
            >
              {t(`workload.granularity.${option}`)}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-[#f2c7c7] bg-[#fff7f7] px-4 py-3 text-sm font-semibold text-[#9f3f3f]" role="alert">
          <span>{t('workload.error')}</span>
          <button className="rounded-md border border-[#d99696] px-3 py-2 text-xs font-bold" type="button" onClick={onRetry}>
            {t('workload.retry')}
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-4 gap-3 max-[820px]:grid-cols-2 max-[520px]:grid-cols-1">
        <WorkloadMetric label={t('workload.metric.capacity')} value={formatMinutes(totalCapacity)} tone="teal" />
        <WorkloadMetric label={t('workload.metric.allocated')} value={formatMinutes(totalAllocated)} tone={totalAllocated > totalCapacity ? 'red' : 'amber'} />
        <WorkloadMetric label={t('workload.metric.remaining')} value={formatMinutes(totalRemaining)} tone="blue" />
        <WorkloadMetric label={t('workload.metric.overloaded')} value={String(overloaded)} tone={overloaded > 0 ? 'red' : 'emerald'} />
      </div>

      {isLoading ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-sm font-semibold text-[var(--workbench-muted)]" aria-live="polite">
          {t('workload.loading')}
        </div>
      ) : members.length === 0 ? (
        <div className="border border-dashed border-slate-300 bg-white px-5 py-8" data-testid="team-workload-empty">
          <p className="text-sm font-semibold text-[#0d1833]">{t('workload.empty.title')}</p>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">{t('workload.empty.description')}</p>
        </div>
      ) : (
        <div className="overflow-hidden border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div className="flex flex-wrap items-center gap-3 text-xs font-semibold text-[#526381]">
              <Legend color="bg-[#b9e6e2]" label={t('workload.legend.under')} />
              <Legend color="bg-[#f8e2ab]" label={t('workload.legend.balanced')} />
              <Legend color="bg-[#f3c5c5]" label={t('workload.legend.over')} />
              <Legend color="bg-slate-100" label={t('workload.legend.unavailable')} />
            </div>
            {snapshot && snapshot.redactedAssignmentCount > 0 ? (
              <span className="text-xs font-semibold text-[var(--workbench-muted)]">
                {t('workload.redacted').replace('{count}', String(snapshot.redactedAssignmentCount))}
              </span>
            ) : null}
          </div>
          <div className="overflow-x-auto" tabIndex={0}>
            <table className="min-w-[720px] w-full border-collapse text-left" data-testid="team-workload-heatmap">
              <caption className="sr-only">{t('workload.table.label')}</caption>
              <thead>
                <tr className="border-b border-slate-200 bg-[#fbfcfd]">
                  <th className="sticky left-0 z-10 min-w-[180px] bg-[#fbfcfd] px-4 py-3 text-xs font-bold uppercase tracking-[0.08em] text-[#69758a]" scope="col">
                    {t('workload.table.member')}
                  </th>
                  {cells.map((cell) => (
                    <th className="min-w-[92px] border-l border-slate-100 px-3 py-3 text-xs font-bold text-[#69758a]" key={cell.fromDate} scope="col">
                      {formatBucket(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr className="border-b border-slate-100 last:border-b-0" key={member.memberId}>
                    <th className="sticky left-0 z-10 bg-white px-4 py-3" scope="row">
                      <span className="block truncate text-sm font-bold text-[#0d1833]">{member.displayName ?? member.memberId}</span>
                      <span className="mt-1 block text-xs font-semibold text-[var(--workbench-muted)]">{member.timeZone}</span>
                    </th>
                    {member.cells.map((cell) => (
                      <td className="border-l border-slate-100 px-2 py-2" key={`${member.memberId}-${cell.fromDate}`}>
                        <div className={`min-h-[66px] rounded-md px-2 py-2 ${cellClass(cell)}`} title={formatCellTitle(cell, t)}>
                          <span className="block text-sm font-bold text-[#0d1833]">{formatMinutes(cell.allocatedMinutes)}</span>
                          <span className="mt-1 block text-[11px] font-semibold text-[#526381]">
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
        </div>
      )}
    </section>
  )
}

/** Renders one workload summary metric. */
function WorkloadMetric({ label, value, tone }: { label: string; value: string; tone: 'teal' | 'amber' | 'blue' | 'red' | 'emerald' }) {
  const colors = {
    teal: 'border-[#b9e6e2] bg-[#f2fbfa]',
    amber: 'border-[#f1dbad] bg-[#fffaf0]',
    blue: 'border-[#c9d8f0] bg-[#f5f8ff]',
    red: 'border-[#f2c7c7] bg-[#fff7f7]',
    emerald: 'border-[#bce4d0] bg-[#f3fbf6]',
  }
  return (
    <div className={`border px-4 py-3 ${colors[tone]}`}>
      <p className="text-xs font-bold uppercase tracking-[0.08em] text-[#69758a]">{label}</p>
      <p className="mt-2 text-xl font-bold tracking-[-0.02em] text-[#0d1833]">{value}</p>
    </div>
  )
}

/** Renders one color legend item. */
function Legend({ color, label }: { color: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${color}`} aria-hidden="true" />{label}</span>
}

/** Returns the heatmap surface for one workload cell. */
function cellClass(cell: WorkloadCell): string {
  if (cell.status === 'over') return 'border border-[#efb3b3] bg-[#fff0f0]'
  if (cell.status === 'balanced') return 'border border-[#f1d18b] bg-[#fff8e6]'
  if (cell.status === 'unavailable') return 'border border-slate-100 bg-slate-50'
  return 'border border-[#a7d8d2] bg-[#edf9f7]'
}

/** Formats a bucket header without assuming that all users share a timezone. */
function formatBucket(cell: WorkloadCell): string {
  const date = new Date(`${cell.fromDate}T12:00:00Z`)
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

/** Formats workload minutes in a compact human-readable form. */
function formatMinutes(minutes: number): string {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

/** Creates an accessible cell summary. */
function formatCellTitle(cell: WorkloadCell, t: (key: MessageKey) => string): string {
  return `${formatMinutes(cell.allocatedMinutes)} ${t('workload.cell.allocated')} · ${formatMinutes(cell.capacityMinutes)} ${t('workload.cell.capacity')} · ${cell.utilizationPercent}%`
}
