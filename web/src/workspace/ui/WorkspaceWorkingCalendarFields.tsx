import { useState } from 'react'
import {
  WORKSPACE_CALENDAR_WEEKDAYS,
  isWorkspaceTimeZone,
  type WorkspaceCalendarSettings,
  type WorkspaceCalendarWeekday,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  addWorkspaceHoliday,
  canAddWorkspaceHoliday,
  removeWorkspaceHoliday,
  setWorkspaceWorkingWeekday,
} from '../model/workspaceWorkingCalendar'

/** Label keys of each working weekday checkbox. */
const workingWeekdayLabelKeys: Record<WorkspaceCalendarWeekday, MessageKey> = {
  monday: 'workspace.tenantAdministration.weekday.monday',
  tuesday: 'workspace.tenantAdministration.weekday.tuesday',
  wednesday: 'workspace.tenantAdministration.weekday.wednesday',
  thursday: 'workspace.tenantAdministration.weekday.thursday',
  friday: 'workspace.tenantAdministration.weekday.friday',
  saturday: 'workspace.tenantAdministration.weekday.saturday',
  sunday: 'workspace.tenantAdministration.weekday.sunday',
}

/** Props of the Workspace working weekday and holiday editor. */
export type WorkspaceWorkingCalendarFieldsProps = {
  /** Calendar settings being edited. */
  calendar: WorkspaceCalendarSettings
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited calendar settings. */
  onChange: (calendar: WorkspaceCalendarSettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Edits the Workspace time zone, the weekdays the whole Workspace works on, whether national
 * holidays are days off, and its company holidays.
 *
 * New Work Items count working days with these settings, so at least one weekday always stays
 * checked and holidays stay sorted without duplicates.
 *
 * @param props - Calendar draft, lock state, change callback, and translator.
 * @returns The working weekday checkboxes and the holiday list editor.
 */
export function WorkspaceWorkingCalendarFields({
  calendar,
  disabled,
  onChange,
  t,
}: WorkspaceWorkingCalendarFieldsProps) {
  const [holidayDraft, setHolidayDraft] = useState('')
  const [timeZoneDraft, setTimeZoneDraft] = useState(calendar.timeZone)
  const [appliedTimeZone, setAppliedTimeZone] = useState(calendar.timeZone)
  const [timeZoneOptions] = useState(listTimeZoneOptions)
  // A calendar replaced from outside, such as after a reload, brings its own time zone.
  if (appliedTimeZone !== calendar.timeZone) {
    setAppliedTimeZone(calendar.timeZone)
    setTimeZoneDraft(calendar.timeZone)
  }
  const timeZoneDraftValid = isWorkspaceTimeZone(timeZoneDraft.trim())
  const canAddHoliday = !disabled && canAddWorkspaceHoliday(calendar, holidayDraft)

  /**
   * Turns one weekday on or off, keeping at least one working weekday.
   *
   * @param weekday - Weekday whose checkbox changed.
   * @param checked - Whether the weekday is now a working day.
   */
  function toggleWorkingWeekday(weekday: WorkspaceCalendarWeekday, checked: boolean) {
    const next = setWorkspaceWorkingWeekday(calendar, weekday, checked)
    if (next) onChange(next)
  }

  /** Adds the drafted date to the holidays and clears the draft. */
  function addHoliday() {
    if (disabled) return
    const next = addWorkspaceHoliday(calendar, holidayDraft)
    if (!next) return
    onChange(next)
    setHolidayDraft('')
  }

  /**
   * Keeps the typed time zone and applies it once it names a real time zone.
   *
   * @param value - Text in the time zone field.
   */
  function changeTimeZone(value: string) {
    setTimeZoneDraft(value)
    const timeZone = value.trim()
    if (!isWorkspaceTimeZone(timeZone) || timeZone === calendar.timeZone) return
    setAppliedTimeZone(timeZone)
    onChange({ ...calendar, timeZone })
  }

  return (
    <div className="mt-5 grid gap-5" data-testid="tenant-working-calendar">
      <div className="grid gap-1.5">
        <label className="text-sm font-semibold text-[var(--workbench-text)]" htmlFor="tenant-time-zone">
          {t('workspace.tenantAdministration.timeZone')}
        </label>
        <input
          aria-describedby="tenant-time-zone-hint"
          aria-invalid={!timeZoneDraftValid}
          autoComplete="off"
          className="workbench-input h-10 max-w-xs px-3"
          data-testid="tenant-time-zone"
          disabled={disabled}
          id="tenant-time-zone"
          list="tenant-time-zone-options"
          onChange={(event) => changeTimeZone(event.target.value)}
          spellCheck={false}
          type="text"
          value={timeZoneDraft}
        />
        <datalist id="tenant-time-zone-options">
          {timeZoneOptions.map((timeZone) => <option key={timeZone} value={timeZone} />)}
        </datalist>
        <p className="text-xs text-[var(--workbench-muted)]" id="tenant-time-zone-hint">
          {t('workspace.tenantAdministration.timeZoneHint')}
        </p>
        {timeZoneDraftValid ? null : (
          <p className="text-xs font-semibold text-[var(--workbench-danger)]" data-testid="tenant-time-zone-invalid" role="alert">
            {t('workspace.tenantAdministration.timeZoneInvalid')}
          </p>
        )}
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-semibold text-[var(--workbench-text)]">
          {t('workspace.tenantAdministration.workingWeekdays')}
        </legend>
        <p className="text-xs text-[var(--workbench-muted)]">
          {t('workspace.tenantAdministration.workingCalendarHint')}
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {WORKSPACE_CALENDAR_WEEKDAYS.map((weekday) => {
            const checked = calendar.workingWeekdays.includes(weekday)
            return (
              <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]" key={weekday}>
                <input
                  checked={checked}
                  data-testid={`tenant-working-weekday-${weekday}`}
                  disabled={disabled || (checked && calendar.workingWeekdays.length === 1)}
                  onChange={(event) => toggleWorkingWeekday(weekday, event.target.checked)}
                  type="checkbox"
                />
                {t(workingWeekdayLabelKeys[weekday])}
              </label>
            )
          })}
        </div>
      </fieldset>
      <div className="grid gap-1">
        <label className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
          <input
            checked={calendar.publicHolidays === 'japan'}
            data-testid="tenant-public-holidays"
            disabled={disabled}
            onChange={(event) => onChange({ ...calendar, publicHolidays: event.target.checked ? 'japan' : 'none' })}
            type="checkbox"
          />
          {t('workspace.tenantAdministration.publicHolidays')}
        </label>
        <p className="text-xs text-[var(--workbench-muted)]">
          {t('workspace.tenantAdministration.publicHolidaysHint')}
        </p>
      </div>
      <div className="grid gap-2">
        <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]" htmlFor="tenant-holiday-draft">
          {t('workspace.tenantAdministration.holidays')}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="workbench-input h-10 px-3"
            data-testid="tenant-holiday-draft"
            disabled={disabled}
            id="tenant-holiday-draft"
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
            data-testid="tenant-holiday-add"
            disabled={!canAddHoliday}
            onClick={addHoliday}
            type="button"
          >
            {t('workspace.tenantAdministration.addHoliday')}
          </button>
        </div>
        {calendar.holidays.length === 0 ? (
          <p className="text-xs text-[var(--workbench-muted)]">
            {t('workspace.tenantAdministration.noHolidays')}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2" data-testid="tenant-holiday-list">
            {calendar.holidays.map((holiday) => (
              <li
                className="inline-flex items-center gap-1 rounded-md border border-[var(--workbench-border)] px-2 py-1 text-sm text-[var(--workbench-text)]"
                key={holiday}
              >
                <time dateTime={holiday}>{holiday}</time>
                <button
                  aria-label={t('workspace.tenantAdministration.removeHoliday').replace('{date}', holiday)}
                  className="px-1 text-[var(--workbench-muted)] hover:text-[var(--workbench-text)]"
                  disabled={disabled}
                  onClick={() => onChange(removeWorkspaceHoliday(calendar, holiday))}
                  type="button"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/**
 * Lists the time zone names the browser knows, for the time zone field's suggestions.
 *
 * @returns IANA names, or a few common ones when the browser cannot list them.
 */
function listTimeZoneOptions(): string[] {
  const supportedValuesOf: unknown = Reflect.get(Intl, 'supportedValuesOf')
  if (typeof supportedValuesOf === 'function') {
    const values: unknown = supportedValuesOf.call(Intl, 'timeZone')
    if (Array.isArray(values) && values.every((value) => typeof value === 'string')) {
      return values.includes('UTC') ? values : ['UTC', ...values]
    }
  }
  return ['Asia/Tokyo', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Singapore']
}
