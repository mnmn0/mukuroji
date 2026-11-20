import type { SubmitWeeklyReportRequest, WeeklyReportHistoryEntry, WeeklyReportResponse } from '@mukuroji/contracts'
import { useId, useMemo, useState } from 'react'
import {
  formatPersonalWeeklyReportMarkdown,
  toSubmitWeeklyReportRequest,
  type PersonalWeeklyReport as PersonalWeeklyReportFacts,
  type PersonalWeeklyReportItem,
  type PersonalWeeklyReportNotes,
} from '../model/personalWeeklyReport'
import { formatMinutes, type TimeWeekPeriod } from '../model/timePeriod'
import { SubmittedWeeklyReport } from './SubmittedWeeklyReport'
import { TimeWeekNavigator } from './TimeWeekNavigator'
import { formatWeeklyReportSubmittedStatus, type TimeTrackingFormatters, type TimeTrackingTranslator } from './timeTrackingText'

/** Outcome of saving or submitting a weekly report, decided by the container from the API answer. */
export type WeeklyReportActionResult = 'done' | 'conflict' | 'limit' | 'failed'

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
  /** The member's saved notes and latest submission of the week; undefined until read. */
  savedReport: WeeklyReportResponse | undefined
  /** The member's recent weeks, newest first, when read. */
  history?: readonly WeeklyReportHistoryEntry[]
  /**
   * Saves the notes without submitting.
   *
   * @param expectedRevision - Saved revision the notes replace; 0 when nothing was saved.
   * @param notes - Notes to save.
   * @returns The outcome.
   */
  onSaveDraft: (expectedRevision: number, notes: PersonalWeeklyReportNotes) => Promise<WeeklyReportActionResult>
  /**
   * Submits a new version.
   *
   * @param request - Submission body built from the facts and notes.
   * @returns The outcome.
   */
  onSubmit: (request: SubmitWeeklyReportRequest) => Promise<WeeklyReportActionResult>
  /**
   * Opens another week from the history.
   *
   * @param weekStart - First day of the week.
   */
  onOpenWeek: (weekStart: string) => void
}

/** Props of the notes, actions, and preview of a weekly report. */
type WeeklyReportComposerProps = Pick<
  PersonalWeeklyReportProps,
  't' | 'formatters' | 'report' | 'isPartial' | 'onCopy' | 'onSaveDraft' | 'onSubmit'
> & {
  /** The member's saved notes and latest submission of the week. */
  savedReport: WeeklyReportResponse
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

/** Notes of a week nothing was saved for. */
const emptyNotes: PersonalWeeklyReportNotes = { issues: '', reflection: '' }

/**
 * Tells whether two sets of notes are the same once surrounding whitespace is ignored, as the
 * server stores them trimmed.
 *
 * @param left - First notes.
 * @param right - Second notes.
 * @returns Whether both fields match.
 */
function sameNotes(left: PersonalWeeklyReportNotes, right: PersonalWeeklyReportNotes) {
  return left.issues.trim() === right.issues.trim() && left.reflection.trim() === right.reflection.trim()
}

/**
 * Message key of a failed save or submission.
 *
 * @param result - Outcome other than `done`.
 * @param action - Which action failed.
 * @returns Message key.
 */
function failureMessageKey(result: Exclude<WeeklyReportActionResult, 'done'>, action: 'save' | 'submit') {
  if (result === 'conflict') return 'timeTracking.weeklyReport.conflict' as const
  if (result === 'limit') return 'timeTracking.weeklyReport.submissionLimit' as const
  return action === 'save' ? 'timeTracking.weeklyReport.saveFailed' as const : 'timeTracking.weeklyReport.submitFailed' as const
}

/**
 * Edits the member's notes, saves or submits them with the facts, and copies the Markdown. It
 * mounts once the saved report is read, so the fields start from the saved notes.
 *
 * @param props - Facts, saved report, and actions.
 * @returns Notes, actions, and preview.
 */
function WeeklyReportComposer({ formatters, isPartial, onCopy, onSaveDraft, onSubmit, report, savedReport, t }: WeeklyReportComposerProps) {
  const savedNotes = savedReport.draft?.notes ?? emptyNotes
  const [notes, setNotes] = useState<PersonalWeeklyReportNotes>(savedNotes)
  const [message, setMessage] = useState<{ tone: 'error' | 'status'; text: string }>()
  const [busy, setBusy] = useState(false)
  const markdown = useMemo(
    () => formatPersonalWeeklyReportMarkdown(report, notes, t, { timeIsPartial: isPartial }),
    [isPartial, notes, report, t],
  )
  const isDirty = !sameNotes(notes, savedNotes)

  /** Copies the Markdown and reports the outcome. */
  const copy = async () => {
    try {
      await onCopy(markdown)
      setMessage({ tone: 'status', text: t('timeTracking.weeklyReport.copied') })
    } catch {
      setMessage({ tone: 'error', text: t('timeTracking.weeklyReport.copyFailed') })
    }
  }

  /**
   * Runs a save or submission and reports the outcome.
   *
   * @param action - Which action runs.
   */
  const run = async (action: 'save' | 'submit') => {
    setBusy(true)
    setMessage(undefined)
    try {
      const result = action === 'save'
        ? await onSaveDraft(savedReport.draft?.revision ?? 0, notes)
        : await onSubmit(toSubmitWeeklyReportRequest(report, notes, {
            timeIsPartial: isPartial,
            expectedSubmissionCount: savedReport.submissionCount,
          }))
      setMessage(result === 'done'
        ? { tone: 'status', text: t(action === 'save' ? 'timeTracking.weeklyReport.saved' : 'timeTracking.weeklyReport.submittedMessage') }
        : { tone: 'error', text: t(failureMessageKey(result, action)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-w-0 content-start gap-3">
      <p className="text-sm font-semibold text-[var(--workbench-text)]" data-testid="weekly-report-status">
        {savedReport.submission
          ? formatWeeklyReportSubmittedStatus(t, formatters, savedReport.submission.version, savedReport.submission.submittedAt)
          : t('timeTracking.weeklyReport.statusNotSubmitted')}
      </p>
      <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
        {t('timeTracking.weeklyReport.issuesNote')}
        <textarea
          className="workbench-input min-h-24 w-full min-w-0 px-3 py-2 font-normal"
          maxLength={4000}
          onChange={(event) => setNotes((current) => ({ ...current, issues: event.target.value }))}
          value={notes.issues}
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-[var(--workbench-text)]">
        {t('timeTracking.weeklyReport.reflectionNote')}
        <textarea
          className="workbench-input min-h-24 w-full min-w-0 px-3 py-2 font-normal"
          maxLength={4000}
          onChange={(event) => setNotes((current) => ({ ...current, reflection: event.target.value }))}
          value={notes.reflection}
        />
      </label>
      <p className="text-xs text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.notesHint')}</p>
      {isDirty ? <p className="text-xs font-semibold text-fg-amber-800">{t('timeTracking.weeklyReport.unsaved')}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <button className="workbench-button-primary min-h-9 px-3" disabled={busy} onClick={() => { void run('submit') }} type="button">
          {t(savedReport.submissionCount > 0 ? 'timeTracking.weeklyReport.resubmit' : 'timeTracking.weeklyReport.submit')}
        </button>
        <button className="workbench-button-secondary min-h-9 px-3" disabled={busy || !isDirty} onClick={() => { void run('save') }} type="button">
          {t('timeTracking.weeklyReport.saveDraft')}
        </button>
        <button className="workbench-button-secondary min-h-9 px-3" onClick={() => { void copy() }} type="button">
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
      {savedReport.submission ? (
        <details className="grid min-w-0 gap-2 rounded-md border border-[var(--workbench-border)] p-3">
          <summary className="cursor-pointer text-sm font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.submittedContent')}</summary>
          <SubmittedWeeklyReport formatters={formatters} submission={savedReport.submission} t={t} />
        </details>
      ) : null}
    </div>
  )
}

/** Props of the member's recent weeks. */
type WeeklyReportHistoryListProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Recent weeks, newest first. */
  weeks: readonly WeeklyReportHistoryEntry[]
  /** Week shown, marked as current. */
  currentWeekStart: string
  /**
   * Opens a week.
   *
   * @param weekStart - First day of the week.
   */
  onOpenWeek: (weekStart: string) => void
}

/**
 * Lists the member's recent weeks with whether each was submitted.
 *
 * @param props - Weeks and navigation.
 * @returns History list.
 */
function WeeklyReportHistoryList({ currentWeekStart, formatters, onOpenWeek, t, weeks }: WeeklyReportHistoryListProps) {
  return (
    <section className="grid min-w-0 gap-2" data-testid="weekly-report-history">
      <h3 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.weeklyReport.history')}</h3>
      {weeks.length === 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.weeklyReport.historyEmpty')}</p>
      ) : (
        <ul className="grid min-w-0 gap-1 text-sm">
          {weeks.map((entry) => (
            <li className="flex min-w-0 flex-wrap items-center gap-x-3" key={entry.weekStart}>
              <button
                aria-current={entry.weekStart === currentWeekStart ? 'true' : undefined}
                className="font-semibold text-[var(--workbench-primary)] underline-offset-2 hover:underline"
                onClick={() => onOpenWeek(entry.weekStart)}
                type="button"
              >
                {formatters.day(entry.weekStart)}
              </button>
              <span className="text-[var(--workbench-muted)]">
                {entry.submissionCount > 0
                  ? t('timeTracking.weeklyReport.historySubmitted').replace('{version}', String(entry.submissionCount))
                  : t('timeTracking.weeklyReport.historyDraft')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * Shows the facts of the member's week, lets them add issues and a reflection, save and submit the
 * report, copy it as Markdown, and open past weeks.
 *
 * @param props - Week, facts, saved report, and actions.
 * @returns Weekly report view.
 */
export function PersonalWeeklyReport({
  formatters,
  hasLoadError,
  history,
  isLoading,
  isPartial,
  onCopy,
  onMoveWeek,
  onOpenWeek,
  onRetry,
  onSaveDraft,
  onSubmit,
  report,
  savedReport,
  t,
  week,
}: PersonalWeeklyReportProps) {
  const id = useId()

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

      {isLoading || (!hasLoadError && !savedReport) ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('timeTracking.weeklyReport.loading')}</p>
      ) : hasLoadError || !savedReport ? null : (
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
            {history ? (
              <WeeklyReportHistoryList currentWeekStart={week.days[0] ?? ''} formatters={formatters} onOpenWeek={onOpenWeek} t={t} weeks={history} />
            ) : null}
          </div>

          <WeeklyReportComposer
            formatters={formatters}
            isPartial={isPartial}
            onCopy={onCopy}
            onSaveDraft={onSaveDraft}
            onSubmit={onSubmit}
            report={report}
            savedReport={savedReport}
            t={t}
          />
        </div>
      )}
    </section>
  )
}
