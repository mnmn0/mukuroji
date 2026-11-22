import { useState } from 'react'
import {
  WORKSPACE_CALENDAR_WEEKDAYS,
  WORK_CALENDAR_ADJUSTMENTS,
  type WorkCalendarAdjustment,
  type WorkCalendarChangeImpact,
  type WorkCalendarChangeResult,
  type WorkCalendarResponse,
  type WorkspaceCalendarWeekday,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  addWorkCalendarHoliday,
  canAddWorkCalendarHoliday,
  removeWorkCalendarHoliday,
  setWorkCalendarWeekday,
  type WorkCalendarDraft,
  type WorkCalendarPublicHolidayChoice,
} from '../model/workCalendarDraft'

/** Label keys of each weekday. */
const weekdayLabelKeys: Record<WorkspaceCalendarWeekday, MessageKey> = {
  monday: 'workspace.tenantAdministration.weekday.monday',
  tuesday: 'workspace.tenantAdministration.weekday.tuesday',
  wednesday: 'workspace.tenantAdministration.weekday.wednesday',
  thursday: 'workspace.tenantAdministration.weekday.thursday',
  friday: 'workspace.tenantAdministration.weekday.friday',
  saturday: 'workspace.tenantAdministration.weekday.saturday',
  sunday: 'workspace.tenantAdministration.weekday.sunday',
}

/** Label keys of each national holiday choice. */
const publicHolidayLabelKeys: Record<WorkCalendarPublicHolidayChoice, MessageKey> = {
  inherit: 'workspace.workCalendar.publicHolidays.inherit',
  japan: 'workspace.workCalendar.publicHolidays.japan',
  none: 'workspace.workCalendar.publicHolidays.none',
}

/** Label keys of each adjustment. */
export const workCalendarAdjustmentLabelKeys: Record<WorkCalendarAdjustment, MessageKey> = {
  'keep-duration': 'workspace.workCalendar.adjustment.keepDuration',
  'keep-end-date': 'workspace.workCalendar.adjustment.keepEndDate',
}

/** A Team or Project the panel can edit. */
export type WorkCalendarScopeOption = {
  /** Option value: the Team ID, or `<teamId>/<projectId>`. */
  value: string
  /** Shown name. */
  label: string
}

/** Props of the Team and Project calendar panel. */
export type WorkCalendarPanelProps = {
  /** Calendars the member can pick. */
  scopeOptions: readonly WorkCalendarScopeOption[]
  /** Picked calendar. */
  selectedScope: string | undefined
  /** Loaded calendar, if any. */
  calendar: WorkCalendarResponse | undefined
  /** Form values, once loaded. */
  draft: WorkCalendarDraft | undefined
  /** Whether the calendar is loading. */
  isLoading: boolean
  /** Message of a failed read, save, or preview. */
  errorMessage?: string
  /** Impact of the drafted change, once previewed. */
  impact: WorkCalendarChangeImpact | undefined
  /** Result of the latest save. */
  result: WorkCalendarChangeResult | undefined
  /** Whether a preview or save is running. */
  isBusy: boolean
  /** Translator. */
  t: (key: MessageKey) => string
  /** Picks another calendar. */
  onScopeChange: (value: string) => void
  /** Receives edited form values. */
  onDraftChange: (draft: WorkCalendarDraft) => void
  /** Previews the drafted change. */
  onPreview: () => void
  /** Saves the previewed change. */
  onSave: () => void
  /** Reads the calendar again. */
  onRetry: () => void
}

/**
 * Edits a Team or Project calendar: working weekdays, national holidays, and company days off on
 * top of the inherited calendar, with a preview of the Work Items the change adjusts.
 *
 * @param props - Calendar state, draft, preview, and callbacks.
 * @returns The calendar panel.
 */
export function WorkCalendarPanel(props: WorkCalendarPanelProps) {
  const { calendar, draft, impact, isBusy, result, t } = props
  const [holidayDraft, setHolidayDraft] = useState('')
  const readOnly = !calendar?.canManage || isBusy

  /** Adds the drafted day off and clears the input. */
  function addHoliday() {
    if (!draft || readOnly) return
    const next = addWorkCalendarHoliday(draft, holidayDraft)
    if (!next) return
    props.onDraftChange(next)
    setHolidayDraft('')
  }

  return (
    <section className="workbench-panel grid gap-4 p-5" data-testid="work-calendar-panel">
      <header className="grid gap-1">
        <h2 className="text-base font-semibold text-[var(--workbench-text)]">{t('workspace.workCalendar.title')}</h2>
        <p className="text-sm text-[var(--workbench-muted)]">{t('workspace.workCalendar.description')}</p>
      </header>
      <label className="grid max-w-md gap-1 text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.workCalendar.scope')}
        <select
          className="workbench-input h-10 px-3"
          data-testid="work-calendar-scope"
          disabled={isBusy}
          onChange={(event) => props.onScopeChange(event.target.value)}
          value={props.selectedScope ?? ''}
        >
          {props.scopeOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {props.errorMessage ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--workbench-danger)]" role="alert">
          <span>{props.errorMessage}</span>
          <button className="workbench-button-secondary" onClick={props.onRetry} type="button">
            {t('workspace.workCalendar.retry')}
          </button>
        </div>
      ) : null}
      {props.isLoading || !calendar || !draft ? (
        props.isLoading ? <p className="text-sm text-[var(--workbench-muted)]">{t('workspace.workCalendar.loading')}</p> : null
      ) : (
        <>
          {!calendar.canManage ? (
            <p className="text-sm text-[var(--workbench-muted)]" data-testid="work-calendar-read-only">
              {t('workspace.workCalendar.readOnly')}
            </p>
          ) : null}
          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold text-[var(--workbench-text)]">
              {t('workspace.tenantAdministration.workingWeekdays')}
            </legend>
            <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]">
              <input
                checked={draft.inheritWorkingWeekdays}
                data-testid="work-calendar-inherit-weekdays"
                disabled={readOnly}
                onChange={(event) => props.onDraftChange({ ...draft, inheritWorkingWeekdays: event.target.checked })}
                type="checkbox"
              />
              {t('workspace.workCalendar.inheritWeekdays')}
            </label>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {WORKSPACE_CALENDAR_WEEKDAYS.map((weekday) => {
                const checked = draft.inheritWorkingWeekdays
                  ? calendar.inheritedPolicy.workingWeekdays.includes(weekday)
                  : draft.workingWeekdays.includes(weekday)
                return (
                  <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]" key={weekday}>
                    <input
                      checked={checked}
                      data-testid={`work-calendar-weekday-${weekday}`}
                      disabled={readOnly || draft.inheritWorkingWeekdays}
                      onChange={(event) => {
                        const next = setWorkCalendarWeekday(draft, weekday, event.target.checked)
                        if (next) props.onDraftChange(next)
                      }}
                      type="checkbox"
                    />
                    {t(weekdayLabelKeys[weekday])}
                  </label>
                )
              })}
            </div>
          </fieldset>
          <label className="grid max-w-md gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('workspace.workCalendar.publicHolidays')}
            <select
              className="workbench-input h-10 px-3"
              data-testid="work-calendar-public-holidays"
              disabled={readOnly}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'inherit' || value === 'japan' || value === 'none') {
                  props.onDraftChange({ ...draft, publicHolidays: value })
                }
              }}
              value={draft.publicHolidays}
            >
              {(['inherit', 'japan', 'none'] as const).map((choice) => (
                <option key={choice} value={choice}>{t(publicHolidayLabelKeys[choice])}</option>
              ))}
            </select>
          </label>
          <div className="grid gap-2">
            <label className="text-sm font-semibold text-[var(--workbench-text)]" htmlFor="work-calendar-holiday-draft">
              {t('workspace.workCalendar.additionalHolidays')}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="workbench-input h-10 px-3"
                data-testid="work-calendar-holiday-draft"
                disabled={readOnly}
                id="work-calendar-holiday-draft"
                onChange={(event) => setHolidayDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  addHoliday()
                }}
                type="date"
                value={holidayDraft}
              />
              <button
                className="workbench-button-secondary"
                data-testid="work-calendar-holiday-add"
                disabled={readOnly || !canAddWorkCalendarHoliday(draft, holidayDraft)}
                onClick={addHoliday}
                type="button"
              >
                {t('workspace.tenantAdministration.addHoliday')}
              </button>
            </div>
            {draft.additionalHolidays.length === 0 ? (
              <p className="text-xs text-[var(--workbench-muted)]">{t('workspace.workCalendar.noAdditionalHolidays')}</p>
            ) : (
              <ul className="flex flex-wrap gap-2" data-testid="work-calendar-holiday-list">
                {draft.additionalHolidays.map((holiday) => (
                  <li
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--workbench-border)] px-2 py-1 text-sm text-[var(--workbench-text)]"
                    key={holiday}
                  >
                    <time dateTime={holiday}>{holiday}</time>
                    <button
                      aria-label={t('workspace.tenantAdministration.removeHoliday').replace('{date}', holiday)}
                      className="px-1 text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]"
                      disabled={readOnly}
                      onClick={() => props.onDraftChange(removeWorkCalendarHoliday(draft, holiday))}
                      type="button"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <WorkCalendarAdjustmentFields
            adjustment={draft.adjustment}
            disabled={readOnly}
            onChange={(adjustment) => props.onDraftChange({ ...draft, adjustment })}
            t={t}
          />
          {calendar.canManage ? (
            <div className="flex flex-wrap gap-2">
              <button
                className="workbench-button-secondary"
                data-testid="work-calendar-preview"
                disabled={isBusy}
                onClick={props.onPreview}
                type="button"
              >
                {t('workspace.workCalendar.preview')}
              </button>
              <button
                className="workbench-button-primary"
                data-testid="work-calendar-save"
                disabled={isBusy || !impact}
                onClick={props.onSave}
                type="button"
              >
                {t('workspace.workCalendar.save')}
              </button>
            </div>
          ) : null}
          {impact ? <WorkCalendarImpactSummary impact={impact} t={t} /> : null}
          {result ? <WorkCalendarResultSummary result={result} t={t} /> : null}
        </>
      )}
    </section>
  )
}

/** Props of the adjustment choice. */
export type WorkCalendarAdjustmentFieldsProps = {
  /** Chosen adjustment. */
  adjustment: WorkCalendarAdjustment
  /** Whether the choice is locked. */
  disabled: boolean
  /** Receives the new choice. */
  onChange: (adjustment: WorkCalendarAdjustment) => void
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Chooses whether Work Items keep their working days or their end dates when a calendar changes.
 *
 * @param props - Choice, lock state, callback, and translator.
 * @returns The radio group.
 */
export function WorkCalendarAdjustmentFields({ adjustment, disabled, onChange, t }: WorkCalendarAdjustmentFieldsProps) {
  return (
    <fieldset className="grid gap-1">
      <legend className="text-sm font-semibold text-[var(--workbench-text)]">{t('workspace.workCalendar.adjustment')}</legend>
      {WORK_CALENDAR_ADJUSTMENTS.map((choice) => (
        <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]" key={choice}>
          <input
            checked={adjustment === choice}
            data-testid={`work-calendar-adjustment-${choice}`}
            disabled={disabled}
            name="work-calendar-adjustment"
            onChange={() => onChange(choice)}
            type="radio"
          />
          {t(workCalendarAdjustmentLabelKeys[choice])}
        </label>
      ))}
    </fieldset>
  )
}

/** Props of the impact summary. */
export type WorkCalendarImpactSummaryProps = {
  /** Previewed impact. */
  impact: WorkCalendarChangeImpact
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Shows how many Work Items a calendar change adjusts, with examples of the date changes.
 *
 * @param props - Impact and translator.
 * @returns The summary.
 */
export function WorkCalendarImpactSummary({ impact, t }: WorkCalendarImpactSummaryProps) {
  return (
    <div className="grid gap-2" data-testid="work-calendar-impact">
      <p className="text-sm text-[var(--workbench-text)]">
        {t('workspace.workCalendar.impact')
          .replace('{following}', String(impact.followingCount))
          .replace('{changed}', String(impact.changedCount))}
      </p>
      {impact.fallbackToKeepDurationCount > 0 ? (
        <p className="text-xs text-[var(--workbench-muted)]">
          {t('workspace.workCalendar.impactFallback').replace('{count}', String(impact.fallbackToKeepDurationCount))}
        </p>
      ) : null}
      {impact.examples.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-[var(--workbench-muted)]">
              <tr>
                <th className="py-1 pr-3 font-medium">{t('workspace.workCalendar.example.workItem')}</th>
                <th className="py-1 pr-3 font-medium">{t('workspace.workCalendar.example.before')}</th>
                <th className="py-1 font-medium">{t('workspace.workCalendar.example.after')}</th>
              </tr>
            </thead>
            <tbody>
              {impact.examples.map((example) => (
                <tr className="border-t border-[var(--workbench-border)]" key={`${example.teamId}/${example.workItemId}`}>
                  <td className="py-1 pr-3">{example.key ? `${example.key} ` : ''}{example.title}</td>
                  <td className="py-1 pr-3 tabular-nums">
                    {formatDates(example.before, t)}
                  </td>
                  <td className="py-1 tabular-nums">{formatDates(example.after, t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

/** Props of the save result summary. */
export type WorkCalendarResultSummaryProps = {
  /** Result of the save. */
  result: WorkCalendarChangeResult
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Shows how many Work Items a calendar save rewrote, and how many changed meanwhile.
 *
 * @param props - Result and translator.
 * @returns The summary.
 */
export function WorkCalendarResultSummary({ result, t }: WorkCalendarResultSummaryProps) {
  return (
    <div className="grid gap-1 text-sm" data-testid="work-calendar-result" role="status">
      <p className="text-[var(--workbench-text)]">
        {t('workspace.workCalendar.saved').replace('{count}', String(result.updatedCount))}
      </p>
      {result.conflictCount > 0 ? (
        <p className="text-[var(--workbench-danger)]">
          {t('workspace.workCalendar.savedWithConflicts').replace('{count}', String(result.conflictCount))}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Formats the dates of a changed Work Item.
 *
 * @param dates - Start, end, and working days.
 * @param t - Translator.
 * @returns Text such as `2026-12-07 – 2026-12-11 (5 days)`.
 */
function formatDates(
  dates: { startDate: string, endDate: string, durationDays: number },
  t: (key: MessageKey) => string,
): string {
  return `${dates.startDate} – ${dates.endDate} ${t('workspace.workCalendar.example.days').replace('{count}', String(dates.durationDays))}`
}
