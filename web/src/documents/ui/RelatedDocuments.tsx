import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createDocumentPath } from '../../shared/routing/paths'
import {
  getDocument,
  getDocumentBacklinks,
  type DocumentBacklink,
  type DocumentRecord,
} from '../api'
import { useDocumentBacklinks } from '../queries/useDocumentQueries'

/**
 * 実行対象から逆引きする Document 一覧の props です。
 */
export type RelatedDocumentsProps = {
  /**
   * Documents API の access token です。
   */
  accessToken?: string
  /**
   * Relation target 種別です。
   */
  targetKind: 'work-item' | 'project' | 'goal'
  /**
   * Canonical relation target ID です。
   */
  targetId?: string
  /**
   * 表示文言を解決する翻訳関数です。
   */
  t: (key: MessageKey) => string
  /**
   * Opens a human-authored curated-context draft sourced from a related document.
   */
  onPromoteToContext?: (
    backlink: DocumentBacklink,
    document: DocumentRecord,
    returnFocusId: string,
  ) => void
}

/**
 * Renders a panel that links a Work Item, Project, or Goal to related Documents.
 */
export function RelatedDocuments({
  accessToken,
  onPromoteToContext,
  targetId,
  targetKind,
  t,
}: RelatedDocumentsProps) {
  const {
    data,
    error,
    isLoading,
    mutate,
    key,
  } = useDocumentBacklinks(accessToken, targetKind, targetId)
  const [isLoadingMore, setIsLoadingMore] =
    useState(false)
  const [promotingDocumentId, setPromotingDocumentId] =
    useState<string>()
  const [promotionErrorDocumentId, setPromotionErrorDocumentId] =
    useState<string>()

  if (!key) return null

  const backlinks = data?.backlinks ?? []
  const handleLoadMore = async () => {
    if (
      !accessToken ||
      !targetId ||
      !data?.nextCursor ||
      isLoadingMore
    ) {
      return
    }
    setIsLoadingMore(true)
    try {
      const next = await getDocumentBacklinks(
        accessToken,
        targetKind,
        targetId,
        data.nextCursor,
      )
      await mutate(
        {
          backlinks: mergeBacklinks(
            backlinks,
            next.backlinks,
          ),
          nextCursor: next.nextCursor,
        },
        { revalidate: false },
      )
    } finally {
      setIsLoadingMore(false)
    }
  }

  /**
   * Reads the currently authorized Document body before opening quote selection.
   *
   * @param backlink - Permission-filtered relation selected by the curator.
   */
  const handlePromoteToContext = async (backlink: DocumentBacklink) => {
    if (
      !accessToken ||
      !onPromoteToContext ||
      promotingDocumentId
    ) {
      return
    }

    setPromotingDocumentId(backlink.documentId)
    setPromotionErrorDocumentId(undefined)
    try {
      const document = await getDocument(
        accessToken,
        backlink.documentId,
      )
      onPromoteToContext(
        backlink,
        document,
        createRelatedDocumentPromotionTriggerId(backlink.documentId),
      )
    } catch {
      setPromotionErrorDocumentId(backlink.documentId)
    } finally {
      setPromotingDocumentId(undefined)
    }
  }

  return (
    <section className="grid gap-3 border-t border-[var(--workbench-border)] px-6 py-5">
      <div>
        <p className="workbench-eyebrow">
          {t('documents.related.eyebrow')}
        </p>
        <h3 className="mt-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('documents.related.title')}
        </h3>
      </div>
      {isLoading ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]">
          {t('documents.context.loading')}
        </p>
      ) : null}
      {error ? (
        <p
          className="text-sm font-semibold text-red-700"
          role="alert"
        >
          {t('documents.related.error')}
        </p>
      ) : null}
      {!isLoading && !error && backlinks.length === 0 ? (
        <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('documents.related.empty')}
        </p>
      ) : null}
      {backlinks.length > 0 ? (
        <div className="grid gap-2">
          {backlinks.map((backlink) => (
            <div
              className="flex min-w-0 items-stretch rounded-lg border border-[var(--workbench-border)] bg-white"
              key={`${backlink.documentId}:${backlink.relation.id}`}
            >
              <a
                className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 px-3 py-2.5 hover:bg-[#f2fbf9]"
                href={createDocumentPath(
                  backlink.documentId,
                )}
              >
                <span
                  aria-hidden="true"
                  className="grid h-8 w-8 flex-none place-items-center rounded-md bg-[#e5f7f4] text-sm font-bold text-[var(--workbench-primary)]"
                >
                  D
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--workbench-text)]">
                  {backlink.documentTitle}
                </span>
                <span
                  aria-hidden="true"
                  className="text-[var(--workbench-muted)]"
                >
                  →
                </span>
              </a>
              {accessToken && onPromoteToContext ? (
                <button
                  aria-label={`${
                    promotingDocumentId === backlink.documentId
                      ? t('documents.related.promotingToContext')
                      : t('documents.related.promoteToContext')
                  }: ${backlink.documentTitle}`}
                  className="min-h-[44px] flex-none border-l border-[var(--workbench-border)] px-3 text-xs font-semibold text-[var(--workbench-primary)] hover:bg-[#f2fbf9]"
                  data-testid={createRelatedDocumentPromotionTriggerId(
                    backlink.documentId,
                  )}
                  disabled={promotingDocumentId === backlink.documentId}
                  id={createRelatedDocumentPromotionTriggerId(backlink.documentId)}
                  onClick={() => void handlePromoteToContext(backlink)}
                  type="button"
                >
                  {promotingDocumentId === backlink.documentId
                    ? t('documents.related.promotingToContext')
                    : t('documents.related.promoteToContext')}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {promotionErrorDocumentId ? (
        <p className="text-sm font-semibold text-red-700" role="alert">
          {t('documents.related.promoteToContextError')}
        </p>
      ) : null}
      {data?.nextCursor ? (
        <button
          className="workbench-button-secondary min-h-9 px-3 text-xs"
          disabled={isLoadingMore}
          onClick={() => void handleLoadMore()}
          type="button"
        >
          {isLoadingMore
            ? t('documents.context.loading')
            : t('documents.context.loadMore')}
        </button>
      ) : null}
    </section>
  )
}

/**
 * Creates a stable focus-return target for one related Document promotion action.
 *
 * @param documentId - Permission-filtered Document identifier.
 * @returns DOM-safe button ID.
 */
function createRelatedDocumentPromotionTriggerId(documentId: string): string {
  return `related-document-promote-${encodeURIComponent(documentId)}`
}

function mergeBacklinks(
  current: readonly DocumentBacklink[],
  next: readonly DocumentBacklink[],
) {
  return [
    ...new Map(
      [...current, ...next].map((backlink) => [
        `${backlink.documentId}:${backlink.relation.id}`,
        backlink,
      ]),
    ).values(),
  ]
}
