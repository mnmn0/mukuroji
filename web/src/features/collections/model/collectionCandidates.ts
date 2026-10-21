import { isRecord } from '../../../shared/api/jsonValidation'

/** Work Item that can be added to a Collection. */
export type CollectionCandidate = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item identifier. */
  issueId: string
  /** Current title. */
  title: string
}

/**
 * Converts permission-filtered Workspace search results into Collection candidates.
 *
 * Work Item search results are identified as `team/<teamId>/issue/<issueId>`. The Team is
 * read from the result itself, so identifiers that contain `/` still split correctly;
 * any other result is skipped.
 *
 * @param results - Workspace search results; malformed entries are skipped.
 * @returns Work Items that can be offered for adding.
 */
export function toCollectionCandidates(results: readonly unknown[]): CollectionCandidate[] {
  const candidates: CollectionCandidate[] = []
  for (const result of results) {
    if (!isRecord(result) || result.entityType !== 'work-item') continue
    const { id, teamId, title } = result
    if (typeof id !== 'string' || typeof teamId !== 'string' || !teamId || typeof title !== 'string') continue
    const prefix = `team/${teamId}/issue/`
    if (!id.startsWith(prefix)) continue
    const issueId = id.slice(prefix.length)
    if (!issueId) continue
    candidates.push({ teamId, issueId, title })
  }
  return candidates
}

/**
 * Builds the key that identifies one Work Item reference.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @returns A key that cannot collide between different references.
 */
export function collectionCandidateKey(teamId: string, issueId: string): string {
  return JSON.stringify([teamId, issueId])
}
