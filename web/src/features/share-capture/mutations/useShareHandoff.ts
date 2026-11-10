import type { CreateManualTriageEntryInput, TriageMutationReceipt } from '@mukuroji/contracts'
import { useRef, useState } from 'react'
import {
  createMutationRequestContext,
  type MutationRequestContext,
} from '../../../shared/api/mutationHeaders'
import { isRecord } from '../../../shared/api/jsonValidation'
import { createTriageManualHandoff, TriageApiError } from '../../../triage/api'
import {
  createShareHandoffIdentity,
  createShareHandoffInput,
  type ShareHandoffDraft,
} from '../model/sharedContent'

/**
 * Why a handoff did not complete.
 *
 * - `forbidden`: the person may not send to that Team.
 * - `rejected`: the server refused the content.
 * - `uncertain`: the request may have been saved; only the same request may be sent again.
 * - `unsaved`: the replay state could not be kept on the device, so nothing was sent.
 */
export type ShareHandoffFailure = 'forbidden' | 'rejected' | 'uncertain' | 'unsaved'

/** A send that was attempted and must be retried unchanged until it succeeds. */
export type LockedShareHandoff = {
  /** Destination Team. */
  readonly teamId: string
  /** Title and body as sent. */
  readonly draft: ShareHandoffDraft
  /** Request body as sent, replayed byte for byte. */
  readonly input: CreateManualTriageEntryInput
  /** Idempotency key and correlation ID shared by every retry. */
  readonly context: MutationRequestContext
}

/** Result of a completed handoff. */
export type ShareHandoffResult = {
  /** Team whose queue holds the entry. */
  readonly teamId: string
  /** Created, or replayed, entry receipt. */
  readonly receipt: TriageMutationReceipt
}

/** Share handoff state and action exposed to the share page. */
export type ShareHandoffController = {
  /** Whether a send is in progress. */
  readonly isSubmitting: boolean
  /** Why the latest send did not complete. */
  readonly failure?: ShareHandoffFailure
  /** Send to retry unchanged, kept across reloads until it succeeds. */
  readonly locked?: LockedShareHandoff
  /**
   * Sends the content, or the locked send when one exists.
   *
   * @returns The result, or `undefined` when the send did not complete.
   */
  readonly submit: (teamId: string, draft: ShareHandoffDraft) => Promise<ShareHandoffResult | undefined>
  /** Ends the handoff without sending and deletes its stored attempt, for example on Cancel. */
  readonly abandon: () => void
}

/** Session storage operations used to keep an attempted send across reloads. */
export type ShareHandoffStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Dependencies of the share handoff mutation. */
export type UseShareHandoffOptions = {
  /** Access token for the Triage API. */
  readonly accessToken?: string
  /** Reports session failures to the Workspace session guard. */
  readonly guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Display name of the person sharing. */
  readonly requesterDisplayName: string
  /** Stored share ID; it keys the attempted send and becomes the handoff's source ID. */
  readonly handoffKey: string
  /**
   * Identifies the signed-in account, so an attempt made in one Workspace or by one person is
   * never restored and replayed after another account signs in on the same tab.
   */
  readonly accountKey: string
  /**
   * When the worker received the stored share, in epoch milliseconds; it fixes the fallback
   * retention so every tab sends the same handoff.
   */
  readonly receivedAt?: number
  /** Storage for the attempted send; defaults to the tab's session storage. */
  readonly storage?: ShareHandoffStorage
}

/** Prefix of the session storage keys holding attempted sends. */
const attemptStorageKeyPrefix = 'mukuroji.shareHandoff:'

/**
 * Classifies a failed handoff by whether an entry may have been created.
 *
 * @param error - Error thrown by the send.
 * @returns `forbidden` or `rejected` when the server refused it, otherwise `uncertain`.
 */
export function classifyShareHandoffFailure(error: unknown): ShareHandoffFailure {
  if (!(error instanceof TriageApiError)) return 'uncertain'
  if (error.status === 401 || error.status === 403) return 'forbidden'
  if (error.status === 400 || error.status === 404 || error.status === 413 || error.status === 422) return 'rejected'
  return 'uncertain'
}

/**
 * Decides what to do with an attempted send after it failed.
 *
 * @param wasLocked - Whether the failed request was a retry of an earlier attempt.
 * @param failure - Why it failed.
 * @returns `lock` to allow only the same request again, or `forget` when nothing was created.
 */
export function resolveFailedAttempt(wasLocked: boolean, failure: ShareHandoffFailure): 'lock' | 'forget' {
  // A retry of a send that may already be saved stays locked, whatever the server says now.
  return wasLocked || failure === 'uncertain' ? 'lock' : 'forget'
}

/**
 * Returns the tab's session storage, when the browser allows it.
 *
 * @returns Session storage, or `undefined` when it is unavailable.
 */
function readPageStorage(): ShareHandoffStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

/**
 * Reads a string field from a parsed record.
 *
 * @param record - Parsed record.
 * @param key - Field name.
 * @returns The string, or `undefined` when it is missing or not a string.
 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Validates a stored attempted send.
 *
 * @param value - Parsed storage value.
 * @returns The attempted send, or `undefined` when the value is not one.
 */
export function readLockedShareHandoff(value: unknown): LockedShareHandoff | undefined {
  if (!isRecord(value) || !isRecord(value.draft) || !isRecord(value.input) || !isRecord(value.context)) {
    return undefined
  }
  const teamId = readString(value, 'teamId')
  const title = readString(value.draft, 'title')
  const body = readString(value.draft, 'body')
  const idempotencyKey = readString(value.context, 'idempotencyKey')
  const correlationId = readString(value.context, 'correlationId')
  const sourceId = readString(value.input, 'sourceId')
  const inputTitle = readString(value.input, 'title')
  const inputBody = readString(value.input, 'body')
  const requesterDisplayName = readString(value.input, 'requesterDisplayName')
  const routingReason = readString(value.input, 'routingReason')
  const retentionExpiresAt = readString(value.input, 'retentionExpiresAt')
  if (
    !teamId || title === undefined || body === undefined || !idempotencyKey || !correlationId ||
    !sourceId || inputTitle === undefined || inputBody === undefined ||
    requesterDisplayName === undefined || routingReason === undefined || !retentionExpiresAt
  ) return undefined
  return {
    teamId,
    draft: { title, body },
    input: { sourceId, title: inputTitle, body: inputBody, requesterDisplayName, routingReason, retentionExpiresAt },
    context: { idempotencyKey, correlationId },
  }
}

/**
 * Loads the attempted send stored for a share.
 *
 * @param storage - Session storage.
 * @param key - Storage key of the share.
 * @returns The attempted send, or `undefined` when none is stored.
 */
function loadAttempt(storage: ShareHandoffStorage | undefined, key: string): LockedShareHandoff | undefined {
  try {
    const value = storage?.getItem(key)
    return value ? readLockedShareHandoff(JSON.parse(value)) : undefined
  } catch {
    return undefined
  }
}

/**
 * Sends confirmed share content to a Team Triage queue as a manual handoff.
 *
 * The exact request and its idempotency key are saved to session storage before the first
 * send. From then on only that request can be sent, across retries, reloads, and app
 * updates, until it succeeds, so a saved entry is replayed rather than duplicated. A first
 * send the server refused created nothing, so it is forgotten and the form can be edited.
 *
 * @param options - Access token, session guard, requester name, share key, account key, and receive time.
 * @returns The handoff state and send action.
 */
export function useShareHandoff({
  accessToken,
  guardEnterpriseSession,
  requesterDisplayName,
  handoffKey,
  accountKey,
  receivedAt,
  storage = readPageStorage(),
}: UseShareHandoffOptions): ShareHandoffController {
  const storageKey = `${attemptStorageKeyPrefix}${encodeURIComponent(accountKey)}:${handoffKey}`
  const [locked, setLocked] = useState(() => loadAttempt(storage, storageKey))
  const [failure, setFailure] = useState<ShareHandoffFailure | undefined>(() => (locked ? 'uncertain' : undefined))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const inFlightRef = useRef(false)

  /**
   * Sends the content, or the locked send when one exists.
   *
   * @param teamId - Destination Team chosen in the form.
   * @param draft - Title and body confirmed in the form.
   * @returns The result, or `undefined` when the send did not complete.
   */
  async function submit(teamId: string, draft: ShareHandoffDraft): Promise<ShareHandoffResult | undefined> {
    if (!accessToken || inFlightRef.current) return undefined
    const wasLocked = locked !== undefined
    const attempt = locked ?? {
      teamId,
      draft,
      input: createShareHandoffInput(draft, createShareHandoffIdentity(handoffKey, receivedAt === undefined ? undefined : new Date(receivedAt)), requesterDisplayName),
      context: createMutationRequestContext(),
    }
    if (!wasLocked && !save(attempt)) {
      // Without a stored replay state, a reload after a lost response could send a duplicate.
      setFailure('unsaved')
      return undefined
    }
    inFlightRef.current = true
    setIsSubmitting(true)
    setFailure(undefined)
    try {
      const receipt = await guardEnterpriseSession(
        createTriageManualHandoff(attempt.teamId, attempt.input, accessToken, attempt.context),
      )
      forget()
      setLocked(undefined)
      return { teamId: attempt.teamId, receipt }
    } catch (error: unknown) {
      const nextFailure = classifyShareHandoffFailure(error)
      if (resolveFailedAttempt(wasLocked, nextFailure) === 'lock') {
        setLocked(attempt)
      } else {
        forget()
      }
      setFailure(nextFailure)
      return undefined
    } finally {
      inFlightRef.current = false
      setIsSubmitting(false)
    }
  }

  /**
   * Stores an attempted send before it is sent.
   *
   * @param attempt - Send to keep for replay.
   * @returns Whether it was stored.
   */
  function save(attempt: LockedShareHandoff): boolean {
    try {
      if (!storage) return false
      storage.setItem(storageKey, JSON.stringify(attempt))
      return true
    } catch {
      return false
    }
  }

  /** Removes the attempted send from session storage. */
  function forget() {
    try {
      storage?.removeItem(storageKey)
    } catch {
      // A stale entry only locks the same share's form; nothing else reads it.
    }
  }

  /** Ends the handoff without sending and deletes its stored attempt. */
  function abandon() {
    forget()
    setLocked(undefined)
    setFailure(undefined)
  }

  return {
    isSubmitting,
    ...(failure ? { failure } : {}),
    ...(locked ? { locked } : {}),
    submit,
    abandon,
  }
}
