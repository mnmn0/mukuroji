import type {
  TriageEntry,
  TriageQueueCounts,
  TriageQueueFilters,
  TriageRoutingCandidate,
  TriageSlaFilter,
} from '../api'

/** Permission-safe presentation model used by the triage queue and detail pane. */
export type TriageEntryView = {
  /** Original validated contract entry used by action callbacks. */
  readonly entry: TriageEntry
  /** Source title, omitted when the source projection is denied. */
  readonly title?: string
  /** Source body preview, omitted outside full visibility. */
  readonly body?: string
  /** Human-readable source label without provider credentials. */
  readonly sourceLabel: string
  /** Current SLA state derived from server timestamps. */
  readonly slaState: TriageSlaFilter
  /** First permitted routing candidate, if one exists. */
  readonly routingCandidate?: TriageRoutingCandidate
}

/**
 * Creates a permission-safe presentation model for one triage entry.
 *
 * @param entry - Validated shared triage contract entry.
 * @param now - Current time used to derive due-soon and breached states.
 * @returns Queue and detail presentation fields with restricted content removed.
 */
export function createTriageEntryView(
  entry: TriageEntry,
  now: Date = new Date(),
): TriageEntryView {
  const canViewContent = entry.permission.visibility === 'full'
  const canViewMetadata = entry.permission.visibility !== 'denied'
  return {
    entry,
    slaState: resolveTriageSlaState(entry, now),
    sourceLabel: entry.sourcePreview.channelLabel ?? entry.source.provider ?? entry.source.kind,
    ...(canViewContent && entry.sourcePreview.body
      ? { body: entry.sourcePreview.body }
      : {}),
    ...(canViewMetadata && entry.sourcePreview.title
      ? { title: entry.sourcePreview.title }
      : {}),
    ...(resolvePrimaryRoutingCandidate(entry)
      ? { routingCandidate: resolvePrimaryRoutingCandidate(entry) }
      : {}),
  }
}

/**
 * Applies URL-backed filters again to the permission-safe entries returned by the queue transport.
 *
 * @param entries - Validated entries from loaded cursor pages.
 * @param filters - Active URL-backed filters.
 * @param currentUserAliases - Stable current-user identifiers used for the Mine filter.
 * @param now - Current time used for SLA derivation.
 * @returns Permission-safe entry views matching every active filter.
 */
export function filterTriageEntryViews(
  entries: readonly TriageEntry[],
  filters: TriageQueueFilters,
  currentUserAliases: readonly string[],
  now: Date = new Date(),
) {
  const normalizedQuery = filters.query?.trim().toLocaleLowerCase() ?? ''
  const currentUserIds = new Set(currentUserAliases.map((value) => value.toLocaleLowerCase()))

  return entries
    .map((entry) => createTriageEntryView(entry, now))
    .filter((view) => {
      const entry = view.entry
      if (filters.state && entry.state !== filters.state) return false
      if (filters.source && entry.source.kind !== filters.source) return false
      if (filters.owner === 'unowned' && entry.ownerUserId) return false
      if (
        filters.owner === 'mine' &&
        (!entry.ownerUserId || !currentUserIds.has(entry.ownerUserId.toLocaleLowerCase()))
      ) return false
      if (filters.sla && view.slaState !== filters.sla) return false
      if (!normalizedQuery) return true

      return [
        view.title,
        view.body,
        view.sourceLabel,
        entry.requester.displayName,
        entry.ownerUserId,
        ...(entry.capabilities.canViewInternalContext
          ? entry.routing.candidates.flatMap((candidate) => [
              candidate.teamId,
              candidate.projectId,
              candidate.reason,
            ])
          : []),
      ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
    })
}

/**
 * Derives queue summary counts from the permission-filtered loaded projection.
 *
 * @param views - Visible triage entry views.
 * @returns Pending, unowned, and breached counts.
 */
export function countTriageEntryViews(
  views: readonly TriageEntryView[],
): TriageQueueCounts {
  return {
    breached: views.filter((view) => view.slaState === 'breached').length,
    pending: views.filter((view) => view.entry.state === 'pending').length,
    unowned: views.filter((view) => !view.entry.ownerUserId).length,
  }
}

/**
 * Resolves the first permitted routing destination retained by ingestion.
 *
 * @param entry - Triage entry containing ordered routing candidates.
 * @returns The first permitted candidate, or undefined when none is routable.
 */
export function resolvePrimaryRoutingCandidate(entry: TriageEntry) {
  return entry.routing.candidates.find((candidate) => candidate.permitted)
}

/**
 * Derives the current SLA condition from server timestamps and lifecycle state.
 *
 * @param entry - Triage entry containing optional SLA timestamps.
 * @param now - Current time used for deadline comparison.
 * @returns Semantic SLA state used by filters and badges.
 */
export function resolveTriageSlaState(
  entry: TriageEntry,
  now: Date = new Date(),
): TriageSlaFilter {
  if (entry.sla?.breachedAt) return 'breached'
  if (entry.state === 'snoozed' || !entry.sla) return 'paused'

  const dueAt = Date.parse(entry.sla.dueAt)
  if (!Number.isFinite(dueAt)) return 'on-track'
  const remainingMilliseconds = dueAt - now.getTime()
  if (remainingMilliseconds <= 0) return 'breached'
  return remainingMilliseconds <= 4 * 60 * 60 * 1000 ? 'due-soon' : 'on-track'
}
