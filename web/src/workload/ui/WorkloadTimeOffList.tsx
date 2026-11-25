import type { WorkloadSnapshot, WorkloadTimeOff, WorkloadTimeOffStatus } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Props for the Team time-off review list. */
export type WorkloadTimeOffListProps = {
  /** Snapshot whose member rows carry their time off. */
  snapshot: WorkloadSnapshot
  /** Display names keyed by member identifier. */
  memberNames: ReadonlyMap<string, string>
  /** Whether any planning mutation is in flight. */
  isSaving: boolean
  /** Sends a new status for one member's time off and resolves to whether it succeeded. */
  onReview: (memberId: string, timeOff: WorkloadTimeOff, status: WorkloadTimeOffStatus) => Promise<boolean> | void
  /** Resolves localized labels. */
  t: (key: MessageKey) => string
}

/** One time-off row with its member. */
type TimeOffRow = {
  /** Member who requested the absence. */
  memberId: string
  /** The absence. */
  timeOff: WorkloadTimeOff
}

/**
 * Lists the Team's time off so a manager can approve or reject requests and a member can
 * withdraw their own. Pending requests come first because they need a decision.
 *
 * @param props - Snapshot, member names, mutation state, review callback, and labels.
 * @returns The time-off list, or nothing when the Team has no current time off.
 */
export function WorkloadTimeOffList({ isSaving, memberNames, onReview, snapshot, t }: WorkloadTimeOffListProps) {
  const canManage = snapshot.viewer?.canManage === true
  const viewerMemberId = snapshot.viewer?.memberId
  const rows = sortTimeOffRows(snapshot.members.flatMap((member) =>
    member.timeOff.map((timeOff) => ({ memberId: member.memberId, timeOff })),
  ))
  const pendingCount = rows.filter((row) => row.timeOff.status === 'planned').length

  return (
    <div className="grid min-w-0 gap-3 border-t border-[var(--workbench-border)] pt-4" data-testid="workload-time-off-list">
      <div>
        <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{t('workload.controls.timeOffList.title')}</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--workbench-muted)]">
          {t(canManage ? 'workload.controls.timeOffList.descriptionManager' : 'workload.controls.timeOffList.description')}
        </p>
        {pendingCount > 0 ? (
          <p className="mt-1 text-xs font-semibold text-fg-526381">
            {t('workload.controls.timeOffList.pending').replace('{count}', String(pendingCount))}
          </p>
        ) : null}
      </div>
      {rows.length === 0 ? <p className="text-xs font-semibold text-[var(--workbench-muted)]">{t('workload.controls.timeOffList.empty')}</p> : null}
      <ul className="grid gap-2">
        {rows.map(({ memberId, timeOff }) => {
          const isOwn = memberId === viewerMemberId
          const review = (status: WorkloadTimeOffStatus) => { void onReview(memberId, timeOff, status) }
          const period = timeOff.fromDate === timeOff.toDate ? timeOff.fromDate : `${timeOff.fromDate} – ${timeOff.toDate}`
          return (
            <li
              className={`grid min-w-0 gap-2 border px-3 py-2 ${timeOff.status === 'planned' ? 'border-dashed border-tone-c9d8f0' : 'border-[var(--workbench-border)]'} ${timeOff.status === 'rejected' ? 'opacity-60' : ''}`}
              data-testid="workload-time-off-row"
              key={`${memberId}:${timeOff.id}`}
            >
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold text-[var(--workbench-text)]">{memberNames.get(memberId) ?? memberId}</p>
                  <p className="text-xs leading-5 text-[var(--workbench-muted)]">
                    {[
                      period,
                      timeOff.minutesPerDay === undefined ? t('workload.controls.timeOffList.fullDay') : formatHours(timeOff.minutesPerDay),
                      timeOff.reason,
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className="shrink-0 border border-[var(--workbench-border)] px-2 py-0.5 text-[11px] font-semibold text-[var(--workbench-text)]">
                  {t(`workload.controls.timeOffList.status.${timeOff.status}`)}
                </span>
              </div>
              <div aria-label={`${memberNames.get(memberId) ?? memberId} ${period}`} className="flex flex-wrap gap-2" role="group">
                {canManage && timeOff.status === 'planned' ? (
                  <>
                    <button className={buttonClass} disabled={isSaving} type="button" onClick={() => review('approved')}>{t('workload.controls.timeOffList.approve')}</button>
                    <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={() => review('rejected')}>{t('workload.controls.timeOffList.reject')}</button>
                  </>
                ) : null}
                {canManage && (timeOff.status === 'approved' || timeOff.status === 'rejected') ? (
                  <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={() => review('planned')}>{t('workload.controls.timeOffList.reopen')}</button>
                ) : null}
                {isOwn && !canManage && timeOff.status === 'rejected' ? (
                  <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={() => review('planned')}>{t('workload.controls.timeOffList.resubmit')}</button>
                ) : null}
                {(isOwn || canManage) && timeOff.status !== 'rejected' ? (
                  <button className={secondaryButtonClass} disabled={isSaving} type="button" onClick={() => review('canceled')}>{t('workload.controls.timeOffList.withdraw')}</button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Orders pending time off first, then by start date and member. */
function sortTimeOffRows(rows: readonly TimeOffRow[]): TimeOffRow[] {
  const rank = (status: WorkloadTimeOffStatus) => status === 'planned' ? 0 : status === 'approved' ? 1 : 2
  return [...rows].sort((left, right) =>
    rank(left.timeOff.status) - rank(right.timeOff.status) ||
    left.timeOff.fromDate.localeCompare(right.timeOff.fromDate) ||
    left.memberId.localeCompare(right.memberId))
}

/** Formats minutes as hours. */
function formatHours(minutes: number): string {
  const hours = minutes / 60
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`
}

const buttonClass = 'workbench-button-primary px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50'
const secondaryButtonClass = 'workbench-button-secondary px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-50'
