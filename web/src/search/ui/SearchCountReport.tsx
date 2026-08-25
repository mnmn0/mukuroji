import type { WorkspaceSearchResult } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import { createLoadedSearchCountReport } from '../model/searchCountReport'

/** Props for the approved bounded Search count report. */
export type SearchCountReportProps = {
  /** Currently loaded permission-filtered Search results. */
  results: readonly WorkspaceSearchResult[]
  /** Existing Search layout field used for an optional count breakdown. */
  groupBy?: string
  /** Whether the Search response exposes another permission-filtered page. */
  hasMore: boolean
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders an approved count intent using only the currently loaded Search pages.
 *
 * @param props - Loaded results, cursor completeness, existing grouping, and translations.
 * @returns A visibly bounded count review placed beside the normal Search results.
 */
export function SearchCountReport({ groupBy, hasMore, results, t }: SearchCountReportProps) {
  const report = createLoadedSearchCountReport(results, groupBy, hasMore)
  const countMessage = report.isComplete
    ? t('ai.search.report.completeCount')
    : t('ai.search.report.loadedCount')

  return (
    <section
      aria-labelledby="approved-search-count-report-title"
      className="workbench-panel grid gap-3 border-l-4 border-l-[var(--workbench-primary)] p-4"
      data-testid="approved-search-count-report"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="workbench-eyebrow">{t('ai.search.report.approved')}</p>
          <h2 className="mt-1 text-base font-semibold text-[var(--workbench-text)]" id="approved-search-count-report-title">
            {countMessage.replace('{count}', String(report.loadedCount))}
          </h2>
        </div>
        {groupBy ? (
          <span className="workbench-badge-primary">
            {t('ai.search.report.groupBy').replace('{field}', groupBy)}
          </span>
        ) : null}
      </div>

      {!report.isComplete ? (
        <p className="text-app-caption font-medium text-[var(--workbench-muted)]" role="status">
          {t('ai.search.report.partialNotice')}
        </p>
      ) : null}

      {report.groups.length > 0 ? (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,160px),1fr))] gap-2">
          {report.groups.map((group) => (
            <div className="rounded-lg bg-[var(--workbench-surface-muted)] px-3 py-2" key={group.value ?? '__not-set__'}>
              <dt className="break-words text-app-caption font-semibold leading-5 text-[var(--workbench-muted)]">
                {group.value ?? t('ai.search.report.notSet')}
              </dt>
              <dd className="mt-1 text-lg font-semibold text-[var(--workbench-text)]">{group.count}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  )
}
