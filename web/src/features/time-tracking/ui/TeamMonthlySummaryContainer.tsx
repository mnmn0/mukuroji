import type { TeamMonthlySummaryResponse } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { createTranslator } from '../../../shared/i18n/i18n'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { TeamWeeklySummary } from './TeamWeeklySummary'
import { formatTeamSummaryMarkdown } from './teamSummaryMarkdown'
import { createTimeTrackingFormatters, type TimeTrackingTranslator } from './timeTrackingText'
import { writeClipboardText } from './writeClipboardText'

/** Props of the Team monthly summary connected to the API. */
export type TeamMonthlySummaryContainerProps = {
  /** Summary read by the page; undefined while loading or after a failure. */
  summary: TeamMonthlySummaryResponse | undefined
  /** Read failure; the page also hands it to the session error handling. */
  error: unknown
  /** Reads the summary again. */
  onRetry: () => void
  /** Team summarized. */
  teamId: string
  /** Team name used in the copied Markdown heading. */
  teamName: string
  /** Calendar month as `YYYY-MM`. */
  month: string
  /** Display locale. */
  locale: Locale
  /** Project names keyed by Project ID. */
  projectNames: Readonly<Record<string, string>>
  /** Moves the month; 0 returns to the current month. */
  onMoveMonth: (months: number) => void
}

/**
 * Lays out the Team monthly summary that the page read, with month controls and the Markdown
 * copy, so the page can hand a session failure of the read to its session error handling.
 *
 * @param props - Summary, Team, month, and locale.
 * @returns Connected view.
 */
export function TeamMonthlySummaryContainer({
  error,
  locale,
  month,
  onMoveMonth,
  onRetry,
  projectNames,
  summary,
  teamId,
  teamName,
}: TeamMonthlySummaryContainerProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const formatters = useMemo(() => createTimeTrackingFormatters(locale), [locale])
  const monthLabel = useMemo(() => formatMonth(month, locale), [locale, month])
  const isTooLarge = error instanceof TimeTrackingApiError && error.status === 413

  return (
    <TeamWeeklySummary
      formatters={formatters}
      hasLoadError={Boolean(error) && !isTooLarge}
      isTooLarge={isTooLarge}
      navigation={<TimeMonthNavigator label={monthLabel} onMove={onMoveMonth} t={t} />}
      onCopy={async () => {
        if (!summary) return
        const heading = t('timeTracking.monthlySummary.heading').replace('{team}', teamName).replace('{month}', monthLabel)
        await writeClipboardText(formatTeamSummaryMarkdown(summary, heading, projectNames, t, formatters))
      }}
      onRetry={onRetry}
      period="month"
      projectNames={projectNames}
      summary={summary}
      t={t}
      teamId={teamId}
    />
  )
}

/** Props of the month navigator. */
type TimeMonthNavigatorProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Visible month. */
  label: string
  /** Moves by whole months; 0 returns to the current month. */
  onMove: (months: number) => void
}

/**
 * Previous / current / next month controls with the visible month.
 *
 * @param props - Month label and move action.
 * @returns Navigator.
 */
function TimeMonthNavigator({ label, onMove, t }: TimeMonthNavigatorProps) {
  return (
    <nav aria-label={t('timeTracking.month.navigation')} className="flex min-w-0 flex-wrap items-center gap-2">
      <button className="workbench-button-secondary min-h-9 px-3" onClick={() => onMove(-1)} type="button">
        {t('timeTracking.month.previous')}
      </button>
      <button className="workbench-button-secondary min-h-9 px-3" onClick={() => onMove(0)} type="button">
        {t('timeTracking.month.current')}
      </button>
      <button className="workbench-button-secondary min-h-9 px-3" onClick={() => onMove(1)} type="button">
        {t('timeTracking.month.next')}
      </button>
      <h3 aria-live="polite" className="text-base font-semibold text-[var(--workbench-text)]">{label}</h3>
    </nav>
  )
}

/**
 * Formats a calendar month for display.
 *
 * @param month - Month as `YYYY-MM`.
 * @param locale - Display locale.
 * @returns Such as `2026年11月` or `November 2026`.
 */
export function formatMonth(month: string, locale: Locale): string {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1)))
}
