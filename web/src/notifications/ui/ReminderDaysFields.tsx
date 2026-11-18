import {
  getNotificationReminderDaysMaximum,
  type NotificationReminderDayField,
} from '@mukuroji/contracts'
import type { MessageKey } from '../../shared/i18n/i18n'
import type { ReminderDaysDraft } from '../model/reminderDays'

/** Label of each reminder field. */
const reminderFieldLabelKeys: Record<NotificationReminderDayField, MessageKey> = {
  dueSoonDays: 'workspace.reminders.field.dueSoonDays',
  overdueReminderIntervalDays: 'workspace.reminders.field.overdueReminderIntervalDays',
  overdueEscalationDays: 'workspace.reminders.field.overdueEscalationDays',
  staleStartedDays: 'workspace.reminders.field.staleStartedDays',
  timesheetReminderDays: 'workspace.reminders.field.timesheetReminderDays',
}

/** Props of {@link ReminderDaysFields}. */
export type ReminderDaysFieldsProps<Field extends NotificationReminderDayField> = {
  /** Fields to show, in order. */
  fields: readonly Field[]
  /** Current text of each field. */
  draft: ReminderDaysDraft<Field>
  /** Called with the new text of one field. */
  onChange: (field: Field, value: string) => void
  /** Placeholder for each field, describing the value a blank field inherits. */
  placeholderFor: (field: Field) => string
  /** Whether the inputs are read-only. */
  disabled?: boolean
  /** Prefix for the inputs' `data-testid`. */
  testIdPrefix: string
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders one numeric day input per reminder threshold. A blank input inherits the value its
 * placeholder names.
 *
 * @param props - Fields, draft text, and change handler.
 * @returns The inputs.
 */
export function ReminderDaysFields<Field extends NotificationReminderDayField>({
  fields,
  draft,
  onChange,
  placeholderFor,
  disabled = false,
  testIdPrefix,
  t,
}: ReminderDaysFieldsProps<Field>) {
  return (
    <div className="grid gap-2">
      {fields.map((field) => (
        <label
          className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] px-4 py-3"
          key={field}
        >
          <span className="min-w-0 flex-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t(reminderFieldLabelKeys[field])}
          </span>
          <span className="flex flex-none items-center gap-2">
            <input
              className="workbench-input min-h-10 w-[120px] px-3 disabled:bg-slate-100"
              data-testid={`${testIdPrefix}-${field}`}
              disabled={disabled}
              inputMode="numeric"
              max={getNotificationReminderDaysMaximum(field)}
              min={1}
              placeholder={placeholderFor(field)}
              step={1}
              type="number"
              value={draft[field] ?? ''}
              onChange={(event) => onChange(field, event.target.value)}
            />
            <span className="text-xs font-semibold text-[var(--workbench-muted)]">
              {t('workspace.reminders.daysUnit')}
            </span>
          </span>
        </label>
      ))}
    </div>
  )
}
