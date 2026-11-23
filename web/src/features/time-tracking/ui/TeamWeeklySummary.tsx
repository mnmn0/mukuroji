import {
  WEEKLY_SUMMARY_SECTION_NAMES,
  type WeeklySummaryScope,
  type WeeklySummaryTotals,
} from '@mukuroji/contracts'
import { useId, useState, type ReactNode } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../../shared/routing/paths'
import { describeTeamSummaryItem, TEAM_SUMMARY_SECTION_TITLES } from './teamSummaryText'
import type { TimeTrackingFormatters, TimeTrackingTranslator } from './timeTrackingText'


/** Counted sections a summary view shows, weekly or monthly. */
export type TeamSummaryContent = {
  /** Counts across `scopes`. */
  totals: WeeklySummaryTotals
  /** Counts of the period before, when the summary carries them. */
  previousTotals?: WeeklySummaryTotals
  /** Readable scopes. */
  scopes: WeeklySummaryScope[]
}

/** Message keys that differ between the weekly and the monthly summary. */
const PERIOD_TEXT = {
  week: {
    title: 'timeTracking.weeklySummary.title',
    description: 'timeTracking.weeklySummary.description',
    loading: 'timeTracking.weeklySummary.loading',
    loadError: 'timeTracking.weeklySummary.loadError',
    tooLarge: 'timeTracking.weeklySummary.tooLarge',
  },
  month: {
    title: 'timeTracking.monthlySummary.title',
    description: 'timeTracking.monthlySummary.description',
    loading: 'timeTracking.monthlySummary.loading',
    loadError: 'timeTracking.monthlySummary.loadError',
    tooLarge: 'timeTracking.monthlySummary.tooLarge',
  },
} as const satisfies Record<'week' | 'month', Record<string, MessageKey>>

/** Props of the Team weekly or monthly summary. */
export type TeamWeeklySummaryProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Period the summary covers; picks the heading and messages. */
  period?: 'week' | 'month'
  /** Controls that move the period, with its visible range. */
  navigation: ReactNode
  /** Team whose Work Items are linked. */
  teamId: string
  /** Summary; undefined while loading. */
  summary: TeamSummaryContent | undefined
  /** Project names keyed by Project ID. */
  projectNames: Readonly<Record<string, string>>
  /** Whether the read failed. */
  hasLoadError: boolean
  /** Whether the Team has more Work Items than one summary reads. */
  isTooLarge: boolean
  /** Retries the failed read. */
  onRetry: () => void
  /**
   * Copies the summary as Markdown; rejects when the browser refuses. The copy action is shown
   * only when given, and only once the summary has loaded.
   */
  onCopy?: () => Promise<void>
}

/**
 * Shows the period of the Team and of each Project the reader may read: completed Work Items,
 * delays against the schedule baseline, overdue Work Items, and Milestones reached.
 *
 * @param props - Period, summary, and actions.
 * @returns Summary view.
 */
export function TeamWeeklySummary({
  formatters,
  hasLoadError,
  isTooLarge,
  navigation,
  onCopy,
  onRetry,
  period = 'week',
  projectNames,
  summary,
  t,
  teamId,
}: TeamWeeklySummaryProps) {
  const id = useId()
  const text = PERIOD_TEXT[period]
  const [copyMessage, setCopyMessage] = useState<{ tone: 'error' | 'status'; text: string }>()

  /** Copies the Markdown and reports the outcome. */
  const copy = async () => {
    if (!onCopy) return
    try {
      await onCopy()
      setCopyMessage({ tone: 'status', text: t('timeTracking.weeklySummary.copied') })
    } catch {
      setCopyMessage({ tone: 'error', text: t('timeTracking.weeklySummary.copyFailed') })
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-4" data-testid="team-weekly-summary">
      <h2 className="sr-only" id={`${id}-title`}>{t(text.title)}</h2>
      {navigation}
      <p className="text-sm text-[var(--workbench-muted)]">{t(text.description)}</p>
      {isTooLarge ? (
        <p className="rounded-md border border-[var(--workbench-border)] px-3 py-2 text-sm text-[var(--workbench-text)]" role="status">
          {t(text.tooLarge)}
        </p>
      ) : hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t(text.loadError)}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.weeklyReport.retry')}</button>
        </div>
      ) : !summary ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t(text.loading)}</p>
      ) : (
        <>
          {onCopy ? (
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <button className="workbench-button-secondary min-h-9 px-3" onClick={() => { void copy() }} type="button">
                {t('timeTracking.weeklySummary.copy')}
              </button>
              {copyMessage ? (
                <span
                  className={`text-sm ${copyMessage.tone === 'error' ? 'font-semibold text-fg-red-700' : 'text-[var(--workbench-muted)]'}`}
                  role={copyMessage.tone === 'error' ? 'alert' : 'status'}
                >
                  {copyMessage.text}
                </span>
              ) : null}
            </div>
          ) : null}
          <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4" data-testid="team-weekly-summary-totals">
            {WEEKLY_SUMMARY_SECTION_NAMES.map((name) => (
              <div className="min-w-0 rounded-md border border-[var(--workbench-border)] px-3 py-2" key={name}>
                <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t(TEAM_SUMMARY_SECTION_TITLES[name])}</dt>
                <dd className="text-xl font-semibold text-[var(--workbench-text)]">{summary.totals[name]}</dd>
                {summary.previousTotals ? (
                  <dd className="text-xs text-[var(--workbench-muted)]">
                    {t('timeTracking.monthlySummary.previous').replace('{count}', String(summary.previousTotals[name]))}
                  </dd>
                ) : null}
              </div>
            ))}
          </dl>
          {summary.scopes.length === 0 ? (
            <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.weeklySummary.empty')}</p>
          ) : summary.scopes.map((scope) => (
            <ScopeSummary
              formatters={formatters}
              key={scope.projectId ?? ''}
              projectNames={projectNames}
              scope={scope}
              t={t}
              teamId={teamId}
            />
          ))}
        </>
      )}
    </section>
  )
}

/** Props of one Project's summary. */
type ScopeSummaryProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Team whose Work Items are linked. */
  teamId: string
  /** Project names keyed by Project ID. */
  projectNames: Readonly<Record<string, string>>
  /** Scope shown. */
  scope: WeeklySummaryScope
}

/**
 * Shows one Project's sections, or those of the Work Items outside any Project.
 *
 * @param props - Scope and labels.
 * @returns Project summary.
 */
function ScopeSummary({ formatters, projectNames, scope, t, teamId }: ScopeSummaryProps) {
  const id = useId()
  const title = scope.projectId === undefined
    ? t('timeTracking.weeklySummary.noProject')
    : projectNames[scope.projectId] ?? scope.projectId
  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-3 rounded-md border border-[var(--workbench-border)] p-3" data-testid="team-weekly-summary-scope">
      <header className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="min-w-0 break-words text-base font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{title}</h3>
        {scope.baseline === undefined ? null : (
          <span className="text-xs text-[var(--workbench-muted)]">
            {scope.baseline === null
              ? t('timeTracking.weeklySummary.noBaseline')
              : t('timeTracking.weeklySummary.baseline').replace('{date}', formatters.date(scope.baseline.capturedAt))}
          </span>
        )}
      </header>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {WEEKLY_SUMMARY_SECTION_NAMES.map((name) => (
          <section className="grid min-w-0 content-start gap-1" key={name}>
            <h4 className="text-sm font-semibold text-[var(--workbench-text)]">
              {t(TEAM_SUMMARY_SECTION_TITLES[name])}
              <span className="ml-2 text-[var(--workbench-muted)]">{scope[name].count}</span>
            </h4>
            {scope[name].count === 0 ? (
              <p className="text-sm text-[var(--workbench-muted)]">
                {name === 'delayed' && scope.baseline === null ? t('timeTracking.weeklySummary.delayedNoBaseline') : t('timeTracking.weeklySummary.none')}
              </p>
            ) : (
              <ul className="grid min-w-0 gap-1">
                {scope[name].items.map((item) => (
                  <li className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 text-sm" key={item.workItemId}>
                    <a className="min-w-0 break-words text-[var(--workbench-text)] underline-offset-2 hover:underline" href={createTeamIssuesPath(teamId, item.workItemId)}>
                      {item.key ? <span className="mr-1 text-[var(--workbench-muted)]">{item.key}</span> : null}
                      {item.title}
                    </a>
                    <span className="text-xs text-[var(--workbench-muted)]">{describeTeamSummaryItem(name, item, t, formatters)}</span>
                  </li>
                ))}
                {scope[name].count > scope[name].items.length ? (
                  <li className="text-xs text-[var(--workbench-muted)]">
                    {t('timeTracking.weeklySummary.more').replace('{count}', String(scope[name].count - scope[name].items.length))}
                  </li>
                ) : null}
              </ul>
            )}
          </section>
        ))}
      </div>
    </section>
  )
}
