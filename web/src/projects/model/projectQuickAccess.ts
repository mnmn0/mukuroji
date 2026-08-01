import type { ProjectQuickAccessItem } from '@mukuroji/contracts'
import type {
  ProjectDirectoryTeam,
  ProjectDirectoryProject,
} from '../api/directory'

/** Quick-access Project resolved against the current permission-filtered directory. */
export type ResolvedProjectQuickAccessItem = ProjectQuickAccessItem & {
  /** Current Project display name. */
  name: string
  /** Current Team display name. */
  teamName: string
  /** Current Project display tone. */
  tone?: ProjectDirectoryProject['tone']
}

/** Result of toggling one Project shortcut. */
export type ProjectQuickAccessToggleResult = {
  /** Whether the target was added rather than removed. */
  added: boolean
  /** Complete next ordered collection. */
  items: ProjectQuickAccessItem[]
}

/** Shell-level feedback emitted by a quick-access mutation. */
export type ProjectQuickAccessFeedback = {
  /** Outcome represented by the feedback surface. */
  kind: 'added' | 'removed' | 'error'
  /** Project name interpolated into successful feedback. */
  projectName?: string
  /** Complete prior order restored by the Undo action. */
  undoItems?: ProjectQuickAccessItem[]
  /** Committed revision against which the captured order may be restored. */
  undoRevision?: number
  /** Whether the shell should move keyboard focus to the Undo action. */
  focusUndo?: boolean
}

/**
 * Tests whether feedback may restore its captured order against the visible revision.
 *
 * @param feedback - Latest shell-level quick-access feedback.
 * @param currentRevision - Revision currently represented by the client cache.
 * @returns Whether an Undo request is still safe to submit.
 */
export function canUndoProjectQuickAccess(
  feedback: ProjectQuickAccessFeedback | undefined,
  currentRevision: number,
) {
  return Boolean(
    feedback?.undoItems && feedback.undoRevision === currentRevision,
  )
}

/**
 * Resolves stored references against the current readable Project directory.
 *
 * @param items - Stored ordered Project references.
 * @param teams - Current ACL-filtered Team and Project directory.
 * @returns Existing readable Projects in the stored order.
 */
export function resolveProjectQuickAccessItems(
  items: readonly ProjectQuickAccessItem[],
  teams: readonly ProjectDirectoryTeam[],
): ResolvedProjectQuickAccessItem[] {
  return items.flatMap((item) => {
    const team = teams.find((candidate) => candidate.id === item.teamId)
    const project = team?.projects.find((candidate) => candidate.id === item.projectId)
    return team && project
      ? [{
          name: project.name,
          projectId: project.id,
          teamId: team.id,
          teamName: team.name,
          tone: project.tone,
        }]
      : []
  })
}

/**
 * Tests whether a Project is present in quick access.
 *
 * @param items - Current ordered preference.
 * @param projectId - Project ID to test.
 * @returns Whether the Project is starred in any Team context.
 */
export function isProjectInQuickAccess(
  items: readonly ProjectQuickAccessItem[],
  projectId: string,
) {
  return items.some((item) => item.projectId === projectId)
}

/**
 * Adds an unstarred Project or removes a starred Project while preserving order.
 *
 * @param items - Current ordered preference.
 * @param target - Team-owned Project to toggle.
 * @returns The complete next order and whether the target was added.
 */
export function toggleProjectQuickAccess(
  items: readonly ProjectQuickAccessItem[],
  target: ProjectQuickAccessItem,
): ProjectQuickAccessToggleResult {
  if (isProjectInQuickAccess(items, target.projectId)) {
    return {
      added: false,
      items: items
        .filter((item) => item.projectId !== target.projectId)
        .map((item) => ({ ...item })),
    }
  }
  return {
    added: true,
    items: [...items.map((item) => ({ ...item })), { ...target }],
  }
}

/**
 * Moves one quick-access Project by one position.
 *
 * @param items - Current ordered preference.
 * @param projectId - Project to move.
 * @param direction - Relative movement direction.
 * @returns A detached collection with the requested stable order.
 */
export function moveProjectQuickAccessItem(
  items: readonly ProjectQuickAccessItem[],
  projectId: string,
  direction: 'up' | 'down',
) {
  const next = items.map((item) => ({ ...item }))
  const currentIndex = next.findIndex((item) => item.projectId === projectId)
  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  if (
    currentIndex < 0 ||
    targetIndex < 0 ||
    targetIndex >= next.length
  ) return next

  const current = next[currentIndex]
  const target = next[targetIndex]
  if (!current || !target) return next
  next[currentIndex] = target
  next[targetIndex] = current
  return next
}
