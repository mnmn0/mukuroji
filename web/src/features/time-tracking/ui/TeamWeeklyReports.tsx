import type { TeamWeeklyReportMemberStatus, WeeklyReportResponse } from '@mukuroji/contracts'
import { useId } from 'react'
import type { TimeWeekPeriod } from '../model/timePeriod'
import { SubmittedWeeklyReport } from './SubmittedWeeklyReport'
import { TimeWeekNavigator } from './TimeWeekNavigator'
import { formatWeeklyReportSubmittedStatus, type TimeTrackingFormatters, type TimeTrackingTranslator } from './timeTrackingText'

/** Props of the Team's weekly report status. */
export type TeamWeeklyReportsProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Date and time formatters. */
  formatters: TimeTrackingFormatters
  /** Week shown. */
  week: TimeWeekPeriod
  /** Members the manager may read and their submission state; undefined while loading. */
  members: readonly TeamWeeklyReportMemberStatus[] | undefined
  /** Display names keyed by member key, used when the status has none. */
  memberNames: Readonly<Record<string, string>>
  /** Whether the reader manages no Project of the Team. */
  isForbidden: boolean
  /** Whether the status read failed for another reason. */
  hasLoadError: boolean
  /** Member whose report is open, if any. */
  selectedMemberKey: string | undefined
  /** The open member's report; undefined while loading. */
  selectedReport: WeeklyReportResponse | undefined
  /** Whether the open member's report failed to load. */
  hasSelectedReportError: boolean
  /**
   * Opens a member's report.
   *
   * @param memberKey - Member key.
   */
  onSelectMember: (memberKey: string) => void
  /** Moves the week; 0 returns to the current week. */
  onMoveWeek: (weeks: number) => void
  /** Retries the failed reads. */
  onRetry: () => void
  /** Reads the selected member's report again after it failed. */
  onRetrySelectedReport: () => void
}

/**
 * Lists who submitted a weekly report for the week among the members the manager may read, and
 * shows the submitted report of the selected member.
 *
 * @param props - Week, members, the open report, and actions.
 * @returns Team weekly report view.
 */
export function TeamWeeklyReports({
  formatters,
  hasLoadError,
  hasSelectedReportError,
  isForbidden,
  memberNames,
  members,
  onMoveWeek,
  onRetry,
  onRetrySelectedReport,
  onSelectMember,
  selectedMemberKey,
  selectedReport,
  t,
  week,
}: TeamWeeklyReportsProps) {
  const id = useId()
  const nameOf = (member: TeamWeeklyReportMemberStatus) => memberNames[member.memberKey] ?? member.displayName ?? member.memberKey
  const sorted = members ? [...members].sort((left, right) => nameOf(left).localeCompare(nameOf(right))) : undefined
  const submitted = members?.filter((member) => member.submissionCount > 0).length ?? 0
  const selected = members?.find((member) => member.memberKey === selectedMemberKey)

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-4" data-testid="team-weekly-reports">
      <h2 className="sr-only" id={`${id}-title`}>{t('timeTracking.teamWeeklyReports.title')}</h2>
      <TimeWeekNavigator formatters={formatters} onMove={onMoveWeek} t={t} week={week} />
      <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.teamWeeklyReports.description')}</p>
      {isForbidden ? (
        <p className="rounded-md border border-[var(--workbench-border)] px-3 py-2 text-sm text-[var(--workbench-text)]" role="status">
          {t('timeTracking.teamWeeklyReports.forbidden')}
        </p>
      ) : hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.teamWeeklyReports.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : !sorted ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('timeTracking.teamWeeklyReports.loading')}</p>
      ) : sorted.length === 0 ? (
        <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.teamWeeklyReports.empty')}</p>
      ) : (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section className="grid min-w-0 content-start gap-2">
            <p className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('timeTracking.teamWeeklyReports.summary').replace('{submitted}', String(submitted)).replace('{total}', String(sorted.length))}
            </p>
            <ul className="grid min-w-0 gap-1" data-testid="team-weekly-report-members">
              {sorted.map((member) => (
                <li key={member.memberKey}>
                  <button
                    aria-pressed={member.memberKey === selectedMemberKey}
                    className={`flex w-full min-w-0 flex-wrap items-center justify-between gap-x-3 rounded-md border px-3 py-2 text-left text-sm ${member.memberKey === selectedMemberKey ? 'border-[var(--workbench-primary)]' : 'border-[var(--workbench-border)]'}`}
                    onClick={() => onSelectMember(member.memberKey)}
                    type="button"
                  >
                    <span className="min-w-0 break-words font-semibold text-[var(--workbench-text)]">{nameOf(member)}</span>
                    <span className={member.submissionCount > 0 ? 'text-[var(--workbench-text)]' : 'font-semibold text-fg-amber-800'}>
                      {member.submissionCount > 0 && member.lastSubmittedAt
                        ? formatWeeklyReportSubmittedStatus(t, formatters, member.submissionCount, member.lastSubmittedAt)
                        : t('timeTracking.weeklyReport.statusNotSubmitted')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className="grid min-w-0 content-start gap-2">
            {selected === undefined ? null : (
              <>
                <h3 className="text-base font-semibold text-[var(--workbench-text)]">{nameOf(selected)}</h3>
                {hasSelectedReportError ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
                    <span>{t('timeTracking.teamWeeklyReports.reportLoadError')}</span>
                    <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetrySelectedReport} type="button">{t('timeTracking.retry')}</button>
                  </div>
                ) : !selectedReport ? (
                  <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('timeTracking.weeklyReport.loading')}</p>
                ) : selectedReport.submission ? (
                  <SubmittedWeeklyReport formatters={formatters} submission={selectedReport.submission} t={t} />
                ) : (
                  <p className="text-sm text-[var(--workbench-muted)]">{t('timeTracking.teamWeeklyReports.notSubmitted')}</p>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  )
}
