import {
  WEEKLY_SUMMARY_SECTION_NAMES,
  type TeamWeeklySummaryResponse,
  type WeeklySummaryItem,
  type WeeklySummaryScope,
  type WeeklySummarySectionName,
} from '@mukuroji/contracts'
import { useId } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { createTeamIssuesPath } from '../../../shared/routing/paths'
import type { TimeWeekPeriod } from '../model/timePeriod'
import { TimeWeekNavigator } from './TimeWeekNavigator'
import type { TimeTrackingFormatters, TimeTrackingTranslator } from './timeTrackingText'

/** Message key of each section heading. */
const SECTION_TITLES: Record<WeeklySummarySectionName, MessageKey> = {
  completed: 'timeTracking.weeklySummary.completed',
  delayed: 'timeTracking.weeklySummary.delayed',
  overdue: 'timeTracking.weeklySummary.overdue',
  milestonesReached: 'timeTracking.weeklySummary.milestonesReached',
}

/** Props of the Team weekly summary. */
export type TeamWeeklySummaryProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Week shown. */
  week: TimeWeekPeriod
  /** Team whose Work Items are linked. */
  teamId: string
  /** Summary; undefined while loading. */
  summary: TeamWeeklySummaryResponse | undefined
  /** Project names keyed by Project ID. */
  projectNames: Readonly<Record<string, string>>
  /** Whether the read failed. */
  hasLoadError: boolean
  /** Whether the Team has more Work Items than one summary reads. */
  isTooLarge: boolean
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
  /** Retries the failed read. */
  onRetry: () => void
}

/**
 * Shows the week of the Team and of each Project the reader may read: completed Work Items,
 * delays against the schedule baseline, overdue Work Items, and Milestones reached.
 *
 * @param props - Week, summary, and actions.
 * @returns Weekly summary view.
 */
export function TeamWeeklySummary({
  formatters,
  hasLoadError,
  isTooLarge,
  onMoveWeek,
  onRetry,
  projectNames,
  summary,
  t,
  teamId,
  week,
}: TeamWeeklySummaryProps) {
  const id = useId()
  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-4" data-testid="team-weekly-summary">
      <h2 className="sr-only" id={`${id}-title`}>{t('timeTracking.weeklySummary.title')}</h2>
      <TimeWeekNavigator formatters={formatters} onMove={onMoveWeek} t={t} week={week} />
      <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.weeklySummary.description')}</p>
      {isTooLarge ? (
        <p className="rounded-md border border-[var(--workbench-border)] px-3 py-2 text-sm text-[var(--workbench-text)]" role="status">
          {t('timeTracking.weeklySummary.tooLarge')}
        </p>
      ) : hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.weeklySummary.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.weeklyReport.retry')}</button>
        </div>
      ) : !summary ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('timeTracking.weeklySummary.loading')}</p>
      ) : (
        <>
          <dl className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4" data-testid="team-weekly-summary-totals">
            {WEEKLY_SUMMARY_SECTION_NAMES.map((name) => (
              <div className="min-w-0 rounded-md border border-[var(--workbench-border)] px-3 py-2" key={name}>
                <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{t(SECTION_TITLES[name])}</dt>
                <dd className="text-xl font-semibold text-[var(--workbench-text)]">{summary.totals[name]}</dd>
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
              {t(SECTION_TITLES[name])}
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
                    <span className="text-xs text-[var(--workbench-muted)]">{describeItem(name, item, t, formatters)}</span>
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

/**
 * Describes the date that put a Work Item in a section.
 *
 * @param name - Section.
 * @param item - Listed Work Item.
 * @param t - Translator.
 * @param formatters - Date formatters.
 * @returns Short description, or an empty string when the Work Item has no such date.
 */
function describeItem(name: WeeklySummarySectionName, item: WeeklySummaryItem, t: TimeTrackingTranslator, formatters: TimeTrackingFormatters) {
  switch (name) {
    case 'completed':
    case 'milestonesReached':
      return item.actualEndDate ? t('timeTracking.weeklySummary.completedOn').replace('{date}', formatters.day(item.actualEndDate)) : ''
    case 'overdue':
      return item.plannedEndDate ? t('timeTracking.weeklySummary.dueOn').replace('{date}', formatters.day(item.plannedEndDate)) : ''
    case 'delayed':
      return t('timeTracking.weeklySummary.delayDays').replace('{days}', String(item.delayDays ?? 0))
  }
}
