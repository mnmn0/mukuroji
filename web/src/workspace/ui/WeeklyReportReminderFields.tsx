import type { WeeklyReportReminderSettings, WeeklyReportReminderSlot } from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Weekdays offered, Monday first, with their label keys. */
const weekdayOptions: ReadonlyArray<readonly [number, MessageKey]> = [
  [1, 'workspace.tenantAdministration.weekday.monday'],
  [2, 'workspace.tenantAdministration.weekday.tuesday'],
  [3, 'workspace.tenantAdministration.weekday.wednesday'],
  [4, 'workspace.tenantAdministration.weekday.thursday'],
  [5, 'workspace.tenantAdministration.weekday.friday'],
  [6, 'workspace.tenantAdministration.weekday.saturday'],
  [0, 'workspace.tenantAdministration.weekday.sunday'],
]

/** Hours offered, 0 to 23. */
const hourOptions = Array.from({ length: 24 }, (_, hour) => hour)

/** Props of the weekly report reminder editor. */
export type WeeklyReportReminderFieldsProps = {
  /** Settings being edited. */
  settings: WeeklyReportReminderSettings
  /** Whether the fields are read-only, for example while the tenant is closing. */
  disabled: boolean
  /** Receives the edited settings. */
  onChange: (settings: WeeklyReportReminderSettings) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/** Props of one weekday-and-hour picker. */
type SlotFieldsProps = {
  /** Prefix of the test IDs. */
  id: string
  /** Accessible group label. */
  label: string
  /** Slot being edited. */
  slot: WeeklyReportReminderSlot
  /** Whether the pickers are read-only. */
  disabled: boolean
  /** Receives the edited slot. */
  onChange: (slot: WeeklyReportReminderSlot) => void
  /** Translator for labels. */
  t: (key: MessageKey) => string
}

/**
 * Renders a weekday select and an hour select for one weekly notice.
 *
 * @param props - Slot, lock state, change callback, and translator.
 * @returns The two selects.
 */
function SlotFields({ id, label, slot, disabled, onChange, t }: SlotFieldsProps) {
  return (
    <div aria-label={label} className="flex flex-wrap items-center gap-2" role="group">
      <select
        aria-label={`${label} ${t('workspace.tenantAdministration.weeklyReportReminders.weekday')}`}
        className="workbench-input h-10"
        data-testid={`${id}-weekday`}
        disabled={disabled}
        onChange={(event) => onChange({ ...slot, weekday: Number(event.target.value) })}
        value={slot.weekday}
      >
        {weekdayOptions.map(([weekday, key]) => <option key={weekday} value={weekday}>{t(key)}</option>)}
      </select>
      <select
        aria-label={`${label} ${t('workspace.tenantAdministration.weeklyReportReminders.hour')}`}
        className="workbench-input h-10"
        data-testid={`${id}-hour`}
        disabled={disabled}
        onChange={(event) => onChange({ ...slot, hour: Number(event.target.value) })}
        value={slot.hour}
      >
        {hourOptions.map((hour) => (
          <option key={hour} value={hour}>
            {t('workspace.tenantAdministration.weeklyReportReminders.hourOption').replace('{hour}', String(hour))}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Tells whether both notices are on in the same weekday and hour, which the server rejects.
 *
 * @param settings - Settings being edited.
 * @returns Whether the two slots collide.
 */
export function hasWeeklyReportReminderConflict(settings: WeeklyReportReminderSettings): boolean {
  return settings.enabled && settings.escalationEnabled &&
    settings.reminder.weekday === settings.escalation.weekday &&
    settings.reminder.hour === settings.escalation.hour
}

/**
 * Edits whether and when authors of unsubmitted weekly reports, and then their Project managers,
 * are notified. Times are in Japan time.
 *
 * @param props - Settings draft, lock state, change callback, and translator.
 * @returns The reminder and escalation controls.
 */
export function WeeklyReportReminderFields({ settings, disabled, onChange, t }: WeeklyReportReminderFieldsProps) {
  const conflict = hasWeeklyReportReminderConflict(settings)
  return (
    <fieldset className="mt-5 grid gap-3" data-testid="tenant-weekly-report-reminders">
      <legend className="text-sm font-semibold text-[var(--workbench-text)]">
        {t('workspace.tenantAdministration.weeklyReportReminders.title')}
      </legend>
      <p className="text-xs text-[var(--workbench-muted)]">
        {t('workspace.tenantAdministration.weeklyReportReminders.hint')}
      </p>
      <div className="grid gap-2">
        <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]">
          <input
            checked={settings.enabled}
            data-testid="tenant-weekly-report-reminder-enabled"
            disabled={disabled}
            onChange={(event) => onChange({ ...settings, enabled: event.target.checked })}
            type="checkbox"
          />
          {t('workspace.tenantAdministration.weeklyReportReminders.reminder')}
        </label>
        <SlotFields
          disabled={disabled || !settings.enabled}
          id="tenant-weekly-report-reminder"
          label={t('workspace.tenantAdministration.weeklyReportReminders.reminder')}
          onChange={(reminder) => onChange({ ...settings, reminder })}
          slot={settings.reminder}
          t={t}
        />
      </div>
      <div className="grid gap-2">
        <label className="inline-flex items-center gap-1.5 text-sm text-[var(--workbench-text)]">
          <input
            checked={settings.escalationEnabled}
            data-testid="tenant-weekly-report-escalation-enabled"
            disabled={disabled || !settings.enabled}
            onChange={(event) => onChange({ ...settings, escalationEnabled: event.target.checked })}
            type="checkbox"
          />
          {t('workspace.tenantAdministration.weeklyReportReminders.escalation')}
        </label>
        <SlotFields
          disabled={disabled || !settings.enabled || !settings.escalationEnabled}
          id="tenant-weekly-report-escalation"
          label={t('workspace.tenantAdministration.weeklyReportReminders.escalation')}
          onChange={(escalation) => onChange({ ...settings, escalation })}
          slot={settings.escalation}
          t={t}
        />
      </div>
      {conflict ? (
        <p className="text-xs text-fg-red-700" role="alert">
          {t('workspace.tenantAdministration.weeklyReportReminders.conflict')}
        </p>
      ) : null}
    </fieldset>
  )
}
