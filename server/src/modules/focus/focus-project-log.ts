import {
  deriveProjectRaidSeverity,
  isProjectRaidReviewOverdue,
  PROJECT_RAID_SEVERITIES,
  type FocusProjectLogEntry,
  type ProjectRaidEntry,
} from '@mukuroji/contracts'

/** One open Project log entry the viewer owns, read from a Project the viewer can see. */
export type FocusProjectLogSource = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the log belongs to. */
  projectId: string
  /** Display name of the Project, when known. */
  projectTitle?: string
  /** The stored entry. */
  entry: ProjectRaidEntry
}

/**
 * Selects the Project log entries the viewer owns that need attention: an open risk or issue
 * whose review date has passed, and every open change request, which waits for a decision.
 *
 * @param sources - Entries read from Projects the viewer can see.
 * @param viewerMemberKey - Normalized member key of the viewer.
 * @param today - Today in `YYYY-MM-DD` in the Workspace calendar.
 * @returns The entries, most severe first, then by review date and title.
 */
export function createFocusProjectLogEntries(
  sources: readonly FocusProjectLogSource[],
  viewerMemberKey: string,
  today: string,
): FocusProjectLogEntry[] {
  const items = sources.flatMap((source): FocusProjectLogEntry[] => {
    const { entry } = source
    if (entry.status !== 'open') return []
    if (entry.ownerMemberId?.trim().toLowerCase() !== viewerMemberKey) return []
    const reason = entry.kind === 'change-request'
      ? 'decision-pending'
      : isProjectRaidReviewOverdue(entry, today) ? 'review-overdue' : undefined
    if (reason === undefined) return []
    const search = new URLSearchParams({ teamId: source.teamId, tab: 'permissions' })
    return [{
      id: `project-log:${encodeURIComponent(source.teamId)}:${encodeURIComponent(source.projectId)}:${encodeURIComponent(entry.id)}`,
      teamId: source.teamId,
      projectId: source.projectId,
      ...(source.projectTitle === undefined ? {} : { projectTitle: source.projectTitle }),
      entryId: entry.id,
      kind: entry.kind,
      title: entry.title,
      severity: deriveProjectRaidSeverity(entry),
      reason,
      ...(entry.reviewDueDate === undefined ? {} : { reviewDueDate: entry.reviewDueDate }),
      deepLink: `/projects/${encodeURIComponent(source.projectId)}/issues?${search.toString()}`,
    }]
  })
  return items.sort((left, right) =>
    PROJECT_RAID_SEVERITIES.indexOf(right.severity) - PROJECT_RAID_SEVERITIES.indexOf(left.severity) ||
    (left.reviewDueDate ?? '9999-12-31').localeCompare(right.reviewDueDate ?? '9999-12-31') ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id)
  )
}
