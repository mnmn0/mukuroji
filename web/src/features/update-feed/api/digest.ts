import type { UpdateFeedDigestPreferences, UpdateFeedDigestPreview, UpdateFeedDigestReceipt, UpdateFeedDigestState } from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isRecord } from '../../../shared/api/jsonValidation'
import { isUpdateFeedView, updateFeedTargetKey } from '../model/updateFeed'
import { isEntry, requestUpdateFeed, UpdateFeedApiError } from './updateFeed'

/** Reads personal preview preferences and content-free history.
 * @param token - Current session.
 * @param signal - Cancellation when the ephemeral preview is discarded.
 * @returns Validated personal state.
 */
export async function getDigestState(token: string, signal?: AbortSignal): Promise<UpdateFeedDigestState> { return readState(await requestUpdateFeed(token, '/digest', { signal })) }

/** Reads delivery consent independently of preview preferences.
 * @param token - Current session.
 * @returns Validated delivery metadata.
 */
export async function getInboxDigestState(token: string): Promise<UpdateFeedDigestState> { return readState(await requestUpdateFeed(token, '/digest/inbox')) }

/** Saves explicit Inbox consent without activating a scheduler or sending content.
 * @param token - Current session.
 * @param expectedRevision - Observed settings revision.
 * @param preferences - Explicit consent and cadence.
 * @returns Committed delivery metadata.
 */
export async function saveInboxDigestPreferences(token: string, expectedRevision: number, preferences: UpdateFeedDigestPreferences): Promise<UpdateFeedDigestState> {
  return readState(await requestUpdateFeed(token, '/digest/inbox', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision, preferences }) }))
}

/** Saves manual preview preferences with optimistic concurrency.
 * @param token - Current session.
 * @param expectedRevision - Last observed personal revision.
 * @param preferences - Desired preview preferences, never a live schedule.
 * @returns Committed state.
 */
export async function saveDigestPreferences(token: string, expectedRevision: number, preferences: UpdateFeedDigestPreferences): Promise<UpdateFeedDigestState> {
  return readState(await requestUpdateFeed(token, '/digest', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision, preferences }) }))
}

/** Requests a fresh preview only through explicit user action.
 * @param token - Current session.
 * @param locale - Language for target labels.
 * @returns Ephemeral unread reports; no notification is sent.
 */
export async function generateDigestPreview(token: string, locale: 'ja' | 'en'): Promise<UpdateFeedDigestPreview> {
  const value = await requestUpdateFeed(token, `/digest/preview?locale=${locale}`, { method: 'POST' })
  if (!isRecord(value) || !interval(value.id) || typeof value.replay !== 'boolean' || value.transport !== 'preview' || typeof value.truncated !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 50 || !value.entries.every(isEntry) || value.entries.some((entry) => !entry.latestUpdate || entry.readState?.read !== false) || new Set(value.entries.map((entry) => updateFeedTargetKey(entry.target))).size !== value.entries.length) throw new UpdateFeedApiError(502)
  return { id: value.id, replay: value.replay, transport: 'preview', truncated: value.truncated, entries: value.entries }
}

/** Reconstructs metadata without retaining unknown server fields. */
function readState(value: unknown): UpdateFeedDigestState {
  if (!isRecord(value) || !isNonnegativeSafeInteger(value.revision) || !preferences(value.preferences) || !Array.isArray(value.history) || value.history.length > 20 || !value.history.every(receipt) || new Set(value.history.map((item) => item.id)).size !== value.history.length) throw new UpdateFeedApiError(502)
  return { revision: value.revision, preferences: { enabled: value.preferences.enabled, frequency: value.preferences.frequency, views: [...value.preferences.views] }, history: value.history.map(({ id, status, attempts, token, leaseUntil, count }) => ({ id, status, attempts, token, leaseUntil, count })) }
}
/** Narrows the bounded set of standard views supported by the preview API. */
function preferences(value: unknown): value is UpdateFeedDigestPreferences {
  return isRecord(value) && typeof value.enabled === 'boolean' && (value.frequency === 'daily' || value.frequency === 'weekly') && Array.isArray(value.views) && value.views.length > 0 && value.views.length <= 6 && value.views.every(isUpdateFeedView) && new Set(value.views).size === value.views.length
}
/** Validates content-free receipt fields before rendering. */
function receipt(value: unknown): value is UpdateFeedDigestReceipt {
  return isRecord(value) && interval(value.id) && (value.status === 'pending' || value.status === 'completed' || value.status === 'failed') && isNonnegativeSafeInteger(value.attempts) && value.attempts >= 1 && value.attempts <= 3 && typeof value.token === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(value.token) && isNonnegativeSafeInteger(value.leaseUntil) && isNonnegativeSafeInteger(value.count) && value.count <= 50
}
/** Validates the server's UTC calendar identity. */
function interval(value: unknown): value is string { return typeof value === 'string' && /^(daily|weekly):\d{4}-\d{2}-\d{2}$/.test(value) }
