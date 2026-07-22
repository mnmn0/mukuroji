import { useState } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createDocumentPath } from '../../shared/routing/paths'
import {
  getDocumentBacklinks,
  type DocumentBacklink,
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
}

/**
 * Work Item / Project / Goal から参照元 Documents へ戻る panel です。
 */
export function RelatedDocuments({
  accessToken,
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
            <a
              className="flex min-w-0 items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-white px-3 py-2.5 hover:border-[var(--workbench-primary)] hover:bg-[#f2fbf9]"
              href={createDocumentPath(
                backlink.documentId,
              )}
              key={`${backlink.documentId}:${backlink.relation.id}`}
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
          ))}
        </div>
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
