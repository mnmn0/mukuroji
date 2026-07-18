import type {
  CreateRequestFormInput,
  PublishRequestFormInput,
  RequestAttachmentUploadSession,
  RequestAttachmentUploadInput,
  RequestForm,
  RequestRequesterReplyReceipt,
  RequestRequesterReplyInput,
  RequestRequesterThread,
  RequestSubmission,
  RequestSubmissionActionInput,
  RequestSubmissionPage,
  RequestSubmissionReceipt,
  RequestSubmissionStatus,
  PublicRequestForm,
  SubmitRequestInput,
  UpdateRequestFormInput,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'
import type { FileVersionAccess } from '../files/api'

/**
 * Request queue の cursor page 取得条件です。
 */
export type GetRequestQueueOptions = {
  /**
   * API が返した opaque cursor です。
   */
  cursor?: string
  /**
   * 1 page で取得する最大件数です。
   */
  limit?: number
  /**
   * Submission status の完全一致 filter です。
   */
  status?: RequestSubmissionStatus
}

/**
 * Request API の失敗を status/code とともに保持する例外です。
 */
export class RequestIntakeApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number
  /**
   * API が返した安定 error code です。
   */
  readonly code?: string
  /**
   * Rate limit 時に API が指定した retry 秒数です。
   */
  readonly retryAfterSeconds?: number

  constructor(
    status: number,
    message: string,
    code?: string,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'RequestIntakeApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}

const requestsApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')
const defaultRequestApiErrorMessage = 'Unable to complete the request intake operation.'

/**
 * 管理者が参照できる request form 一覧を取得します。
 */
export async function getRequestForms(accessToken: string) {
  const response = await requestJson<{ forms: RequestForm[] }>(
    `${requestsApiBaseUrl}/request-forms`,
    { accessToken },
  )

  return response.forms
}

/**
 * 一つの request form と現在 draft を取得します。
 */
export function getRequestForm(formId: string, accessToken: string) {
  return requestJson<RequestForm>(
    `${requestsApiBaseUrl}/request-forms/${encodeURIComponent(formId)}`,
    { accessToken },
  )
}

/**
 * Request form draft を新規作成します。
 */
export function createRequestForm(
  input: CreateRequestFormInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<RequestForm>(`${requestsApiBaseUrl}/request-forms`, {
    accessToken,
    init: {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
        ...createMutationHeaders(context),
      },
      method: 'POST',
    },
  })
}

/**
 * Request form の draft と routing/link 設定を保存します。
 */
export function updateRequestForm(
  formId: string,
  input: UpdateRequestFormInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<RequestForm>(
    `${requestsApiBaseUrl}/request-forms/${encodeURIComponent(formId)}`,
    {
      accessToken,
      init: {
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(context),
        },
        method: 'PUT',
      },
    },
  )
}

/**
 * 保存済み request form draft を immutable version として公開します。
 */
export function publishRequestForm(
  formId: string,
  input: PublishRequestFormInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<RequestForm>(
    `${requestsApiBaseUrl}/request-forms/${encodeURIComponent(formId)}/publish`,
    {
      accessToken,
      init: {
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(context),
        },
        method: 'POST',
      },
    },
  )
}

/**
 * 認証済み user が参照できる request queue page を取得します。
 */
export function getRequestQueue(
  accessToken: string,
  options: GetRequestQueueOptions = {},
) {
  const query = new URLSearchParams()

  if (options.cursor) query.set('cursor', options.cursor)
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  if (options.status) query.set('status', options.status)

  return requestJson<RequestSubmissionPage>(
    `${requestsApiBaseUrl}/request-queue${query.size ? `?${query}` : ''}`,
    { accessToken },
  )
}

/**
 * Request submission の versioned answer、thread、trace を取得します。
 */
export function getRequestSubmission(submissionId: string, accessToken: string) {
  return requestJson<RequestSubmission>(
    `${requestsApiBaseUrl}/request-submissions/${encodeURIComponent(submissionId)}`,
    { accessToken },
  )
}

/**
 * Request submission へ assign/reject/more-info/duplicate/convert action を適用します。
 */
export function applyRequestSubmissionAction(
  submissionId: string,
  input: RequestSubmissionActionInput,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<RequestSubmission>(
    `${requestsApiBaseUrl}/request-submissions/${encodeURIComponent(submissionId)}/actions`,
    {
      accessToken,
      init: {
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(context),
        },
        method: 'POST',
      },
    },
  )
}

/**
 * Malware scan 済み request attachment の短命 download URL を発行します。
 */
export function createRequestAttachmentAccess(
  submissionId: string,
  attachmentId: string,
  accessToken: string,
  context: MutationRequestContext,
) {
  return requestJson<FileVersionAccess>(
    `${requestsApiBaseUrl}/request-submissions/${encodeURIComponent(submissionId)}/attachments/${encodeURIComponent(attachmentId)}/access`,
    {
      accessToken,
      init: {
        headers: createMutationHeaders(context),
        method: 'POST',
      },
    },
  )
}

/**
 * Opaque link token から公開表示専用 request form DTO を取得します。
 */
export function getPublicRequestForm(linkToken: string, accessToken?: string) {
  return requestJson<PublicRequestForm>(
    `${requestsApiBaseUrl}/request-intake/${encodeURIComponent(linkToken)}`,
    { accessToken },
  )
}

/**
 * Public request form の attachment upload session を作成します。
 */
export function createRequestAttachmentUpload(
  linkToken: string,
  input: RequestAttachmentUploadInput,
  context: MutationRequestContext,
  accessToken?: string,
) {
  return requestJson<RequestAttachmentUploadSession>(
    `${requestsApiBaseUrl}/request-intake/${encodeURIComponent(linkToken)}/uploads`,
    {
      accessToken,
      init: {
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(context),
        },
        method: 'POST',
      },
    },
  )
}

/**
 * Public attachment を API が許可した object storage URL へ直接送信します。
 */
export async function putRequestAttachment(
  session: RequestAttachmentUploadSession,
  file: File,
) {
  const upload = session.upload
  if (file.size > upload.maxSizeBytes) {
    throw new RequestIntakeApiError(413, 'Attachment is too large.', 'RequestAttachmentTooLarge')
  }

  const response = await fetch(upload.url, {
    body: file,
    headers: upload.headers,
    method: upload.method,
  })

  if (!response.ok) {
    throw new RequestIntakeApiError(response.status, 'Attachment upload failed.')
  }
}

/**
 * Visible answers と upload session を public request submission として保存します。
 */
export function submitPublicRequest(
  linkToken: string,
  input: SubmitRequestInput,
  context: MutationRequestContext,
  accessToken?: string,
) {
  return requestJson<RequestSubmissionReceipt>(
    `${requestsApiBaseUrl}/request-intake/${encodeURIComponent(linkToken)}/submissions`,
    {
      accessToken,
      init: {
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(context),
        },
        method: 'POST',
      },
    },
  )
}

/**
 * Requester が opaque thread token で staff message を取得します。
 */
export function getRequestThread(threadToken: string) {
  return requestJson<RequestRequesterThread>(
    `${requestsApiBaseUrl}/request-threads/${encodeURIComponent(threadToken)}`,
  )
}

/**
 * Requester が signed thread token で追加情報を返信します。
 */
export function replyToRequestThread(
  threadToken: string,
  input: RequestRequesterReplyInput,
  context: MutationRequestContext,
) {
  return requestJson<RequestRequesterReplyReceipt>(
    `${requestsApiBaseUrl}/request-threads/${encodeURIComponent(threadToken)}/replies`,
    {
      init: {
        body: JSON.stringify(input),
        headers: {
          'Content-Type': 'application/json',
          ...createMutationHeaders(context),
        },
        method: 'POST',
      },
    },
  )
}

/**
 * Request API 共通 fetch helper の入力です。
 */
type RequestJsonOptions = {
  /** Request に付与する任意 access token です。 */
  accessToken?: string
  /** Fetch request options です。 */
  init?: RequestInit
}

async function requestJson<T>(url: string, options: RequestJsonOptions = {}) {
  const response = await fetch(url, {
    ...options.init,
    headers: {
      ...(options.accessToken
        ? { Authorization: `Bearer ${options.accessToken}` }
        : {}),
      ...options.init?.headers,
    },
  })
  const data = await readJson(response)

  if (!response.ok) {
    const error = readApiError(data)
    const retryAfterSeconds = readRetryAfterSeconds(response.headers.get('Retry-After'))

    throw new RequestIntakeApiError(
      response.status,
      error.message,
      error.code,
      retryAfterSeconds,
    )
  }

  return data as T
}

function readApiError(data: unknown) {
  const record = asRecord(data)
  const message = typeof record.message === 'string' && record.message.trim()
    ? record.message
    : defaultRequestApiErrorMessage
  const code = typeof record.code === 'string' && record.code.trim()
    ? record.code
    : undefined

  return { code, message }
}

async function readJson(response: Response) {
  const text = await response.text()

  if (!text) return {}

  try {
    return JSON.parse(text) as unknown
  } catch {
    return {}
  }
}

function readRetryAfterSeconds(value: string | null) {
  if (!value) return undefined

  const seconds = Number(value)

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
