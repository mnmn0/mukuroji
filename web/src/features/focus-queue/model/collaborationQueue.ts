import type { FocusItem, FocusQueueResponse } from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../../projects/api/directory'

/** Collaboration stages derived from authorized Focus evidence. */
export type CollaborationStage = 'attention' | 'active' | 'ready' | 'waiting'

/** One ranked item and its next collaboration stage. */
export type CollaborationQueueEntry = {
  /** Unmodified, permission-filtered Focus item. */
  item: FocusItem
  /** Stage inferred from canonical state and unresolved signals. */
  stage: CollaborationStage
}

/** Stable stage order used by the workspace filters. */
export const collaborationStages: readonly CollaborationStage[] = ['attention', 'active', 'ready', 'waiting']

/**
 * Builds a read-only collaboration queue without overriding the server's ranking.
 * Deferred, completed and canceled work stays in Focus rather than reappearing here.
 *
 * @param response - Current authorized Focus snapshot.
 * @returns Distinct Team-qualified items in Now, Next, Waiting order.
 */
export function createCollaborationQueue(response?: FocusQueueResponse): CollaborationQueueEntry[] {
  const seen = new Set<string>()
  const entries: CollaborationQueueEntry[] = []
  for (const section of ['now', 'next', 'waiting']) {
    for (const item of response?.sections.find((group) => group.section === section)?.items ?? []) {
      const task = item.workItem
      const key = JSON.stringify([task.teamId, task.id])
      if (seen.has(key) || task.archivedAt || task.statusCategory === 'completed' || task.statusCategory === 'canceled') continue
      seen.add(key)
      const stage: CollaborationStage = section === 'waiting' || !item.actionability.actionable
        ? 'waiting'
        : item.signals.some((signal) => signal.resolution.status === 'open' &&
          ['approval', 'review-request', 'mention'].includes(signal.type))
          ? 'attention'
          : task.statusCategory === 'started' ? 'active' : 'ready'
      entries.push({ item, stage })
    }
  }
  return entries
}

/**
 * Filters the loaded queue by stage, Team and task/owner text without changing rank.
 *
 * @param entries - Ranked collaboration entries.
 * @param filter - Temporary queue filter controls.
 * @param teams - Readable directory used for Team and Project search labels.
 * @returns Matching entries in their original order.
 */
export function filterCollaborationQueue(
  entries: readonly CollaborationQueueEntry[],
  filter: {
    /** Selected stage, or all work. */
    stage: CollaborationStage | 'all'
    /** Owning Team identifier, or an empty string for every Team. */
    teamId: string
    /** Case-insensitive task, identifier, owner or Project search. */
    query: string
  },
  teams: readonly ProjectDirectoryTeam[],
): CollaborationQueueEntry[] {
  const query = filter.query.trim().toLocaleLowerCase()
  return entries.filter(({ item, stage }) => {
    const task = item.workItem
    if (filter.stage !== 'all' && stage !== filter.stage) return false
    if (filter.teamId && task.teamId !== filter.teamId) return false
    if (!query) return true
    const team = teams.find((candidate) => candidate.id === task.teamId)
    const project = team?.projects.find((candidate) => candidate.id === task.assignedProjectId)
    return [task.title, task.id, task.assigneeName, task.assigneeEmail, task.assigneeUserId,
      task.teamId, task.assignedProjectId, team?.name, project?.name]
      .some((value) => value?.toLocaleLowerCase().includes(query))
  })
}
