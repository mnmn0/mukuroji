import type {
  MyRequest,
  MyRequestDetail,
  MyRequestPage,
  MyRequestWorkItem,
  RequestRequesterReplyInput,
  RequestRequesterReplyReceipt,
  RequestRequesterThread,
  RequestRequesterThreadMessage,
  RequestSubmissionStatus,
  WorkflowStatusCategory,
} from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { readRecord } from '../../shared/api/jsonValidation'
import { resolveApiBaseUrl } from '../../shared/api/apiBaseUrl'
import { RequestIntakeApiError } from './errors'

const requestsApiBaseUrl = resolveApiBaseUrl()

const submissionStatuses: readonly RequestSubmissionStatus[] = [
  'received', 'triaging', 'needs-more-info', 'rejected', 'duplicate', 'converted',
]
const statusCategories: readonly WorkflowStatusCategory[] = [
  'backlog', 'unstarted', 'started', 'completed', 'canceled',
]

/** Page options for the signed-in member's own requests. */
export type GetMyRequestsOptions = {
  /** Opaque cursor returned with the previous page. */
  cursor?: string
  /** Largest number of requests on one page. */
  limit?: number
}

/**
 * Lists the requests the signed-in member sent, newest first.
 *
 * @param accessToken - Workspace access token.
 * @param options - Page size and cursor.
 * @returns One page of the member's requests.
 */
export async function getMyRequests(accessToken: string, options: GetMyRequestsOptions = {}): Promise<MyRequestPage> {
  const query = new URLSearchParams()
  if (options.cursor) query.set('cursor', options.cursor)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const data = await requestJson(`${requestsApiBaseUrl}/my-requests${query.size ? `?${query}` : ''}`, accessToken)
  const record = readRecord(data)
  if (!Array.isArray(record.requests)) throw new RequestIntakeApiError(502, 'The request list response is invalid.')
  const requests = record.requests.flatMap((entry) => readMyRequest(entry) ?? [])
  return {
    requests,
    ...(typeof record.nextCursor === 'string' && record.nextCursor ? { nextCursor: record.nextCursor } : {}),
  }
}

/**
 * Reads one of the signed-in member's requests with its conversation.
 *
 * @param accessToken - Workspace access token.
 * @param requestId - Request submission ID.
 * @returns The request and its thread.
 */
export async function getMyRequest(accessToken: string, requestId: string): Promise<MyRequestDetail> {
  const data = await requestJson(`${requestsApiBaseUrl}/my-requests/${encodeURIComponent(requestId)}`, accessToken)
  const request = readMyRequest(data)
  const thread = readThread(readRecord(data).thread)
  if (!request || !thread) throw new RequestIntakeApiError(502, 'The request response is invalid.')
  return { ...request, thread }
}

/**
 * Sends the member's reply to a question about their own request.
 *
 * @param accessToken - Workspace access token.
 * @param requestId - Request submission ID.
 * @param input - Plain text reply.
 * @param context - Idempotency context for the mutation.
 * @returns The reply receipt.
 */
export async function replyToMyRequest(
  accessToken: string,
  requestId: string,
  input: RequestRequesterReplyInput,
  context: MutationRequestContext,
): Promise<RequestRequesterReplyReceipt> {
  const data = await requestJson(
    `${requestsApiBaseUrl}/my-requests/${encodeURIComponent(requestId)}/replies`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
      method: 'POST',
    },
  )
  const record = readRecord(data)
  if (typeof record.replyId !== 'string' || typeof record.receivedAt !== 'string') {
    throw new RequestIntakeApiError(502, 'The reply response is invalid.')
  }
  return { replyId: record.replyId, receivedAt: record.receivedAt }
}

/**
 * Reads one request summary from untrusted JSON.
 *
 * @param value - Parsed response entry.
 * @returns The request, or undefined when the entry is malformed.
 */
function readMyRequest(value: unknown): MyRequest | undefined {
  const record = readRecord(value)
  const status = submissionStatuses.find((candidate) => candidate === record.status)
  if (
    typeof record.id !== 'string' ||
    typeof record.receiptId !== 'string' ||
    typeof record.formTitle !== 'string' ||
    !status ||
    typeof record.submittedAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) return undefined
  const workItem = readWorkItem(record.workItem)
  return {
    id: record.id,
    receiptId: record.receiptId,
    formTitle: record.formTitle,
    status,
    awaitingReply: record.awaitingReply === true,
    ...(workItem ? { workItem } : {}),
    submittedAt: record.submittedAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Reads the requester's view of a Work Item from untrusted JSON.
 *
 * @param value - Parsed `workItem` value.
 * @returns The Work Item view, or undefined when it is absent or malformed.
 */
function readWorkItem(value: unknown): MyRequestWorkItem | undefined {
  if (value === undefined || value === null) return undefined
  const record = readRecord(value)
  const completed = record.completed === true
  if (record.visibility === 'restricted') return { visibility: 'restricted', completed }
  const statusCategory = statusCategories.find((candidate) => candidate === record.statusCategory)
  if (
    record.visibility !== 'visible' ||
    typeof record.teamId !== 'string' ||
    typeof record.workItemId !== 'string' ||
    typeof record.title !== 'string' ||
    !statusCategory
  ) return undefined
  return {
    visibility: 'visible',
    teamId: record.teamId,
    workItemId: record.workItemId,
    ...(typeof record.key === 'string' && record.key ? { key: record.key } : {}),
    title: record.title,
    statusCategory,
    completed,
  }
}

/**
 * Reads the requester thread from untrusted JSON.
 *
 * @param value - Parsed `thread` value.
 * @returns The thread, or undefined when it is malformed.
 */
function readThread(value: unknown): RequestRequesterThread | undefined {
  const record = readRecord(value)
  if ((record.status !== 'open' && record.status !== 'closed') || typeof record.updatedAt !== 'string') {
    return undefined
  }
  const messages = Array.isArray(record.messages)
    ? record.messages.flatMap((entry): RequestRequesterThreadMessage[] => {
        const message = readRecord(entry)
        return typeof message.id === 'string' &&
          (message.direction === 'requester' || message.direction === 'staff') &&
          typeof message.body === 'string' &&
          typeof message.createdAt === 'string'
          ? [{ id: message.id, direction: message.direction, body: message.body, createdAt: message.createdAt }]
          : []
      })
    : []
  return { status: record.status, messages, updatedAt: record.updatedAt }
}

/**
 * Sends an authenticated request and returns the parsed JSON body.
 *
 * @param url - Request URL.
 * @param accessToken - Workspace access token.
 * @param init - Optional fetch options.
 * @returns The parsed JSON body.
 * @throws RequestIntakeApiError when the response is not successful.
 */
async function requestJson(url: string, accessToken: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...init?.headers },
  })
  const text = await response.text()
  let data: unknown = {}
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = {}
    }
  }
  if (!response.ok) {
    const record = readRecord(data)
    throw new RequestIntakeApiError(
      response.status,
      typeof record.message === 'string' && record.message.trim()
        ? record.message
        : 'Unable to load your requests.',
      typeof record.code === 'string' ? record.code : undefined,
    )
  }
  return data
}
