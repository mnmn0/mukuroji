import type { DocumentRelationTarget } from '@mukuroji/contracts'
import useSWR from 'swr'
import {
  getDocumentBacklinks,
  getDocumentBacklinksBatch,
} from '../api/backlinks'
import {
  getDocumentComments,
  getDocumentCommentThread,
} from '../api/comments'
import {
  getDocument,
  getDocumentCollection,
  getPublicDocument,
} from '../api/documents'
import { getDocumentPresence } from '../api/presence'
import { getDocumentShares } from '../api/shares'
import { getDocumentVersions } from '../api/versions'

const documentQueryConfig = {
  dedupingInterval: 5_000,
  shouldRetryOnError: false,
} as const

/**
 * Document tree と archive collection を取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param enabled - Current user の確認後に取得を有効にするかどうかです。
 * @returns Document collection の SWR state です。
 */
export function useDocumentCollection(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['documents', accessToken] as const
    : null

  return useSWR(
    key,
    ([, token]) => getDocumentCollection(token),
    documentQueryConfig,
  )
}

/**
 * 編集対象 Document の最新detailをpolling取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param documentId - 取得対象の Document ID です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Document detail の SWR state です。
 */
export function useDocument(
  accessToken: string | undefined,
  documentId: string | undefined,
  enabled = true,
) {
  const key = accessToken && documentId && enabled
    ? ['document', accessToken, documentId] as const
    : null

  return useSWR(
    key,
    ([, token, selectedId]) => getDocument(token, selectedId),
    {
      ...documentQueryConfig,
      refreshInterval: 3_500,
      refreshWhenHidden: false,
    },
  )
}

/**
 * Document comment の最新pageをpolling取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param documentId - 取得対象の Document ID です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Document comment page の SWR state です。
 */
export function useDocumentComments(
  accessToken: string | undefined,
  documentId: string | undefined,
  enabled = true,
) {
  const key = accessToken && documentId && enabled
    ? ['document-comments', accessToken, documentId] as const
    : null

  return useSWR(
    key,
    ([, token, selectedId]) => getDocumentComments(token, selectedId),
    {
      ...documentQueryConfig,
      refreshInterval: 4_000,
      refreshWhenHidden: false,
    },
  )
}

/**
 * Notification focusに必要なDocument comment threadを取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param documentId - 取得対象の Document ID です。
 * @param rootCommentId - Thread root comment ID です。
 * @param focusedCommentId - Focus対象comment IDです。
 * @returns Focused comment thread の SWR state です。
 */
export function useDocumentCommentThread(
  accessToken: string | undefined,
  documentId: string | undefined,
  rootCommentId: string | undefined,
  focusedCommentId: string | undefined,
) {
  const key = accessToken && documentId && rootCommentId && focusedCommentId
    ? [
        'document-comment-thread',
        accessToken,
        documentId,
        rootCommentId,
        focusedCommentId,
      ] as const
    : null

  return useSWR(
    key,
    ([, token, selectedId, rootId, targetId]) =>
      getDocumentCommentThread(token, selectedId, rootId, targetId),
    documentQueryConfig,
  )
}

/**
 * Document version history の先頭pageを取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param documentId - 取得対象の Document ID です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Document version page の SWR state です。
 */
export function useDocumentVersions(
  accessToken: string | undefined,
  documentId: string | undefined,
  enabled = true,
) {
  const key = accessToken && documentId && enabled
    ? ['document-versions', accessToken, documentId] as const
    : null

  return useSWR(
    key,
    ([, token, selectedId]) => getDocumentVersions(token, selectedId),
    documentQueryConfig,
  )
}

/**
 * Document presence を短い間隔でpolling取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param documentId - 取得対象の Document ID です。
 * @param refreshInterval - Presence polling interval です。
 * @returns Document presence の SWR state です。
 */
export function useDocumentPresence(
  accessToken: string | undefined,
  documentId: string | undefined,
  refreshInterval: number,
) {
  const key = accessToken && documentId
    ? ['document-presence', accessToken, documentId] as const
    : null

  return useSWR(
    key,
    ([, token, selectedId]) => getDocumentPresence(token, selectedId),
    {
      ...documentQueryConfig,
      dedupingInterval: 1_000,
      refreshInterval,
      refreshWhenHidden: false,
    },
  )
}

/**
 * Document share 一覧を取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param documentId - 取得対象の Document ID です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Document share 一覧の SWR state です。
 */
export function useDocumentShares(
  accessToken: string | undefined,
  documentId: string | undefined,
  enabled = true,
) {
  const key = accessToken && documentId && enabled
    ? ['document-shares', accessToken, documentId] as const
    : null

  return useSWR(
    key,
    ([, token, selectedId]) => getDocumentShares(token, selectedId),
    documentQueryConfig,
  )
}

/**
 * Document context panel用のbacklink batchを取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param targets - Backlink取得対象です。
 * @param enabled - Backlink panelを表示しているかどうかです。
 * @returns Backlink batch の SWR state です。
 */
export function useDocumentBacklinksBatch(
  accessToken: string | undefined,
  targets: readonly DocumentRelationTarget[],
  enabled = true,
) {
  const key = accessToken && enabled && targets.length > 0
    ? ['document-backlinks', accessToken, JSON.stringify(targets)] as const
    : null

  return useSWR(
    key,
    ([, token]) => getDocumentBacklinksBatch(
      token,
      targets.map((target) => ({
        targetType: target.kind,
        targetId: readDocumentRelationTargetId(target),
      })),
    ),
    documentQueryConfig,
  )
}

/**
 * 任意業務resourceを参照するDocument backlinksを取得します。
 *
 * @param accessToken - Documents API の access token です。
 * @param targetKind - Backlink対象resource kindです。
 * @param targetId - Backlink対象resource IDです。
 * @returns Document backlinks の SWR state とkeyです。
 */
export function useDocumentBacklinks(
  accessToken: string | undefined,
  targetKind: 'work-item' | 'project' | 'goal',
  targetId: string | undefined,
) {
  const key = accessToken && targetId
    ? ['related-documents', accessToken, targetKind, targetId] as const
    : null
  const query = useSWR(
    key,
    ([, token, kind, id]) => getDocumentBacklinks(token, kind, id),
    {
      dedupingInterval: 10_000,
      shouldRetryOnError: false,
    },
  )

  return {
    ...query,
    key,
  }
}

/**
 * Public share tokenからread-only Documentを取得します。
 *
 * @param shareToken - Public Document share tokenです。
 * @returns Public Document の SWR state です。
 */
export function usePublicDocument(shareToken: string) {
  return useSWR(
    shareToken ? ['public-document', shareToken] as const : null,
    ([, token]) => getPublicDocument(token),
    { shouldRetryOnError: false },
  )
}

function readDocumentRelationTargetId(target: DocumentRelationTarget) {
  switch (target.kind) {
    case 'work-item':
      return target.workItemId
    case 'project':
      return target.projectId
    case 'goal':
      return target.goalId
  }
}
