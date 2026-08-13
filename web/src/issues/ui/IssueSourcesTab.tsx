import type {
  CuratedContextSource,
  CuratedContextSourceAvailability,
  CuratedContextSourceKind,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'
import { ExternalLinkIcon } from '../../shared/ui/icons'
import type { IssueContextController } from '../mutations/useIssueContext'
import {
  createIssueSourceAnchorId,
  createIssueSourceEntries,
  getIssueSourceAvailabilityReasonKey,
} from '../model/contextSources'
import {
  advanceDeepLinkTraversal,
  type DeepLinkTraversalState,
} from '../model/deepLinkTraversal'

/**
 * Props for the source provenance ledger.
 */
export type IssueSourcesTabProps = {
  /** Locale used for messages and timestamps. */
  locale: Locale
  /** Context controller that owns source-bearing items and pagination. */
  controller: IssueContextController
  /** Source targeted by an in-panel link or deep link. */
  focusedSourceId?: string
  /** Context item that owns the exact provenance snapshot to focus. */
  focusedContextItemId?: string
  /** Source category that disambiguates an in-panel cross-link. */
  focusedSourceKind?: CuratedContextSourceKind
}

/**
 * Renders immutable source provenance and explicit unavailable states in a flat ledger.
 *
 * @param props - Context data, locale, and optional focus target.
 * @returns The Sources tab.
 */
export function IssueSourcesTab({
  controller,
  focusedContextItemId,
  focusedSourceId,
  focusedSourceKind,
  locale,
}: IssueSourcesTabProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const sources = useMemo(
    () => createIssueSourceEntries(controller.items),
    [controller.items],
  )
  const handledFocusTargetRef = useRef<string | undefined>(undefined)
  const [deepLinkExhausted, setDeepLinkExhausted] = useState(false)
  const deepLinkTraversalRef = useRef<DeepLinkTraversalState>({
    requestedPages: 0,
  })

  useEffect(() => {
    if (!focusedContextItemId && !focusedSourceId) {
      handledFocusTargetRef.current = undefined
      deepLinkTraversalRef.current = { requestedPages: 0 }
      queueMicrotask(() => setDeepLinkExhausted(false))
      return
    }
    const focusKey = focusedContextItemId
      ? `item:${focusedContextItemId}`
      : `source:${focusedSourceKind ?? '*'}:${focusedSourceId ?? ''}`
    if (
      handledFocusTargetRef.current === focusKey ||
      controller.isLoading
    ) {
      return
    }
    const focusedSource = sources.find(
      ({ item, source }) =>
        (focusedContextItemId
          ? item.id === focusedContextItemId
          : source.sourceId === focusedSourceId) &&
        (!focusedSourceKind || source.kind === focusedSourceKind),
    )
    const target = focusedSource
      ? document.getElementById(
          createIssueSourceAnchorId(focusedSource.item.id),
        )
      : null

    const traversal = advanceDeepLinkTraversal(
      deepLinkTraversalRef.current,
      focusKey,
      !target && controller.hasMore && !controller.isLoadingMore,
    )
    deepLinkTraversalRef.current = traversal.state

    if (traversal.shouldLoad) {
      void controller.loadMore()
      return
    }

    if (!target) {
      queueMicrotask(() => setDeepLinkExhausted(traversal.exhausted))
      return
    }
    queueMicrotask(() => setDeepLinkExhausted(false))
    handledFocusTargetRef.current = focusKey
    const frameId = window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true })
      target.scrollIntoView({ behavior: 'auto', block: 'center' })
    })
    return () => window.cancelAnimationFrame(frameId)
  }, [
    controller,
    controller.hasMore,
    controller.isLoading,
    controller.isLoadingMore,
    controller.items,
    focusedContextItemId,
    focusedSourceId,
    focusedSourceKind,
    sources,
  ])

  return (
    <section
      aria-busy={controller.isLoading || controller.isLoadingMore}
      aria-label={t('collaboration.tabs.sources')}
      className="px-5 py-4"
      data-testid="issue-sources-tab"
    >
      <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {t('collaboration.sources.description')}
      </p>
      {deepLinkExhausted ? (
        <p className="mt-3 border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800" role="status">
          {t('collaboration.deepLink.exhausted')}
        </p>
      ) : null}

      {controller.hasLoadError ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-red-200 bg-red-50 px-3 py-2.5" role="alert">
          <p className="text-sm font-semibold text-red-700">
            {t('collaboration.sources.error')}
          </p>
          <button
            className="min-h-[44px] text-xs font-bold text-red-700 underline underline-offset-2"
            onClick={() => void controller.refresh()}
            type="button"
          >
            {t('collaboration.retry')}
          </button>
        </div>
      ) : null}

      {controller.hasLoadError ? null : controller.isLoading ? (
        <div className="mt-4 grid gap-2" aria-hidden="true">
          <div className="h-24 motion-safe:animate-pulse bg-[var(--workbench-surface-muted)]" />
          <div className="h-24 motion-safe:animate-pulse bg-[var(--workbench-surface-muted)]" />
        </div>
      ) : sources.length > 0 ? (
        <ol className="mt-4 divide-y divide-[var(--workbench-border)] border-y border-[var(--workbench-border)]">
          {sources.map(({ item, source }) => (
            <li
              className="min-w-0 py-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--workbench-primary)] focus-visible:ring-offset-2"
              data-source-availability={source.availability}
              id={createIssueSourceAnchorId(item.id)}
              key={item.id}
              tabIndex={-1}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="workbench-badge">
                  {t(`collaboration.sources.kind.${source.kind}`)}
                </span>
                <span className={createAvailabilityClassName(source.availability)}>
                  {t(
                    `collaboration.sources.availability.${source.availability}`,
                  )}
                </span>
              </div>
              <h3 className="mt-2 text-sm font-semibold leading-5 text-[var(--workbench-text)]">
                {item.title}
              </h3>
              {isSensitiveSourceRedacted(source) ? (
                <p className="mt-2 text-xs font-semibold text-red-700">
                  {t('collaboration.sources.sensitiveRedacted')}
                </p>
              ) : source.quote ? (
                <blockquote className="mt-2 border-l-[3px] border-[var(--workbench-primary)] pl-3 text-sm leading-6 text-[var(--workbench-text)]">
                  {source.quote.text}
                </blockquote>
              ) : (
                <p className="mt-2 text-xs font-medium text-[var(--workbench-muted)]">
                  {t('collaboration.sources.noQuote')}
                </p>
              )}
              {!isSensitiveSourceRedacted(source) &&
              source.quote &&
              'startOffset' in source.quote &&
              'endOffset' in source.quote ? (
                <p className="mt-1 text-[0.68rem] font-medium text-[var(--workbench-muted-soft)]">
                  {t('collaboration.sources.range')
                    .replace('{start}', String(source.quote.startOffset))
                    .replace('{end}', String(source.quote.endOffset))}
                </p>
              ) : null}

              {source.availability !== 'available' ? (
                <div
                  className={`mt-3 border-l-[3px] px-3 py-2 ${
                    source.availability === 'edited'
                      ? 'border-amber-500 bg-amber-50 text-amber-900'
                      : 'border-red-500 bg-red-50 text-red-800'
                  }`}
                  role="status"
                >
                  <p className="text-xs font-semibold">
                    {t(
                      `collaboration.sources.availability.${source.availability}`,
                    )}
                  </p>
                  <p className="mt-1 text-xs leading-5">
                    {t(getIssueSourceAvailabilityReasonKey(source))}
                  </p>
                </div>
              ) : null}

              <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="font-semibold text-[var(--workbench-muted)]">
                  {t('collaboration.sources.actor')}
                </dt>
                <dd className="min-w-0 break-words text-[var(--workbench-text)]">
                  {source.actor?.displayName ?? t('collaboration.sources.unknown')}
                </dd>
                <dt className="font-semibold text-[var(--workbench-muted)]">
                  {t('collaboration.sources.timestamp')}
                </dt>
                <dd className="text-[var(--workbench-text)]">
                  <time dateTime={source.occurredAt}>
                    {formatSourceDate(source.occurredAt, locale)}
                  </time>
                </dd>
                <dt className="font-semibold text-[var(--workbench-muted)]">
                  {t('collaboration.sources.revision')}
                </dt>
                <dd className="break-words text-[var(--workbench-text)]">
                  {t('collaboration.sources.revisionValue').replace(
                    '{revision}',
                    formatSourceRevision(
                      source,
                      t('collaboration.sources.unknown'),
                    ),
                  )}
                </dd>
                <dt className="font-semibold text-[var(--workbench-muted)]">
                  {t('collaboration.sources.sourceId')}
                </dt>
                <dd className="break-all font-mono text-[var(--workbench-text)]">
                  {source.sourceId}
                </dd>
              </dl>

              {!isSensitiveSourceRedacted(source) && source.originalBody ? (
                <details className="mt-3 border-t border-[var(--workbench-border)] pt-1">
                  <summary className="flex min-h-[44px] cursor-pointer items-center text-xs font-semibold text-[var(--workbench-primary)]">
                    {t('collaboration.sources.original')}
                  </summary>
                  <p className="whitespace-pre-wrap break-words bg-[var(--workbench-surface-muted)] px-3 py-2 text-xs leading-5 text-[var(--workbench-text)]">
                    {source.originalBody}
                  </p>
                </details>
              ) : null}

              {!isSensitiveSourceRedacted(source) && source.permalink ? (
                isNavigablePermalink(source.permalink) ? (
                source.availability === 'available' ||
                source.availability === 'edited' ? (
                  <a
                    className="mt-2 inline-flex min-h-[44px] max-w-full items-center gap-1.5 text-xs font-semibold text-[var(--workbench-primary)] underline underline-offset-2"
                    href={resolveSourcePermalink(source.permalink)}
                    {...(isExternalPermalink(source.permalink)
                      ? { rel: 'noopener noreferrer', target: '_blank' }
                      : {})}
                  >
                    {isExternalPermalink(source.permalink) ? (
                      <ExternalLinkIcon className="h-4 w-4 flex-none fill-none stroke-current stroke-2 [stroke-linecap:round] [stroke-linejoin:round]" />
                    ) : null}
                    <span>{t('collaboration.sources.openPermalink')}</span>
                    {isExternalPermalink(source.permalink) ? (
                      <span className="sr-only">
                        {t('collaboration.sources.newWindow')}
                      </span>
                    ) : null}
                  </a>
                ) : (
                  <p className="mt-3 break-all text-[0.68rem] font-medium text-[var(--workbench-muted)]">
                    {t('collaboration.sources.retainedPermalink')}: {source.permalink}
                  </p>
                )
                ) : (
                  <p className="mt-3 break-all text-[0.68rem] font-medium text-[var(--workbench-muted)]">
                    {t('collaboration.sources.retainedPermalink')}: {source.permalink}
                  </p>
                )
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="mt-4 border border-dashed border-[var(--workbench-border-strong)] bg-[var(--workbench-surface-muted)] px-4 py-7 text-center">
          <p className="text-sm font-semibold text-[var(--workbench-text)]">
            {t('collaboration.sources.empty.title')}
          </p>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t(
              controller.capabilities.canCreate
                ? 'collaboration.sources.empty.description'
                : 'collaboration.sources.empty.readOnlyDescription',
            )}
          </p>
        </div>
      )}

      {controller.hasMore ? (
        <button
          className="mt-4 min-h-[44px] text-sm font-semibold text-[var(--workbench-primary)] underline underline-offset-2 disabled:opacity-60"
          disabled={controller.isLoadingMore}
          onClick={() => void controller.loadMore()}
          type="button"
        >
          {t(
            controller.isLoadingMore
              ? 'collaboration.loadingMore'
              : 'collaboration.sources.loadEarlier',
          )}
        </button>
      ) : null}
    </section>
  )
}

/**
 * Distinguishes external evidence links from canonical routes inside the current Work Item pane.
 *
 * @param permalink - Retained provenance link.
 * @returns Whether navigation must open an isolated browser context.
 */
function isExternalPermalink(permalink: string): boolean {
  return /^https?:\/\//u.test(permalink)
}

/**
 * Allows only provider links and routes that remain inside the current application origin.
 *
 * @param permalink - Retained provenance link supplied by the server.
 * @returns Whether the value is safe to place in an anchor href.
 */
function isNavigablePermalink(permalink: string): boolean {
  if (isExternalPermalink(permalink) || permalink.startsWith('?')) return true
  if (/^[/\\]{2}/u.test(permalink)) return false
  return permalink.startsWith('/') || permalink.startsWith('./') || permalink.startsWith('../')
}

/**
 * Preserves the current Work Item route scope for retained query-only source links.
 *
 * @param permalink - Retained internal or external provenance link.
 * @returns Canonical same-pane route for internal comments/activity, otherwise the original URL.
 */
function resolveSourcePermalink(permalink: string): string {
  if (!permalink.startsWith('?')) return permalink

  const current = new URLSearchParams(
    typeof window === 'undefined' ? '' : window.location.search,
  )
  const source = new URLSearchParams(permalink)
  for (const [key, value] of source) current.set(key, value)

  if (source.has('commentId')) {
    current.set('collaborationTab', 'conversation')
    current.delete('activityEventId')
  } else if (source.has('activityEventId')) {
    current.set('collaborationTab', 'activity')
    current.delete('commentId')
    current.delete('rootCommentId')
  }
  current.delete('contextItemId')
  current.delete('sourceId')
  current.delete('sourceKind')
  return `?${current.toString()}`
}

/**
 * Maps source availability to existing semantic badge classes.
 *
 * @param availability - Current source availability.
 * @returns Existing Workbench badge class name.
 */
function createAvailabilityClassName(
  availability: CuratedContextSourceAvailability,
): string {
  if (availability === 'available') return 'workbench-badge-success'
  if (availability === 'edited') return 'workbench-badge-warning'
  return 'workbench-badge-danger'
}

/**
 * Prevents stale sensitive content from rendering after the viewer loses source permission.
 *
 * @param source - Source provenance snapshot.
 * @returns Whether quote, original body, and permalink must remain hidden.
 */
function isSensitiveSourceRedacted(source: CuratedContextSource): boolean {
  return source.availability === 'permission-lost'
}

/**
 * Formats captured and current source revisions without losing their native type.
 *
 * @param source - Source provenance snapshot.
 * @param fallback - Localized fallback for absent revisions.
 * @returns Visible revision trace.
 */
function formatSourceRevision(
  source: CuratedContextSource,
  fallback: string,
): string {
  const captured = source.capturedRevision
  const current = source.currentRevision
  if (captured === undefined && current === undefined) return fallback
  if (current === undefined || current === captured) return String(captured)
  return `${String(captured ?? fallback)} → ${String(current)}`
}

/**
 * Formats one source occurrence timestamp.
 *
 * @param value - ISO timestamp.
 * @param locale - Application locale.
 * @returns Localized source time.
 */
function formatSourceDate(value: string, locale: Locale): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
}
