import type { MessageKey } from '../../shared/i18n/i18n'
import type { WorkItemDependencySummary } from '../model/workItemDependencies'

/** Props for compact canonical schedule-dependency indicators. */
export type WorkItemDependencyChipsProps = {
  /** Optional extra classes applied to the chip container. */
  className?: string
  /** Dependency state calculated from the authoritative planning snapshot. */
  summary?: WorkItemDependencySummary
  /** Resolves localized chip labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders blocker, ripple, conflict, and critical-path signals for one Work Item.
 *
 * @param props - Dependency summary and localized labels.
 * @returns Compact chips, or null when the item has no dependency signal.
 */
export function WorkItemDependencyChips({
  className = '',
  summary,
  t,
}: WorkItemDependencyChipsProps) {
  if (!summary || (
    summary.blockedByCount === 0 &&
    summary.blocksCount === 0 &&
    summary.conflictCount === 0 &&
    summary.requiredShiftDays === 0 &&
    !summary.critical
  )) {
    return null
  }

  return (
    <span
      className={`flex flex-wrap items-center gap-1 ${className}`}
      data-testid="work-item-dependency-chips"
    >
      {summary.blockedByCount > 0 ? (
        <span className="workbench-badge-warning">
          {t('workItems.dependencies.blockedByCount').replace(
            '{count}',
            String(summary.blockedByCount),
          )}
        </span>
      ) : null}
      {summary.blocksCount > 0 ? (
        <span className="workbench-badge">
          {t('workItems.dependencies.blocksCount').replace(
            '{count}',
            String(summary.blocksCount),
          )}
        </span>
      ) : null}
      {summary.requiredShiftDays > 0 ? (
        <span className="workbench-badge-warning">
          {t('workItems.dependencies.delayedDays').replace(
            '{count}',
            formatSignedNumber(summary.requiredShiftDays),
          )}
        </span>
      ) : null}
      {summary.conflictCount > 0 ? (
        <span className="workbench-badge-danger">
          {t('workItems.dependencies.conflictsCount').replace(
            '{count}',
            String(summary.conflictCount),
          )}
        </span>
      ) : null}
      {summary.critical ? (
        <span className="workbench-badge-danger">{t('workItems.dependencies.critical')}</span>
      ) : null}
    </span>
  )
}

/** Formats a numeric delay with an explicit plus sign for positive movement. */
function formatSignedNumber(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}
