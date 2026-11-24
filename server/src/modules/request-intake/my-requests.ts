import type {
  MyRequest,
  MyRequestDetail,
  MyRequestWorkItem,
  RequestRequesterThread,
  RequestSubmission,
  RequestSubmissionStatus,
} from '@mukuroji/contracts'

/** Statuses after which the requester can no longer reply. */
const closedStatuses = new Set<RequestSubmissionStatus>(['rejected', 'duplicate', 'converted'])

/**
 * Returns the form title of a request in the locale it was sent in.
 *
 * @param submission - Request submission with its immutable form snapshot.
 * @returns The form title, falling back to the form's default locale.
 */
export function resolveRequestFormTitle(
  submission: Pick<RequestSubmission, 'formSnapshot' | 'locale'>,
): string {
  const definition = submission.formSnapshot.snapshot.definition
  const title = definition.title
  return title[submission.locale] ?? title[definition.defaultLocale] ?? title.ja ?? title.en ?? ''
}

/**
 * Builds what the requester sees of one of their requests. Internal triage data, such as the
 * routing target, triage owner, rejection reason, duplicate target, and answers, is left out.
 *
 * @param submission - Request submission read by the server.
 * @param workItem - Requester-safe view of the Work Item made from the request, if any.
 * @returns The requester's view of the request.
 */
export function createMyRequestView(
  submission: RequestSubmission,
  workItem?: MyRequestWorkItem,
): MyRequest {
  return {
    id: submission.id,
    receiptId: submission.receiptId,
    formTitle: resolveRequestFormTitle(submission),
    status: submission.status,
    awaitingReply: submission.status === 'needs-more-info',
    ...(workItem ? { workItem } : {}),
    submittedAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  }
}

/**
 * Builds one request with its conversation for the requester.
 *
 * @param submission - Request submission read by the server.
 * @param workItem - Requester-safe view of the Work Item made from the request, if any.
 * @returns The requester's view of the request and its thread.
 */
export function createMyRequestDetailView(
  submission: RequestSubmission,
  workItem?: MyRequestWorkItem,
): MyRequestDetail {
  return {
    ...createMyRequestView(submission, workItem),
    thread: createRequesterThreadView(submission),
  }
}

/**
 * Builds the requester's thread: team questions and requester replies, without internal events.
 *
 * @param submission - Request submission with its stored messages.
 * @returns Thread messages in time order and whether replies are accepted.
 */
export function createRequesterThreadView(
  submission: Pick<RequestSubmission, 'messages' | 'status' | 'updatedAt'>,
): RequestRequesterThread {
  return {
    status: closedStatuses.has(submission.status) ? 'closed' : 'open',
    messages: submission.messages.map((message) => ({
      id: message.id,
      direction: message.direction === 'requester' ? 'requester' : 'staff',
      body: message.body,
      createdAt: message.createdAt,
    })),
    updatedAt: submission.updatedAt,
  }
}
