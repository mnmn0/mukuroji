import type { UpdateFeedDigestState } from '@mukuroji/contracts'
import { PlanningError } from '../../planning'
import { previewUpdateFeedDigest, type UpdateFeedDigestStore } from './digest'
import type { UpdateFeedReader } from './read-update-feed'
import type { UpdateFeedReadStateStore } from './read-state'

/** Server-resolved recipient, never taken from a notification destination field. */
export type InboxDigestRecipient = {
  /** Current Workspace identity. */
  workspaceId: string
  /** Current normalized member identity. */
  memberKey: string
}

/** Content-free Inbox message; opening the Feed performs current authorization again. */
export type InboxDigestMessage = {
  /** Deterministic recipient-scoped interval identity. */
  id: string
  /** First claim time, stable across retries and response loss. */
  occurredAt: string
  /** Existing authenticated Feed route, with no cached report identifiers or bodies. */
  deepLink: '/updates'
}

/** Separate opt-in delivery metadata; manual preview preferences must never be used here. */
export interface InboxDigestStore extends UpdateFeedDigestStore {
  /** Commits completion and optional Inbox insertion in ONE transaction.
   * Must guard the observed digest revision, current recipient membership/ACL,
   * Planning revision, current in-app preference and deterministic notification key.
   * Existing Inbox read/archive fields must never be overwritten on retry.
   * @param recipient - Server-resolved owner.
   * @param state - Completed metadata carrying the observed claim revision.
   * @param planningRevision - Current content authorization fence.
   * @param message - Bodyless notification, absent for an empty digest.
   * @param savedFeedsRevision - Confirmed owner collection revision for custom sources,
   * transactionally fenced with completion; omitted for standard-only selections.
   * @returns Committed incremented metadata; failure must leave both rows unchanged.
   */
  complete(recipient: InboxDigestRecipient, state: UpdateFeedDigestState, planningRevision: number, message: InboxDigestMessage | undefined, savedFeedsRevision?: number): Promise<UpdateFeedDigestState>
}

/** Fresh recipient authorization and existing Feed/read-state ports. */
export type InboxDigestContext = {
  /** Identity bound by the authorization resolver to every returned port. */
  recipient: InboxDigestRecipient
  /** Planning fence read before resolving recipient ACL; snapshot changes must reject. */
  authorizationRevision: number
  /** Current recipient-bound Feed reader; never a system-admin substitute. */
  reader: UpdateFeedReader
  /** Current personal read-state port. */
  readState: UpdateFeedReadStateStore
  /** Separate recipient-bound delivery store, including transactional authorization guards. */
  store: InboxDigestStore
}

/** Bounded scheduler dependencies; no live worker is connected by this module. */
export type InboxDigestDependencies = {
  /** Resolves membership, planning.read and in-app opt-in now; denial returns undefined.
   * Infrastructure failures throw. Returned write guards must fence later revocation.
   */
  authorize(recipient: InboxDigestRecipient): Promise<InboxDigestContext | undefined>
}

/** Safe per-recipient result, with no report content or identity in logs. */
export type InboxDigestOutcome = 'disabled' | 'denied' | 'not-due' | 'delivered' | 'empty'

/** Calculates a UTC day or Monday week key, shared by due selection and generation.
 * @param state - Current validated delivery settings.
 * @param now - Scheduler clock, not an untrusted event timestamp.
 * @returns Frequency-qualified interval key.
 */
export function inboxDigestInterval(state: UpdateFeedDigestState, now: number): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error('Invalid digest clock')
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  if (state.preferences.frequency === 'weekly') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7)
  return `${state.preferences.frequency}:${start.toISOString().slice(0, 10)}`
}

/** Generates a due digest and atomically commits a bodyless Inbox link and receipt.
 * Reuses bounded Feed authorization, final read-state filtering, deduplication,
 * fifty-entry cap, CAS, expiring leases and three-attempt limit from previews.
 * @param dependencies - Fresh recipient authorization.
 * @param recipient - Server-resolved delivery owner.
 * @param now - Trusted invocation clock.
 * @returns Safe outcome; transient failures propagate for scheduler retry.
 */
export async function deliverInboxDigest(dependencies: InboxDigestDependencies, recipient: InboxDigestRecipient, now: number): Promise<InboxDigestOutcome> {
  const context = await dependencies.authorize(recipient)
  if (!context) return 'denied'
  if (context.reader.memberKey !== recipient.memberKey || context.recipient.memberKey !== recipient.memberKey || context.recipient.workspaceId !== recipient.workspaceId) throw new PlanningError(502, 'UpdateFeedDigestRecipientMismatch', 'Digest recipient mismatch')
  let state = await context.store.get(recipient.workspaceId, recipient.memberKey)
  const id = inboxDigestInterval(state, now)
  if (!state.preferences.enabled) return 'disabled'
  // An old interval may still own a live claim across midnight/Monday. Reconcile
  // expired claims durably before selecting a new interval, including attempt three.
  if (state.history.some((item) => item.status === 'pending' && item.leaseUntil > now)) return 'not-due'
  if (state.history.some((item) => item.status === 'pending')) {
    state = await context.store.replace(recipient.workspaceId, recipient.memberKey, { ...state, history: state.history.map((item) => item.status === 'pending' ? { ...item, status: 'failed', leaseUntil: 0 } : item) })
  }
  const receipt = state.history.find((item) => item.id === id)
  if (receipt?.status === 'completed' || (receipt?.status === 'pending' && receipt.leaseUntil > now)) return 'not-due'
  // Reject clock rollback rather than re-emitting an interval pruned from history.
  if (state.history.some((item) => item.id.slice(item.id.indexOf(':') + 1) > new Date(now).toISOString().slice(0, 10))) return 'not-due'
  const store: UpdateFeedDigestStore = {
    get: async () => state,
    replace: (workspaceId, memberKey, next, planningRevision, savedFeedsRevision) => {
      if (planningRevision === undefined) return context.store.replace(workspaceId, memberKey, next, undefined, savedFeedsRevision)
      const completed = next.history.find((item) => item.id === id)
      if (completed?.status !== 'completed') throw new Error('Digest completion missing')
      const message: InboxDigestMessage | undefined = completed.count === 0 ? undefined : {
        id: `update-feed-digest:${id}`,
        occurredAt: new Date(completed.startedAt ?? now).toISOString(),
        deepLink: '/updates',
      }
      return context.store.complete(recipient, next, planningRevision, message, savedFeedsRevision)
    },
  }
  const reader: UpdateFeedReader = { ...context.reader, readSnapshot: async () => {
    const snapshot = await context.reader.readSnapshot()
    if (snapshot.revision !== context.authorizationRevision) throw new Error('Digest authorization changed')
    return snapshot
  } }
  const result = await previewUpdateFeedDigest(reader, context.readState, store, recipient.workspaceId, now)
  return result.entries.length === 0 ? 'empty' : 'delivered'
}

/** One bounded candidate page from a due index or explicitly configured recipient set. */
export type InboxDigestCandidatePage = {
  /** At most the requested number of server-resolved recipients. */
  recipients: InboxDigestRecipient[]
  /** Opaque continuation; present when more candidates remain. */
  cursor?: string
}

/** Controlled scheduler integration, disabled unless explicitly configured. */
export type InboxDigestSchedule = {
  /** Independent operator activation switch; defaults to absent/disabled in composition. */
  enabled: boolean
  /** Reads due candidates without scanning canonical updates or notification history. */
  listCandidates(cursor: string | undefined, limit: number, now: number): Promise<InboxDigestCandidatePage>
  /** Resolves fresh recipient authorization per candidate. */
  dependencies: InboxDigestDependencies
}

/** Safe bounded scheduler outcome; failed identities are retry inputs, not log text. */
export type InboxDigestScheduleResult = {
  /** Number of unique candidates inspected. */
  processed: number
  /** Number of new Inbox notifications committed. */
  delivered: number
  /** Failed candidates that must be retried separately from the continuation. */
  failed: InboxDigestRecipient[]
  /** Terminal candidates requiring inspection, never automatic retry. */
  terminal: { /** Server-resolved affected owner. */ recipient: InboxDigestRecipient; /** Stable bodyless diagnostic category. */ reason: 'exhausted' | 'corrupt-state' | 'storage-permanent' | 'recipient-mismatch' | 'invalid-input' }[]
  /** Next source checkpoint; must not discard failed candidates. */
  cursor?: string
}

/** Identifies failures that require inspection instead of automatic recipient retry.
 * @param error - Application-classified delivery failure.
 * @returns A stable bodyless terminal category, or undefined for retryable failures.
 */
export function inboxDigestTerminalReason(error: unknown): 'exhausted' | 'corrupt-state' | 'storage-permanent' | 'recipient-mismatch' | 'invalid-input' | undefined {
  if (!(error instanceof PlanningError)) return undefined
  if (error.code === 'UpdateFeedDigestAttemptsExhausted') return 'exhausted'
  if (error.code === 'UpdateFeedDigestRecipientMismatch') return 'recipient-mismatch'
  if (error.code === 'UpdateFeedDigestCorruptState') return 'corrupt-state'
  if (error.code === 'UpdateFeedDigestStoragePermanent') return 'storage-permanent'
  if (error.code === 'UpdateFeedDigestInvalid') return 'invalid-input'
  return undefined
}

/** Drains at most 100 recipients and reports continuation and failures explicitly.
 * @param schedule - Disabled-by-default scheduler configuration and ports.
 * @param now - Trusted invocation clock.
 * @param cursor - Opaque checkpoint for the next bounded invocation.
 * @returns Counts, retryable candidate failures and a continuation checkpoint.
 */
export async function runInboxDigestSchedule(schedule: InboxDigestSchedule, now: number, cursor?: string): Promise<InboxDigestScheduleResult> {
  const result: InboxDigestScheduleResult = { processed: 0, delivered: 0, failed: [], terminal: [] }
  if (!schedule.enabled) return result
  const page = await schedule.listCandidates(cursor, 100, now)
  if (page.recipients.length > 100 || (page.cursor !== undefined && (!page.cursor || page.cursor === cursor))) throw new Error('Invalid digest candidate page')
  const seen = new Set<string>()
  for (const recipient of page.recipients) {
    const key = JSON.stringify([recipient.workspaceId, recipient.memberKey])
    if (seen.has(key)) continue
    seen.add(key)
    result.processed++
    try {
      if (await deliverInboxDigest(schedule.dependencies, recipient, now) === 'delivered') result.delivered++
    } catch (error) {
      const reason = inboxDigestTerminalReason(error)
      if (reason) result.terminal.push({ recipient, reason })
      else result.failed.push(recipient)
    }
  }
  result.cursor = page.cursor
  return result
}
