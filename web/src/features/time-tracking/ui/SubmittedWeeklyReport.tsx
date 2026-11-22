import type { WeeklyReportItemView, WeeklyReportSubmission } from '@mukuroji/contracts'
import { formatMinutes } from '../model/timePeriod'
import {
  describeTimeEntrySubject,
  formatWeeklyReportSubmittedStatus,
  type TimeTrackingFormatters,
  type TimeTrackingTranslator,
} from './timeTrackingText'
import { useTimeEntryCategories } from '../model/timeEntryCategoryContext'

/** Props of a submitted weekly report. */
export type SubmittedWeeklyReportProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** The submitted version, as the server filtered it for the reader. */
  submission: WeeklyReportSubmission
}

/** Props of one submitted section list. */
type SubmittedItemListProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Heading of the list; omitted when the section heading already names it. */
  title?: string
  /** Rows of the list. */
  items: readonly WeeklyReportItemView[]
}

/**
 * Lists the rows of one section; a Work Item the reader may not view shows only its time.
 *
 * @param props - Heading and rows.
 * @returns Section list.
 */
function SubmittedItemList({ items, t, title }: SubmittedItemListProps) {
  return (
    <section className="grid min-w-0 gap-1">
      {title === undefined ? null : <h5 className="text-sm font-semibold text-[var(--workbench-text)]">{title}</h5>}
      {items.length === 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.none')}</p>
      ) : (
        <ul className="grid min-w-0 gap-1 text-sm text-[var(--workbench-text)]">
          {items.map((item, index) => (
            <li className="flex min-w-0 flex-wrap items-baseline gap-x-2" key={item.hidden ? `hidden-${index}` : item.workItemId}>
              {item.hidden ? (
                <span className="min-w-0 italic text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.hiddenItem')}</span>
              ) : (
                <>
                  {item.key === undefined ? null : <span className="font-mono text-xs text-[var(--workbench-muted)]">{item.key}</span>}
                  <span className="min-w-0 break-words">{item.title}</span>
                  {item.plannedEndDate === undefined ? null : (
                    <span className="text-xs text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.due')} {item.plannedEndDate}</span>
                  )}
                </>
              )}
              {item.minutes > 0 ? (
                <span className="text-xs text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.recorded')} {formatMinutes(item.minutes)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Shows one submitted version of a weekly report, read-only.
 *
 * @param props - The version and text helpers.
 * @returns Submitted report.
 */
export function SubmittedWeeklyReport({ formatters, submission, t }: SubmittedWeeklyReportProps) {
  const categories = useTimeEntryCategories()
  return (
    <article className="grid min-w-0 gap-3" data-testid="submitted-weekly-report">
      <p className="text-sm font-semibold text-[var(--workbench-text)]">
        {formatWeeklyReportSubmittedStatus(t, formatters, submission.version, submission.submittedAt)}
      </p>
      <section className="grid min-w-0 gap-2">
        <h4 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.thisWeek')}</h4>
        <SubmittedItemList items={submission.sections.completed} t={t} title={t('timeTracking.weeklyReport.completed')} />
        <SubmittedItemList items={submission.sections.started} t={t} title={t('timeTracking.weeklyReport.started')} />
      </section>
      <section className="grid min-w-0 gap-2">
        <h4 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.nextWeek')}</h4>
        <SubmittedItemList items={submission.sections.upcoming} t={t} />
      </section>
      <section className="grid min-w-0 gap-2">
        <h4 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.issues')}</h4>
        <SubmittedItemList items={submission.sections.overdue} t={t} title={t('timeTracking.weeklyReport.overdue')} />
        {submission.notes.issues === '' ? null : (
          <p className="whitespace-pre-wrap break-words text-sm text-[var(--workbench-text)]">{submission.notes.issues}</p>
        )}
      </section>
      <section className="grid min-w-0 gap-1">
        <h4 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.time')}</h4>
        {submission.timeIsPartial ? (
          <p className="text-sm text-fg-amber-800">{t('timeTracking.weeklyReport.partial')}</p>
        ) : null}
        <p className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('timeTracking.weeklyReport.total')} {formatMinutes(submission.totalMinutes)}
        </p>
        <ul className="grid min-w-0 gap-1 text-sm text-[var(--workbench-text)]">
          {submission.time.map((row, index) => (
            <li className="flex min-w-0 justify-between gap-3" key={row.hidden ? `hidden-${index}` : row.workItemId}>
              <span className={`min-w-0 break-words ${row.hidden ? 'italic text-[var(--workbench-muted)]' : ''}`}>
                {row.hidden ? t('timeTracking.weeklyReport.hiddenItem') : row.title}
              </span>
              <span className="tabular-nums">{formatMinutes(row.minutes)}</span>
            </li>
          ))}
          {submission.indirectTime.map((row) => (
            <li className="flex min-w-0 justify-between gap-3" key={`indirect-${row.category}`}>
              <span className="min-w-0 break-words">{describeTimeEntrySubject(t, { category: row.category }, {}, categories)}</span>
              <span className="tabular-nums">{formatMinutes(row.minutes)}</span>
            </li>
          ))}
        </ul>
      </section>
      {submission.notes.reflection === '' ? null : (
        <section className="grid min-w-0 gap-1">
          <h4 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.reflection')}</h4>
          <p className="whitespace-pre-wrap break-words text-sm text-[var(--workbench-text)]">{submission.notes.reflection}</p>
        </section>
      )}
    </article>
  )
}
