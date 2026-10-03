import { randomUUID } from 'node:crypto'
import type { UpdateFeedDigestPreferences, UpdateFeedDigestPreview, UpdateFeedDigestReceipt, UpdateFeedDigestState } from '@mukuroji/contracts'
import { PlanningError } from '../../planning'
import { parseUpdateFeedQuery, readUpdateFeed, type UpdateFeedReader } from './read-update-feed'
import { updateFeedReportKey, withUpdateFeedReadState, type UpdateFeedReadStateStore } from './read-state'

/** Atomic member-scoped persistence for preferences, claims and bodyless receipts. */
export interface UpdateFeedDigestStore {
  /** Reads one current state.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member.
   * @returns Bounded validated state.
   */
  get(workspaceId: string, memberKey: string): Promise<UpdateFeedDigestState>
  /** Replaces the state only if its observed revision and caller guards still match.
   * @param workspaceId - Server-resolved Workspace.
   * @param memberKey - Authenticated member.
   * @param state - Desired state carrying the observed revision.
   * @param planningRevision - Optional revision spanning content authorization.
   * @returns Committed state with an incremented revision.
   */
  replace(workspaceId: string, memberKey: string, state: UpdateFeedDigestState, planningRevision?: number): Promise<UpdateFeedDigestState>
}

/** Creates disabled preview preferences without enabling any scheduler.
 * @returns An absent personal row.
 */
export function emptyDigestState(): UpdateFeedDigestState {
  return { revision: 0, preferences: { enabled: false, frequency: 'daily', views: ['for-me'] }, history: [] }
}

/** Validates personal preferences and discards unknown client identity fields.
 * @param value - Untrusted JSON or persisted preferences.
 * @returns Reconstructed bounded preferences.
 */
export function parseDigestPreferences(value: unknown): UpdateFeedDigestPreferences {
  if (!record(value) || typeof value.enabled !== 'boolean' || (value.frequency !== 'daily' && value.frequency !== 'weekly') || !Array.isArray(value.views) || value.views.length < 1 || value.views.length > 6) throw invalid()
  const order = ['for-me', 'recent', 'at-risk', 'missing', 'stale', 'overdue']
  const views = value.views.map((view: unknown) => {
    if (typeof view !== 'string' || !['for-me', 'recent', 'at-risk', 'missing', 'stale', 'overdue'].includes(view)) throw invalid()
    return parseUpdateFeedQuery(view).view
  })
  if (new Set(views).size !== views.length) throw invalid()
  return { enabled: value.enabled, frequency: value.frequency, views: views.sort((a, b) => order.indexOf(a) - order.indexOf(b)) }
}

/** Validates the complete bodyless row, failing closed on malformed persistence.
 * @param value - Untrusted state.
 * @returns Reconstructed content-free state.
 */
export function parseDigestState(value: unknown): UpdateFeedDigestState {
  if (!record(value) || !integer(value.revision) || value.revision >= Number.MAX_SAFE_INTEGER || !Array.isArray(value.history) || value.history.length > 20) throw invalid()
  const history: UpdateFeedDigestReceipt[] = value.history.map((row: unknown) => {
    if (!record(row) || typeof row.id !== 'string' || !/^(daily|weekly):\d{4}-\d{2}-\d{2}$/.test(row.id) || !['pending', 'completed', 'failed'].includes(String(row.status)) || !integer(row.attempts) || row.attempts < 1 || row.attempts > 3 || typeof row.token !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(row.token) || !integer(row.leaseUntil) || !integer(row.count) || row.count > 50) throw invalid()
    if (row.status !== 'pending' && row.status !== 'completed' && row.status !== 'failed') throw invalid()
    const date = row.id.slice(row.id.indexOf(':') + 1)
    const timestamp = Date.parse(`${date}T00:00:00.000Z`)
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw invalid()
    if (row.id.startsWith('weekly:') && new Date(timestamp).getUTCDay() !== 1) throw invalid()
    return { id: row.id, status: row.status, attempts: row.attempts, token: row.token, leaseUntil: row.leaseUntil, count: row.count }
  })
  if (new Set(history.map((row) => row.id)).size !== history.length) throw invalid()
  return { revision: value.revision, preferences: parseDigestPreferences(value.preferences), history }
}

/** Replaces preferences while preserving generation receipts and rejecting stale devices.
 * @param store - Caller-bound persistence.
 * @param workspaceId - Authenticated Workspace.
 * @param memberKey - Authenticated member.
 * @param value - Untrusted preference mutation.
 * @returns Committed preferences and receipts.
 */
export async function replaceDigestPreferences(store: UpdateFeedDigestStore, workspaceId: string, memberKey: string, value: unknown): Promise<UpdateFeedDigestState> {
  if (!record(value) || !integer(value.expectedRevision)) throw invalid()
  const preferences = parseDigestPreferences(value.preferences)
  const current = await store.get(workspaceId, memberKey)
  if (current.revision !== value.expectedRevision) throw conflict()
  return store.replace(workspaceId, memberKey, { ...current, preferences })
}

/** Generates only a manual preview using current Feed authorization and personal read state.
 * The calendar receipt is idempotent, but every replay recomputes authorized content.
 * @param reader - Fresh authenticated Feed reader, never a system bypass.
 * @param readState - Current member read-state port.
 * @param store - Caller-bound atomic digest persistence.
 * @param workspaceId - Authenticated Workspace.
 * @param now - Server clock; injectable for deterministic tests.
 * @returns Ephemeral content which is never persisted or sent.
 */
export async function previewUpdateFeedDigest(reader: UpdateFeedReader, readState: UpdateFeedReadStateStore, store: UpdateFeedDigestStore, workspaceId: string, now = Date.now()): Promise<UpdateFeedDigestPreview> {
  if (!integer(now) || now > 8_640_000_000_000_000) throw invalid()
  const memberKey = reader.memberKey
  let state = await store.get(workspaceId, memberKey)
  if (!state.preferences.enabled) throw new PlanningError(409, 'UpdateFeedDigestDisabled', 'Enable manual digest previews first.')
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  if (state.preferences.frequency === 'weekly') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
  const id = `${state.preferences.frequency}:${start.toISOString().slice(0, 10)}`
  const existing = state.history.find((receipt) => receipt.id === id)
  const replay = existing?.status === 'completed'
  if (!replay && existing?.status === 'pending' && existing.leaseUntil > now) throw conflict()
  if (!replay && (existing?.attempts ?? 0) >= 3) throw new PlanningError(409, 'UpdateFeedDigestAttemptsExhausted', 'Digest preview retry limit reached for this interval.')
  const token = randomUUID()
  if (!replay) {
    const receipt: UpdateFeedDigestReceipt = { id, status: 'pending', attempts: (existing?.attempts ?? 0) + 1, token, leaseUntil: now + 60_000, count: 0 }
    state = await store.replace(workspaceId, memberKey, { ...state, history: [...state.history.filter((item) => item.id !== id), receipt].slice(-20) })
  }
  try {
    // A fresh projection is loaded for each attempt/replay; no historical report scan.
    const initialSnapshot = await reader.readSnapshot()
    const stableReader: UpdateFeedReader = { ...reader, readSnapshot: async () => initialSnapshot }
    const entries = new Map<string, UpdateFeedDigestPreview['entries'][number]>()
    let truncated = false
    for (const view of parseDigestPreferences(state.preferences).views) {
      const feed = await readUpdateFeed(stableReader, view, '100')
      truncated ||= feed.truncated
      for (const entry of feed.entries) {
        if (!entry.latestUpdate) continue
        const key = updateFeedReportKey({ target: entry.target, version: entry.latestUpdate.version })
        if (!entries.has(key)) entries.set(key, entry)
      }
    }
    // Recheck every selected report after all views finish, including read-state changes.
    const snapshot = await reader.readSnapshot()
    if (snapshot.revision !== initialSnapshot.revision) throw conflict()
    const current = new Map(snapshot.updateTargets.map((target) => [updateFeedReportKey({ target: target.target, version: target.latestVersion }), target]))
    for (const [key, entry] of entries) {
      const candidate = current.get(key)
      const authorized = candidate && !candidate.archivedAt ? await reader.authorizeTarget(candidate, snapshot) : undefined
      if (!authorized?.latestUpdate || authorized.latestUpdate.version !== entry.latestUpdate?.version) entries.delete(key)
    }
    const selected: UpdateFeedDigestPreview['entries'] = []
    const candidates = [...entries.values()]
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const batch = candidates.slice(offset, offset + 100)
      const checked = await withUpdateFeedReadState(readState, workspaceId, memberKey, { view: 'recent', revision: snapshot.revision, entries: batch, total: batch.length, truncated: false })
      selected.push(...checked.entries.filter((entry) => !entry.readState?.read))
    }
    const result: UpdateFeedDigestPreview = { id, replay, entries: selected.slice(0, 50), truncated: truncated || selected.length > 50, transport: 'preview' }
    if (!replay) {
      await store.replace(workspaceId, memberKey, { ...state, history: state.history.map((receipt) => receipt.id === id && receipt.token === token ? { ...receipt, status: 'completed', leaseUntil: 0, count: result.entries.length } : receipt) }, snapshot.revision)
    } else {
      // A concurrent preference change invalidates even a bodyless receipt replay.
      await store.replace(workspaceId, memberKey, state, snapshot.revision)
    }
    return result
  } catch (error) {
    if (!replay) {
      // Preserve the original error; a failed release leaves a bounded expiring lease.
      try { await store.replace(workspaceId, memberKey, { ...state, history: state.history.map((receipt) => receipt.id === id && receipt.token === token ? { ...receipt, status: 'failed', leaseUntil: 0 } : receipt) }) } catch { /* CAS fences superseded attempts. */ }
    }
    throw error
  }
}

/** Narrows an untrusted object without assertions. */
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
/** Accepts finite nonnegative safe integers. */
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
/** Creates a nonreflective validation failure. */
function invalid() { return new PlanningError(400, 'UpdateFeedDigestInvalid', 'Invalid digest preferences or state.') }
/** Creates a stable optimistic concurrency failure. */
function conflict() { return new PlanningError(409, 'UpdateFeedDigestConflict', 'Digest state changed or generation is already running.') }
