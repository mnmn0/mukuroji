import type { CreateManualTriageEntryInput, TriageMutationReceipt } from '@mukuroji/contracts'
import { useRef, useState } from 'react'
import {
  createMutationFingerprint,
  createMutationRequestRunner,
} from '../../../shared/api/mutationHeaders'
import { createTriageManualHandoff, TriageApiError } from '../../../triage/api'
import {
  createShareHandoffIdentity,
  createShareHandoffInput,
  type ShareHandoffDraft,
} from '../model/sharedContent'

/**
 * Why a handoff did not complete.
 *
 * - `forbidden`: the person may not send to that Team; nothing was created.
 * - `rejected`: the server refused the content; nothing was created.
 * - `uncertain`: the request may have been saved; only the same request may be sent again.
 */
export type ShareHandoffFailure = 'forbidden' | 'rejected' | 'uncertain'

/** A handoff whose outcome is unknown and that must be retried unchanged. */
export type LockedShareHandoff = {
  /** Destination Team. */
  readonly teamId: string
  /** Title and body as sent. */
  readonly draft: ShareHandoffDraft
  /** Request body as sent, replayed byte for byte. */
  readonly input: CreateManualTriageEntryInput
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
  /** Send to retry unchanged after an uncertain failure. */
  readonly locked?: LockedShareHandoff
  /**
   * Sends the content, or the locked send when one exists.
   *
   * @returns The result, or `undefined` when the send did not complete.
   */
  readonly submit: (teamId: string, draft: ShareHandoffDraft) => Promise<ShareHandoffResult | undefined>
}

/** Dependencies of the share handoff mutation. */
export type UseShareHandoffOptions = {
  /** Access token for the Triage API. */
  readonly accessToken?: string
  /** Reports session failures to the Workspace session guard. */
  readonly guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Display name of the person sharing. */
  readonly requesterDisplayName: string
}

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

/** Internal state of the share handoff mutation. */
type ShareHandoffState = {
  /** Whether a send is in progress. */
  readonly isSubmitting: boolean
  /** Why the latest send did not complete. */
  readonly failure?: ShareHandoffFailure
  /** Send to retry unchanged. */
  readonly locked?: LockedShareHandoff
}

/**
 * Sends confirmed share content to a Team Triage queue as a manual handoff.
 *
 * One handoff keeps its source ID and idempotency key across retries. When the outcome is
 * unknown, the exact request is locked and only it can be sent again, so a saved entry is
 * replayed instead of conflicting with a changed copy. A refused send starts a new handoff.
 *
 * @param options - Access token, session guard, and requester name.
 * @returns The handoff state and send action.
 */
export function useShareHandoff({
  accessToken,
  guardEnterpriseSession,
  requesterDisplayName,
}: UseShareHandoffOptions): ShareHandoffController {
  const [identity, setIdentity] = useState(() => createShareHandoffIdentity())
  const [runner, setRunner] = useState(() => createMutationRequestRunner())
  const [state, setState] = useState<ShareHandoffState>({ isSubmitting: false })
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
    const submission = state.locked ?? {
      teamId,
      draft,
      input: createShareHandoffInput(draft, identity, requesterDisplayName),
    }
    inFlightRef.current = true
    setState({ isSubmitting: true, ...(state.locked ? { locked: state.locked } : {}) })
    try {
      const fingerprint = await createMutationFingerprint(submission.teamId, JSON.stringify(submission.input))
      const receipt = await guardEnterpriseSession(runner.run(
        `triage:share:${identity.sourceId}`,
        fingerprint,
        (context) => createTriageManualHandoff(submission.teamId, submission.input, accessToken, context),
        (error) => classifyShareHandoffFailure(error) === 'uncertain',
      ))
      setState({ isSubmitting: false })
      return { teamId: submission.teamId, receipt }
    } catch (error: unknown) {
      const failure = classifyShareHandoffFailure(error)
      if (failure === 'uncertain') {
        setState({ isSubmitting: false, failure, locked: submission })
      } else {
        // Nothing was created, so a corrected send is a new handoff.
        setIdentity(createShareHandoffIdentity())
        setRunner(createMutationRequestRunner())
        setState({ isSubmitting: false, failure })
      }
      return undefined
    } finally {
      inFlightRef.current = false
    }
  }

  return {
    isSubmitting: state.isSubmitting,
    ...(state.failure ? { failure: state.failure } : {}),
    ...(state.locked ? { locked: state.locked } : {}),
    submit,
  }
}
