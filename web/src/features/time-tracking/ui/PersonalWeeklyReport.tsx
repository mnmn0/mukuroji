import { useId, useMemo, useState } from 'react'
import {
  formatPersonalWeeklyReportMarkdown,
  type PersonalWeeklyReport as PersonalWeeklyReportFacts,
  type PersonalWeeklyReportItem,
  type PersonalWeeklyReportNotes,
} from '../model/personalWeeklyReport'
import { formatMinutes, type TimeWeekPeriod } from '../model/timePeriod'
import { TimeWeekNavigator } from './TimeWeekNavigator'
import type { TimeTrackingFormatters, TimeTrackingTranslator } from './timeTrackingText'

/** Props of the member's weekly report. */
export type PersonalWeeklyReportProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Week shown. */
  week: TimeWeekPeriod
  /** Facts generated for the week. */
  report: PersonalWeeklyReportFacts
  /** Whether the facts are still loading. */
  isLoading: boolean
  /** Whether a read failed; the facts and copy action are then hidden so a gap is never exported as "none". */
  hasLoadError: boolean
  /** Whether the time entries were cut at the server's read limit. */
  isPartial: boolean
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
  /** Retries the failed reads. */
  onRetry: () => void
  /** Copies text to the clipboard; rejects when the browser refuses. */
  onCopy: (text: string) => Promise<void>
}

/** Props of one fact list. */
type ReportItemListProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Heading of the list; omitted when the section heading already names it. */
  title?: string
  /** Items of the list. */
  items: readonly PersonalWeeklyReportItem[]
}

/**
 * Lists the Work Items of one report section.
 *
 * @param props - Heading and items.
 * @returns Section list.
 */
function ReportItemList({ items, t, title }: ReportItemListProps) {
  return (
    <section className="grid min-w-0 gap-1">
      {title === undefined ? null : <h4 className="text-sm font-semibold text-[var(--workbench-text)]">{title}</h4>}
      {items.length === 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.none')}</p>
      ) : (
        <ul className="grid min-w-0 gap-1 text-sm text-[var(--workbench-text)]">
          {items.map((item) => (
            <li className="flex min-w-0 flex-wrap items-baseline gap-x-2" key={item.id}>
              {item.key === undefined ? null : <span className="font-mono text-xs text-[var(--workbench-muted)]">{item.key}</span>}
              <span className="min-w-0 break-words">{item.title}</span>
              {item.plannedEndDate === undefined ? null : (
                <span className="text-xs text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.due')} {item.plannedEndDate}</span>
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
 * Shows the facts of the member's week, lets them add issues and a reflection, and copies the
 * report as Markdown.
 *
 * @param props - Week, facts, and actions.
 * @returns Weekly report view.
 */
export function PersonalWeeklyReport({
  formatters,
  hasLoadError,
  isLoading,
  isPartial,
  onCopy,
  onMoveWeek,
  onRetry,
  report,
  t,
  week,
}: PersonalWeeklyReportProps) {
  const id = useId()
  const [notes, setNotes] = useState<PersonalWeeklyReportNotes>({ issues: '', reflection: '' })
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const markdown = useMemo(
    () => formatPersonalWeeklyReportMarkdown(report, notes, t, { timeIsPartial: isPartial }),
    [isPartial, notes, report, t],
  )

  /** Copies the Markdown and reports the outcome. */
  const copy = async () => {
    try {
      await onCopy(markdown)
      setMessage({ tone: 'status', text: t('timeTracking.weeklyReport.copied') })
    } catch {
      setMessage({ tone: 'error', text: t('timeTracking.weeklyReport.copyFailed') })
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-4" data-testid="personal-weekly-report">
      <h2 className="sr-only" id={`${id}-title`}>{t('timeTracking.weeklyReport.title')}</h2>
      <TimeWeekNavigator formatters={formatters} onMove={onMoveWeek} t={t} week={week} />
      <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.description')}</p>

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.weeklyReport.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {isPartial ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-fg-amber-800" role="status">
          {t('timeTracking.weeklyReport.partial')}
        </p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('timeTracking.weeklyReport.loading')}</p>
      ) : hasLoadError ? null : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <div className="grid min-w-0 content-start gap-4">
            <section className="grid min-w-0 gap-2">
              <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.thisWeek')}</h3>
              <ReportItemList items={report.completed} t={t} title={t('timeTracking.weeklyReport.completed')} />
              <ReportItemList items={report.started} t={t} title={t('timeTracking.weeklyReport.started')} />
            </section>
            <section className="grid min-w-0 gap-2">
              <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.nextWeek')}</h3>
              <ReportItemList items={report.upcoming} t={t} />
            </section>
            <section className="grid min-w-0 gap-2">
              <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.issues')}</h3>
              <ReportItemList items={report.overdue} t={t} title={t('timeTracking.weeklyReport.overdue')} />
            </section>
            <section className="grid min-w-0 gap-1">
              <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.time')}</h3>
              <p className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('timeTracking.weeklyReport.total')} {formatMinutes(report.totalMinutes)}
              </p>
              <ul className="grid min-w-0 gap-1 text-sm text-[var(--workbench-text)]">
                {report.time.map((row) => (
                  <li className="flex min-w-0 justify-between gap-3" key={row.workItemId}>
                    <span className="min-w-0 break-words">{row.title}</span>
                    <span className="tabular-nums">{formatMinutes(row.minutes)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="grid min-w-0 content-start gap-3">
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('timeTracking.weeklyReport.issuesNote')}
              <textarea
                className="workbench-input min-h-24 w-full min-w-0 px-3 py-2 font-normal"
                onChange={(event) => setNotes((current) => ({ ...current, issues: event.target.value }))}
                value={notes.issues}
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('timeTracking.weeklyReport.reflectionNote')}
              <textarea
                className="workbench-input min-h-24 w-full min-w-0 px-3 py-2 font-normal"
                onChange={(event) => setNotes((current) => ({ ...current, reflection: event.target.value }))}
                value={notes.reflection}
              />
            </label>
            <p className="text-xs text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.notesNotSaved')}</p>
            <div className="flex flex-wrap items-center gap-3">
              <button className="workbench-button-primary min-h-9 px-3" onClick={() => { void copy() }} type="button">
                {t('timeTracking.weeklyReport.copy')}
              </button>
              {message ? (
                <span
                  className={`text-sm font-semibold ${message.tone === 'error' ? 'text-fg-red-700' : 'text-[var(--workbench-muted)]'}`}
                  role={message.tone === 'error' ? 'alert' : 'status'}
                >
                  {message.text}
                </span>
              ) : null}
            </div>
            <section aria-label={t('timeTracking.weeklyReport.preview')} className="grid min-w-0 gap-1">
              <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.preview')}</h3>
              <pre className="max-h-[480px] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3 text-xs text-[var(--workbench-text)]" data-testid="weekly-report-markdown">
                {markdown}
              </pre>
            </section>
          </div>
        </div>
      )}
    </section>
  )
}
