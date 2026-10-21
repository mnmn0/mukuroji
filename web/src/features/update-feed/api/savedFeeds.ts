import type { ReplaceSavedUpdateFeedsInput, SavedUpdateFeed, SavedUpdateFeeds, UpdateFeedFilterOptions, UpdateFeedFilters, UpdateFeedNamedOption } from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isRecord } from '../../../shared/api/jsonValidation'
import { isUpdateFeedView } from '../model/updateFeed'
import { requestUpdateFeed, UpdateFeedApiError } from './updateFeed'

/** Loads the authenticated member's validated definitions.
 * @param token - Current session.
 * @returns Bounded personal collection.
 */
export async function getSavedUpdateFeeds(token: string): Promise<SavedUpdateFeeds> { return readCollection(await requestUpdateFeed(token, '/saved')) }
/** Replaces a member-owned collection using server-enforced optimistic concurrency.
 * @param token - Current session.
 * @param input - Desired collection and observed revision.
 * @returns Committed collection.
 */
export async function replaceSavedUpdateFeeds(token: string, input: ReplaceSavedUpdateFeedsInput): Promise<SavedUpdateFeeds> { return readCollection(await requestUpdateFeed(token, '/saved', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })) }
/** Loads only currently readable filter labels when the editor is opened.
 * @param token - Current session.
 * @param locale - Active label language.
 * @returns Validated selector metadata without report content.
 */
export async function getUpdateFeedFilterOptions(token: string, locale: 'ja' | 'en'): Promise<UpdateFeedFilterOptions> {
  const value = await requestUpdateFeed(token, `/options?locale=${locale}`)
  if (!isRecord(value) || !namedOptions(value.teams) || !namedOptions(value.portfolios) || !namedOptions(value.initiatives) || !Array.isArray(value.projects) || value.projects.length > 2000 || !value.projects.every(namedProject) || new Set(value.projects.map((item) => JSON.stringify([item.teamId, item.projectId]))).size !== value.projects.length) throw new UpdateFeedApiError(502)
  return { teams: value.teams, projects: value.projects, portfolios: value.portfolios, initiatives: value.initiatives }
}
/** Validates every persisted selector before it reaches rendering or mutation state. */
function readCollection(value: unknown): SavedUpdateFeeds {
  if (!isRecord(value) || !isNonnegativeSafeInteger(value.revision) || !Array.isArray(value.feeds) || value.feeds.length > 20 || !value.feeds.every(savedFeed) || new Set(value.feeds.map((feed) => feed.id)).size !== value.feeds.length || new TextEncoder().encode(JSON.stringify(value.feeds)).length > 64_000) throw new UpdateFeedApiError(502)
  return { revision: value.revision, feeds: value.feeds }
}
/** Narrows one bounded saved definition at the transport boundary. */
function savedFeed(value: unknown): value is SavedUpdateFeed {
  return isRecord(value) && identifier(value.id) && identifier(value.name) && value.name.length <= 80 && isUpdateFeedView(value.view) && filters(value.filters)
}
/** Validates independent scope, health and freshness dimensions. */
function filters(value: unknown): value is UpdateFeedFilters {
  return isRecord(value) && identifiers(value.teamIds) && identifiers(value.portfolioIds) && identifiers(value.initiativeIds) && Array.isArray(value.projects) && value.projects.length <= 20 && value.projects.every(project) && new Set(value.projects.map((item) => JSON.stringify([item.teamId, item.projectId]))).size === value.projects.length &&
    Array.isArray(value.health) && value.health.every((item) => item === 'unknown' || item === 'on-track' || item === 'at-risk' || item === 'off-track') && new Set(value.health).size === value.health.length &&
    Array.isArray(value.updateStates) && value.updateStates.every((item) => item === 'not-configured' || item === 'missing' || item === 'current' || item === 'overdue' || item === 'stale') && new Set(value.updateStates).size === value.updateStates.length
}
/** Validates a bounded list of unique opaque identifiers. */
function identifiers(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 20 && value.every(identifier) && new Set(value).size === value.length }
/** Validates a logical identifier without accepting control characters. */
function identifier(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 512 && value.trim() === value && Array.from(value).every((character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127) }
/** Validates a qualified Project selector. */
function project(value: unknown): value is { /** Owning Team. */ teamId: string; /** Project identifier. */ projectId: string } { return isRecord(value) && identifier(value.teamId) && identifier(value.projectId) }
/** Validates a labeled Project option. */
function namedProject(value: unknown): value is UpdateFeedFilterOptions['projects'][number] { return project(value) && 'name' in value && typeof value.name === 'string' }
/** Validates bounded current option metadata. */
function namedOptions(value: unknown): value is UpdateFeedNamedOption[] { return Array.isArray(value) && value.length <= 2000 && value.every((item) => isRecord(item) && identifier(item.id) && typeof item.name === 'string') && new Set(value.map((item) => item.id)).size === value.length }
