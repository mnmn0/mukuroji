import type { PlanningHealth, PlanningUpdateState, ReplaceSavedUpdateFeedsInput, SavedUpdateFeed, SavedUpdateFeeds, UpdateFeedFilters } from '@mukuroji/contracts'
import { PlanningError } from '../../planning'
import { parseUpdateFeedQuery } from './read-update-feed'

/** Personal definition collection persistence, independent of canonical reports. */
export interface SavedUpdateFeedsStore {
  /** Reads one bounded member-owned collection.
   * @param workspaceId - Authenticated Workspace.
   * @param memberKey - Authenticated member.
   * @returns Saved definitions and their optimistic revision.
   */
  get(workspaceId: string, memberKey: string): Promise<SavedUpdateFeeds>
  /** Replaces one bounded collection with current caller and personal revision guards.
   * @param workspaceId - Authenticated Workspace.
   * @param memberKey - Authenticated member.
   * @param input - Validated desired collection.
   * @returns Committed personal collection.
   */
  replace(workspaceId: string, memberKey: string, input: ReplaceSavedUpdateFeedsInput): Promise<SavedUpdateFeeds>
}

/** Reconstructs a bounded personal collection from untrusted HTTP or persistence data.
 * @param value - Unknown desired collection.
 * @returns Validated definitions with no client-owned identity or storage keys.
 */
export function parseSavedUpdateFeeds(value: unknown): ReplaceSavedUpdateFeedsInput {
  if (!record(value) || typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || value.expectedRevision >= Number.MAX_SAFE_INTEGER || !Array.isArray(value.feeds) || value.feeds.length > 20) throw invalid()
  const feeds = value.feeds.map(readFeed)
  if (new Set(feeds.map((feed) => feed.id)).size !== feeds.length || new TextEncoder().encode(JSON.stringify(feeds)).length > 64_000) throw invalid()
  return { expectedRevision: value.expectedRevision, feeds }
}

/** Reconstructs a single bounded definition without retaining unknown fields. */
function readFeed(value: unknown): SavedUpdateFeed {
  if (!record(value) || !identifier(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 || !printable(value.name) || typeof value.view !== 'string' || !record(value.filters)) throw invalid()
  const filters = value.filters
  if (!Array.isArray(filters.projects) || filters.projects.length > 20) throw invalid()
  const projects = filters.projects.map((project: unknown) => {
    if (!record(project) || !identifier(project.teamId) || !identifier(project.projectId)) throw invalid()
    return { teamId: project.teamId, projectId: project.projectId }
  })
  if (new Set(projects.map((project) => JSON.stringify([project.teamId, project.projectId]))).size !== projects.length) throw invalid()
  const parsed: UpdateFeedFilters = {
    teamIds: readList(filters.teamIds, identifier), projects,
    portfolioIds: readList(filters.portfolioIds, identifier), initiativeIds: readList(filters.initiativeIds, identifier),
    health: readList(filters.health, health), updateStates: readList(filters.updateStates, updateState),
  }
  return { id: value.id, name: value.name.trim(), view: parseUpdateFeedQuery(value.view).view, filters: parsed }
}

/** Validates and deduplicates no values silently; duplicate alternatives are invalid. */
function readList<T extends string>(value: unknown, accepts: (candidate: unknown) => candidate is T): T[] {
  if (!Array.isArray(value) || value.length > 20 || !value.every(accepts) || new Set(value).size !== value.length) throw invalid()
  return [...value]
}

/** Validates one opaque logical identifier. */
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && printable(value) }
/** Rejects control characters while preserving ordinary Unicode labels. */
function printable(value: string) { return Array.from(value).every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127) }
/** Narrows a JSON object. */
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
/** Validates reported health separately from submission state. */
function health(value: unknown): value is PlanningHealth { return value === 'unknown' || value === 'on-track' || value === 'at-risk' || value === 'off-track' }
/** Validates current submission freshness. */
function updateState(value: unknown): value is PlanningUpdateState { return value === 'not-configured' || value === 'missing' || value === 'current' || value === 'overdue' || value === 'stale' }
/** Creates a stable boundary failure without reflecting untrusted values. */
function invalid() { return new PlanningError(400, 'SavedUpdateFeedsInvalid', 'Invalid saved feed collection or collection limit exceeded.') }
