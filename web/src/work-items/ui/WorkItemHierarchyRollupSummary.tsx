import type { WorkItemHierarchyRollup } from '@mukuroji/contracts'
import { formatPlannedEffortHours } from '../model/contributorAssignments'

/** Localized texts of the roll-up summary. */
export type WorkItemHierarchyRollupLabels = {
  /** Accessible name of the summary. */
  summary: string
  /** Closed descendants out of all, with `{closed}` and `{total}` placeholders. */
  closed: string
  /** Rolled-up estimate, with an `{hours}` placeholder. */
  estimate: string
  /** Date span, with `{start}` and `{end}` placeholders. */
  span: string
}

/** Props of the roll-up summary. */
export type WorkItemHierarchyRollupSummaryProps = {
  /** Totals of the parent's descendants. */
  rollup: WorkItemHierarchyRollup
  /** Localized texts. */
  labels: WorkItemHierarchyRollupLabels
}

/**
 * Shows how many descendants are closed, their summed estimate, and the dates they span.
 *
 * @param props - Roll-up and labels.
 * @returns A one-line summary under a parent Work Item.
 */
export function WorkItemHierarchyRollupSummary({ labels, rollup }: WorkItemHierarchyRollupSummaryProps) {
  const closed = rollup.descendantCount - rollup.openDescendantCount
  const percent = rollup.descendantCount === 0 ? 0 : Math.round((closed * 100) / rollup.descendantCount)
  const parts = [
    labels.closed.replace('{closed}', String(closed)).replace('{total}', String(rollup.descendantCount)),
    ...(rollup.estimatedDescendantCount > 0
      ? [labels.estimate.replace('{hours}', formatPlannedEffortHours(rollup.plannedEffortMinutes))]
      : []),
    ...(rollup.startDate && rollup.endDate
      ? [labels.span.replace('{start}', rollup.startDate).replace('{end}', rollup.endDate)]
      : []),
  ]
  return (
    <p
      aria-label={`${labels.summary}: ${parts.join(', ')}`}
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs font-medium text-[var(--workbench-muted)]"
      data-testid="work-item-hierarchy-rollup"
    >
      <progress aria-hidden="true" className="h-1.5 w-12 shrink-0" max={100} value={percent} />
      {parts.map((part) => <span className="tabular-nums" key={part}>{part}</span>)}
    </p>
  )
}
