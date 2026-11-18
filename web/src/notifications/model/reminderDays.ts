import {
  getNotificationReminderDaysMaximum,
  type NotificationReminderDayField,
} from '@mukuroji/contracts'

/** Text typed into each reminder field; a missing or empty value leaves the field unset. */
export type ReminderDaysDraft<Field extends NotificationReminderDayField> = Partial<Record<Field, string>>

/**
 * Builds the draft text of each field from saved overrides.
 *
 * @param fields - Fields shown.
 * @param saved - Saved overrides.
 * @returns Text per field; unset fields are empty.
 */
export function createReminderDaysDraft<Field extends NotificationReminderDayField>(
  fields: readonly Field[],
  saved: Partial<Record<Field, number>> | undefined,
): ReminderDaysDraft<Field> {
  const draft: ReminderDaysDraft<Field> = {}
  for (const field of fields) {
    const value = saved?.[field]
    if (value !== undefined) draft[field] = String(value)
  }
  return draft
}

/**
 * Converts draft text into overrides.
 *
 * @param fields - Fields shown.
 * @param draft - Draft text.
 * @returns The overrides, or undefined when a field is not a whole number from 1 to the maximum.
 */
export function readReminderDaysDraft<Field extends NotificationReminderDayField>(
  fields: readonly Field[],
  draft: ReminderDaysDraft<Field>,
): Partial<Record<Field, number>> | undefined {
  const days: Partial<Record<Field, number>> = {}
  for (const field of fields) {
    const text = draft[field]?.trim() ?? ''
    if (!text) continue
    if (!/^\d+$/u.test(text)) return undefined
    const value = Number(text)
    if (value < 1 || value > getNotificationReminderDaysMaximum(field)) return undefined
    days[field] = value
  }
  return days
}
