import type { ArchiveImpactLabels, ArchiveImpactState } from './archiveImpact'

/** Props of {@link ArchiveImpactNotice}. */
export type ArchiveImpactNoticeProps = {
  /** Loading state of the impact. */
  state: ArchiveImpactState
  /** Labels of the notice. */
  labels: ArchiveImpactLabels
}

/**
 * Shows what archiving a Team or Project affects inside its confirmation dialog.
 *
 * @param props - Loading state and labels.
 * @returns The notice.
 */
export function ArchiveImpactNotice({ state, labels }: ArchiveImpactNoticeProps) {
  if (state.status === 'loading') {
    return (
      <p aria-live="polite" className="mt-4 text-sm font-medium text-[var(--workbench-muted)]" role="status">
        {labels.loading}
      </p>
    )
  }

  if (state.status === 'error') {
    return (
      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-fg-amber-900" role="status">
        {labels.loadError}
      </p>
    )
  }

  const { impact } = state
  const exact = (count: number) => labels.count({ count, hasMore: false })
  const blockingLines = [
    impact.planningEntities > 0 ? labels.planningEntities(exact(impact.planningEntities)) : undefined,
    impact.planningWorkItemLinks > 0
      ? labels.planningWorkItemLinks(exact(impact.planningWorkItemLinks))
      : undefined,
    impact.planningDependencies > 0
      ? labels.planningDependencies(exact(impact.planningDependencies))
      : undefined,
  ].filter((line): line is string => line !== undefined)
  const warningLines = [
    impact.openWorkItems.count > 0 || impact.openWorkItems.hasMore
      ? labels.openWorkItems(labels.count(impact.openWorkItems))
      : undefined,
    impact.activeAgentRuns.count > 0 || impact.activeAgentRuns.hasMore
      ? labels.activeAgentRuns(labels.count(impact.activeAgentRuns))
      : undefined,
    impact.webhookSubscriptions > 0
      ? labels.webhookSubscriptions(exact(impact.webhookSubscriptions))
      : undefined,
  ].filter((line): line is string => line !== undefined)

  if (blockingLines.length === 0 && warningLines.length === 0) {
    return (
      <p className="mt-4 text-sm font-medium text-[var(--workbench-muted)]" role="status">
        {labels.none}
      </p>
    )
  }

  return (
    <div className="mt-4 grid gap-3" role="status">
      {blockingLines.length > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-fg-red-700">
          <p className="m-0 font-semibold">{labels.blocked}</p>
          <ul className="m-0 mt-2 list-disc pl-5">
            {blockingLines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      ) : null}
      {warningLines.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-fg-amber-900">
          <p className="m-0 font-semibold">{labels.title}</p>
          <ul className="m-0 mt-2 list-disc pl-5">
            {warningLines.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <p className="m-0 mt-2">{labels.warning}</p>
        </div>
      ) : null}
    </div>
  )
}
