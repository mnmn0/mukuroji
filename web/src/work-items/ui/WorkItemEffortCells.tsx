import type { WorkItemConfiguration, WorkItemEffortFields } from '@mukuroji/contracts'
import { formatPlannedEffortHours } from '../model/contributorAssignments'
import { resolveWorkItemEffortColumnValue, type WorkItemEffortColumnField } from '../model/workItemEffort'

/** Props of one effort column cell's content. */
export type WorkItemEffortCellProps = {
  /** Work Item effort fields. */
  item: WorkItemEffortFields
  /** Effort column shown by the cell. */
  field: WorkItemEffortColumnField
  /** Work Item configuration that selects the progress mode. */
  configuration?: Pick<WorkItemConfiguration, 'progressMode'> | undefined
  /** Localized hours text with a `{hours}` placeholder. */
  hoursLabel: string
}

/**
 * Shows an estimate or remaining effort in hours, or progress as a percentage with a bar.
 *
 * @param props - Work Item, column, configuration, and the hours label.
 * @returns Cell content; an em dash when the value is unknown.
 */
export function WorkItemEffortCell({ configuration, field, hoursLabel, item }: WorkItemEffortCellProps) {
  const value = resolveWorkItemEffortColumnValue(item, field, configuration)
  if (value === undefined) return <span className="text-[var(--workbench-muted)]">—</span>
  if (field !== 'progress') {
    return <span className="tabular-nums">{hoursLabel.replace('{hours}', formatPlannedEffortHours(value))}</span>
  }
  return (
    <span className="flex min-w-0 items-center gap-2 tabular-nums">
      <progress aria-hidden="true" className="h-1.5 w-16 shrink-0" max={100} value={value} />
      <span>{value}%</span>
    </span>
  )
}
