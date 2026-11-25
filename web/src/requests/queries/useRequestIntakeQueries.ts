import type { MyRequestPage, RequestSubmissionPage } from '@mukuroji/contracts'
import useSWR from 'swr'
import useSWRInfinite from 'swr/infinite'
import {
  getRequestForm,
  getRequestFormManagementScopes,
  getRequestForms,
} from '../api/forms'
import {
  getRequestQueue,
  getRequestSubmission,
} from '../api/submissions'
import { getMyRequest, getMyRequests } from '../api/myRequests'

const requestIntakeQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Request submission queue を cursor pagination で取得します。
 *
 * @param accessToken - Request API の access token です。
 * @param enabled - Queue view を表示しているかどうかです。
 * @returns Request submission page の SWR Infinite state です。
 */
export function useRequestQueue(accessToken?: string, enabled = true) {
  return useSWRInfinite(
    (pageIndex, previousPage: RequestSubmissionPage | null) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'request-queue',
        accessToken,
        pageIndex === 0 ? '' : previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, cursor]) => getRequestQueue(token, {
      cursor: cursor || undefined,
      limit: 50,
    }),
    requestIntakeQueryConfig,
  )
}

/**
 * 管理可能な Request form 一覧を取得します。
 *
 * @param accessToken - Request API の access token です。
 * @param enabled - Forms view を表示しているかどうかです。
 * @returns Request form 一覧の SWR state です。
 */
export function useRequestForms(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['request-forms', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => getRequestForms(token),
    requestIntakeQueryConfig,
  )
}

/**
 * 選択中の Request submission を取得します。
 *
 * @param accessToken - Request API の access token です。
 * @param submissionId - 取得対象の submission ID です。
 * @param enabled - Queue view を表示しているかどうかです。
 * @returns Request submission 詳細の SWR state です。
 */
export function useRequestSubmission(
  accessToken: string | undefined,
  submissionId: string | undefined,
  enabled = true,
) {
  const key = accessToken && submissionId && enabled
    ? ['request-submission', accessToken, submissionId] as const
    : null

  return useSWR(
    key,
    ([, token, currentSubmissionId]) =>
      getRequestSubmission(currentSubmissionId, token),
    requestIntakeQueryConfig,
  )
}

/**
 * 編集対象の Request form を取得します。
 *
 * @param accessToken - Request API の access token です。
 * @param formId - 取得対象の form ID です。
 * @param enabled - Forms view を表示しているかどうかです。
 * @returns Request form 詳細の SWR state です。
 */
export function useRequestForm(
  accessToken: string | undefined,
  formId: string | undefined,
  enabled = true,
) {
  const key = accessToken && formId && formId !== 'new' && enabled
    ? ['request-form', accessToken, formId] as const
    : null

  return useSWR(
    key,
    ([, token, currentFormId]) => getRequestForm(currentFormId, token),
    requestIntakeQueryConfig,
  )
}

/**
 * Reads which request form scopes the caller can change (ADR 0087).
 *
 * @param accessToken - Request API access token.
 * @param enabled - Whether the caller may hold Team scopes; Workspace administrators skip it.
 * @returns The SWR state of the form management scopes.
 */
export function useRequestFormManagementScopes(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['request-form-management-scopes', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => getRequestFormManagementScopes(token),
    requestIntakeQueryConfig,
  )
}

/**
 * Loads the requests the signed-in member sent, newest first, page by page.
 *
 * @param accessToken - Workspace access token.
 * @param enabled - Whether the "My requests" page is shown.
 * @returns SWR Infinite state of the member's request pages.
 */
export function useMyRequests(accessToken?: string, enabled = true) {
  return useSWRInfinite(
    (pageIndex, previousPage: MyRequestPage | null) => {
      if (!accessToken || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return ['my-requests', accessToken, pageIndex === 0 ? '' : previousPage?.nextCursor ?? ''] as const
    },
    ([, token, cursor]) => getMyRequests(token, { cursor: cursor || undefined, limit: 20 }),
    requestIntakeQueryConfig,
  )
}

/**
 * Loads one of the signed-in member's requests with its conversation.
 *
 * @param accessToken - Workspace access token.
 * @param requestId - Selected request ID.
 * @returns SWR state of the request detail.
 */
export function useMyRequest(accessToken: string | undefined, requestId: string | undefined) {
  return useSWR(
    accessToken && requestId ? ['my-request', accessToken, requestId] as const : null,
    ([, token, id]) => getMyRequest(token, id),
    requestIntakeQueryConfig,
  )
}
