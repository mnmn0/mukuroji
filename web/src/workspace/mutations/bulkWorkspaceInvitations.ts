import type { CreateWorkspaceInvitationInput } from '../api/invitations'

/** Outcome of one invitation of a bulk invitation. */
export type BulkInvitationOutcome =
  | {
      /** The invitation was created. */
      status: 'sent'
    }
  | {
      /** The API rejected the invitation or could not be reached. */
      status: 'failed'
      /** The error the request failed with. */
      error: unknown
    }

/** Invitations a bulk invitation sends at the same time. */
const bulkInvitationConcurrency = 3

/**
 * Sends invitations a few at a time and reports each outcome as it arrives. One failed
 * invitation does not stop the others.
 *
 * @param inputs - Invitations to send, in display order.
 * @param sendInvitation - Sends one invitation; rejects when it fails.
 * @param onOutcome - Called with the index of each invitation and its outcome.
 * @returns The outcome of every invitation, by index.
 */
export async function sendBulkWorkspaceInvitations(
  inputs: readonly CreateWorkspaceInvitationInput[],
  sendInvitation: (input: CreateWorkspaceInvitationInput) => Promise<void>,
  onOutcome?: (index: number, outcome: BulkInvitationOutcome) => void,
): Promise<BulkInvitationOutcome[]> {
  const outcomes: BulkInvitationOutcome[] = []
  let next = 0

  /** Takes the next unsent invitation until none are left. */
  const work = async () => {
    while (next < inputs.length) {
      const index = next
      next += 1
      let outcome: BulkInvitationOutcome
      try {
        await sendInvitation(inputs[index])
        outcome = { status: 'sent' }
      } catch (error) {
        outcome = { status: 'failed', error }
      }
      outcomes[index] = outcome
      onOutcome?.(index, outcome)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(bulkInvitationConcurrency, inputs.length) }, () => work()),
  )
  return outcomes
}
