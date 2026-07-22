import type { RequestAttachmentUploadSession, RequestAttachmentUploadInput } from '@mukuroji/contracts'
import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import type { FileVersionAccess } from '../../files/api'
import { RequestIntakeApiError } from './errors'

const requestsApiBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL ?? '/api')

const defaultRequestApiErrorMessage = 'Unable to complete the request intake operation.'

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
