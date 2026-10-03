import type { SetUpdateFeedReadStateInput, UpdateFeedEntry, UpdateFeedReadState, UpdateFeedResponse, UpdateFeedView } from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isPositiveSafeInteger, isRecord } from '../../../shared/api/jsonValidation'
import { isUpdateFeedView } from '../model/updateFeed'

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/$/, '')

/** Typed transport failure used by the shared session boundary. */
export class UpdateFeedApiError extends Error {
  /** HTTP status from the failed request. */
  readonly status: number
  /** Stable server error code for the shared session recovery boundary. */
  readonly code: string
  /** Creates a stable error without exposing untrusted server text.
   * @param status - HTTP failure status.
   * @param code - Stable server error category, without response message content.
   */
  constructor(status: number, code = 'UpdateFeedRequestFailed') {
    super('Unable to load or update the feed.')
    this.name = 'UpdateFeedApiError'
    this.status = status
    this.code = code
  }
}

/** Reads a validated, live feed for the selected standard view.
 * @param token - Session bearer token.
 * @param view - Standard server feed selector.
 * @param locale - Active UI language used for current target names.
 * @param feedId - Optional server-owned personal filter definition.
 * @returns Validated response in server-ranked order.
 */
export async function getUpdateFeed(token: string, view: UpdateFeedView, locale: 'ja' | 'en' = 'ja', feedId?: string): Promise<UpdateFeedResponse> {
  const value = await requestUpdateFeed(token, `?view=${view}&limit=100&locale=${locale}${feedId === undefined ? '' : `&feedId=${encodeURIComponent(feedId)}`}`)
  if (!isRecord(value) || !isUpdateFeedView(value.view) || value.view !== view || !isNonnegativeSafeInteger(value.revision) || !isNonnegativeSafeInteger(value.total) || typeof value.truncated !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 100 || !value.entries.every(isEntry)) throw new UpdateFeedApiError(502)
  return { view: value.view, revision: value.revision, total: value.total, truncated: value.truncated, entries: value.entries }
}

/** Persists an explicit read/unread choice for the displayed immutable report.
 * @param token - Session bearer token.
 * @param input - Qualified version, desired state, and expected state revision.
 * @returns Authoritative committed personal state.
 */
export async function setUpdateFeedReadState(token: string, input: SetUpdateFeedReadStateInput): Promise<UpdateFeedReadState> {
  const value = await requestUpdateFeed(token, '/read-state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
  if (!isReadState(value)) throw new UpdateFeedApiError(502)
  return value
}

/** Requests JSON with a session-scoped bearer token.
 * @param token - Current session bearer token.
 * @param suffix - Feature-owned route suffix.
 * @param init - Optional mutation request settings.
 * @returns Untrusted JSON for feature-specific boundary validation.
 */
export async function requestUpdateFeed(token: string, suffix: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBase}/planning/update-feed${suffix}`, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } })
  if (!response.ok) {
    const error: unknown = await response.json().catch(() => undefined)
    throw new UpdateFeedApiError(response.status, isRecord(error) && typeof error.code === 'string' ? error.code : undefined)
  }
  return response.json()
}

/** Validates the personal state revision from the server. */
function isReadState(value: unknown): value is UpdateFeedReadState {
  return isRecord(value) && typeof value.read === 'boolean' && isNonnegativeSafeInteger(value.revision)
}

/** Validates every field used by the view rather than asserting remote JSON. */
function isEntry(value: unknown): value is UpdateFeedEntry {
  if (!isRecord(value) || !isRecord(value.target) || typeof value.title !== 'string' ||
    !isHealth(value.health) || typeof value.updateState !== 'string' ||
    !['not-configured', 'missing', 'current', 'stale', 'overdue'].includes(value.updateState) ||
    !isNonnegativeSafeInteger(value.relevance) || !Array.isArray(value.reasons) ||
    !value.reasons.every((reason) => reason === 'update-owner' || reason === 'latest-author')) return false
  const target = value.target
  if (!(target.type === 'project' && typeof target.teamId === 'string' && target.teamId.length > 0 &&
    typeof target.projectId === 'string' && target.projectId.length > 0) &&
    !(target.type === 'initiative' && typeof target.entityId === 'string' && target.entityId.length > 0)) return false
  if (value.latestUpdate === undefined) return value.readState === undefined
  const latest = value.latestUpdate
  return isRecord(latest) && typeof latest.id === 'string' && isPositiveSafeInteger(latest.version) &&
    isHealth(latest.health) && typeof latest.risk === 'string' &&
    ['none', 'low', 'medium', 'high', 'critical'].includes(latest.risk) &&
    typeof latest.summary === 'string' && typeof latest.authorMemberKey === 'string' &&
    typeof latest.createdAt === 'string' && Number.isFinite(Date.parse(latest.createdAt)) &&
    typeof latest.coveredDueAt === 'string' && Number.isFinite(Date.parse(latest.coveredDueAt)) &&
    isRecord(latest.progressSnapshot) && typeof latest.progressSnapshot.percent === 'number' &&
    Number.isFinite(latest.progressSnapshot.percent) && latest.progressSnapshot.percent >= 0 &&
    latest.progressSnapshot.percent <= 100 && isNonnegativeSafeInteger(latest.progressSnapshot.linkedWorkItemCount) &&
    isReadState(value.readState)
}

/** Narrows independent reported health. */
function isHealth(value: unknown): boolean {
  return value === 'unknown' || value === 'on-track' || value === 'at-risk' || value === 'off-track'
}
