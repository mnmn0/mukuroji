/** State used to fence delayed AI callbacks to their originating submission. */
export type RequestAiOperationFence = {
  /** Submission whose AI operation currently owns the queue fence. */
  ownerSubmissionId?: string
  /** Whether the owning submission currently has an AI operation in flight. */
  pending: boolean
}

/**
 * Returns whether an AI operation should disable controls for one submission.
 *
 * @param fence - Current queue-level operation state.
 * @param submissionId - Submission whose controls are being rendered.
 * @returns Whether the submission owns the active queue fence.
 */
export function isRequestAiOperationPendingForSubmission(
  fence: RequestAiOperationFence,
  submissionId: string | undefined,
): boolean {
  return fence.pending && fence.ownerSubmissionId === submissionId
}

/**
 * Applies one delayed AI operation notification if it still belongs to the selected submission.
 *
 * @param fence - Current queue-level operation state.
 * @param selectedSubmissionId - Submission currently selected by the queue.
 * @param sourceSubmissionId - Submission that emitted the notification.
 * @param pending - Whether that submission still has an operation in flight.
 * @returns The next fence state, or undefined when the notification is stale.
 */
export function updateRequestAiOperationFence(
  fence: RequestAiOperationFence,
  selectedSubmissionId: string | undefined,
  sourceSubmissionId: string,
  pending: boolean,
): RequestAiOperationFence | undefined {
  if (selectedSubmissionId !== sourceSubmissionId) return undefined
  if (pending) {
    return { ownerSubmissionId: sourceSubmissionId, pending: true }
  }
  if (fence.ownerSubmissionId !== sourceSubmissionId) return undefined
  return { ownerSubmissionId: undefined, pending: false }
}
