import type { PlanningSnapshot, PlanningUpdateTargetSummary, UpdateFeedEntry, UpdateFeedResponse, UpdateFeedView } from '@mukuroji/contracts'
import { PlanningError } from '../../planning'

/** Request-scoped ports bound to an authenticated Workspace principal. */
export interface UpdateFeedReader {
  /** Current member identity, resolved by the server. */
  memberKey: string
  /** Resolves an authorized target name from current directory/Planning data.
   * @param target - Currently authorized target projection.
   * @param snapshot - Current graph containing Initiative titles.
   * @returns Current target display name.
   */
  describeTarget?(target: PlanningUpdateTargetSummary, snapshot: PlanningSnapshot): string
  /** Reads the bounded Planning graph, never update history or annotations.
   * @returns Current bounded graph for the authenticated Workspace.
   */
  readSnapshot(): Promise<PlanningSnapshot>
  /** Authorizes a current target and redacts inaccessible latest content; infrastructure errors propagate.
   * @param target - Candidate latest-target projection.
   * @param snapshot - Current bounded graph for resolving Initiative scope.
   * @returns Authorized target with unreadable content removed, or undefined for a denied target.
   */
  authorizeTarget(target: PlanningUpdateTargetSummary, snapshot: PlanningSnapshot): Promise<PlanningUpdateTargetSummary | undefined>
}

/**
 * Reads a bounded aggregate using current authorization on every request.
 * @param reader - Principal-bound snapshot and authorization ports.
 * @param viewInput - Untrusted standard view; defaults to recent.
 * @param limitInput - Untrusted decimal response limit from 1 through 100.
 * @returns Authorized latest-target entries with explicit truncation and ranking reasons.
 */
export async function readUpdateFeed(
  reader: UpdateFeedReader,
  viewInput?: string,
  limitInput?: string,
): Promise<UpdateFeedResponse> {
  const { view, limit } = parseUpdateFeedQuery(viewInput, limitInput)
  const snapshot = await reader.readSnapshot()
  if (snapshot.updateTargets.length > 2000) {
    throw new PlanningError(413, 'UpdateFeedTargetLimitExceeded', 'Feed target projection exceeds its bounded read limit.')
  }
  const identities = new Set<string>()
  for (const candidate of snapshot.updateTargets) {
    const key = targetKey(candidate)
    if (identities.has(key)) {
      throw new PlanningError(409, 'UpdateFeedDuplicateTarget', 'Feed projection contains duplicate target identities.')
    }
    identities.add(key)
  }
  const entries = new Map<string, UpdateFeedEntry>()
  for (const candidate of snapshot.updateTargets) {
    if (candidate.archivedAt) continue
    const summary = await reader.authorizeTarget(candidate, snapshot)
    if (!summary) continue
    const reasons: UpdateFeedEntry['reasons'] = []
    const memberKey = reader.memberKey.trim().toLowerCase()
    if (summary.cadence?.updateOwnerMemberKey.toLowerCase() === memberKey) reasons.push('update-owner')
    if (summary.latestUpdate?.authorMemberKey.toLowerCase() === memberKey) reasons.push('latest-author')
    const latest = summary.latestUpdate
    const entry: UpdateFeedEntry = {
      title: reader.describeTarget?.(summary, snapshot) ?? (summary.target.type === 'project' ? summary.target.projectId : summary.target.entityId),
      target: summary.target,
      health: latest?.health ?? 'unknown',
      updateState: summary.updateState,
      ...(latest ? { latestUpdate: {
        id: latest.id, version: latest.version, health: latest.health, risk: latest.risk,
        summary: latest.summary, progressSnapshot: latest.progressSnapshot,
        authorMemberKey: latest.authorMemberKey, coveredDueAt: latest.coveredDueAt,
        createdAt: latest.createdAt,
      } } : {}),
      reasons,
      relevance: (reasons.includes('update-owner') ? 2 : 0) + (reasons.includes('latest-author') ? 1 : 0),
    }
    if (!matchesView(entry, view)) continue
    const key = targetKey(entry)
    entries.set(key, entry)
  }
  const ranked = [...entries.values()].sort((a, b) =>
    (view === 'for-me' ? b.relevance - a.relevance : 0) ||
    compareText(b.latestUpdate?.createdAt ?? '', a.latestUpdate?.createdAt ?? '') ||
    compareText(targetKey(a), targetKey(b)),
  )
  return { view, revision: snapshot.revision, entries: ranked.slice(0, limit), total: ranked.length, truncated: ranked.length > limit }
}

/**
 * Validates HTTP selectors before constructing storage-backed authorization ports.
 * @param viewInput - Optional untrusted standard view; defaults to recent.
 * @param limitInput - Optional untrusted decimal limit; defaults to 50.
 * @returns A supported view and an integer response limit between 1 and 100.
 */
export function parseUpdateFeedQuery(viewInput?: string, limitInput?: string) {
  const view = readView(viewInput)
  const limit = limitInput === undefined ? 50 : Number(limitInput)
  if ((limitInput !== undefined && !/^[1-9][0-9]*$/.test(limitInput)) || !Number.isSafeInteger(limit) || limit > 100) {
    throw new PlanningError(400, 'UpdateFeedLimitInvalid', 'Feed limit must be an integer from 1 to 100.')
  }
  return { view, limit }
}

/** Validates a standard feed discriminator before any storage reads. */
function readView(value: string | undefined): UpdateFeedView {
  if (value === undefined) return 'recent'
  if (value === 'for-me' || value === 'recent' || value === 'at-risk' || value === 'missing' || value === 'stale' || value === 'overdue') return value
  throw new PlanningError(400, 'UpdateFeedViewInvalid', 'Unknown update feed view.')
}

/** Applies independent health, submission, and relevance predicates. */
function matchesView(entry: UpdateFeedEntry, view: UpdateFeedView): boolean {
  if (view === 'recent') return entry.latestUpdate !== undefined
  if (view === 'for-me') return entry.relevance > 0
  if (view === 'at-risk') return entry.health === 'at-risk' || entry.health === 'off-track'
  return entry.updateState === view
}

/** Creates an unambiguous identity without exposing physical storage keys. */
function targetKey(entry: Pick<UpdateFeedEntry, 'target'>): string {
  const target = entry.target
  return JSON.stringify(target.type === 'project' ? ['project', target.teamId, target.projectId] : ['initiative', target.entityId])
}

/** Compares stable text without locale-dependent ordering. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
