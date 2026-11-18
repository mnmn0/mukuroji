import {
  NOTIFICATION_REMINDER_DAY_FIELDS,
  NOTIFICATION_REMINDER_DAYS_MAXIMUM,
  PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS,
  type PersonalNotificationReminderDays,
  type TeamNotificationReminderDays,
} from '@mukuroji/contracts'
import { NotificationError } from './notification-error'

/**
 * Reports whether a value is an accepted reminder day threshold.
 *
 * @param value - Untrusted value.
 * @returns Whether the value is an integer from 1 to the shared maximum.
 */
export function isNotificationReminderDayCount(value: unknown): value is number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= NOTIFICATION_REMINDER_DAYS_MAXIMUM
}

/**
 * Validates a member's own reminder overrides. A field that is absent or `null` is unset.
 *
 * @param value - Untrusted overrides from a request or a stored row.
 * @returns The overrides with only the set fields.
 * @throws NotificationError (400) for a non-object, an unknown field, or an invalid day count.
 */
export function normalizePersonalReminderDays(value: unknown): PersonalNotificationReminderDays {
  return normalizeReminderDays(value, PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS)
}

/**
 * Validates a Team's reminder overrides. A field that is absent or `null` is unset.
 *
 * @param value - Untrusted overrides from a request or a stored row.
 * @returns The overrides with only the set fields.
 * @throws NotificationError (400) for a non-object, an unknown field, or an invalid day count.
 */
export function normalizeTeamReminderDays(value: unknown): TeamNotificationReminderDays {
  return normalizeReminderDays(value, NOTIFICATION_REMINDER_DAY_FIELDS)
}

/**
 * Reports whether two sets of overrides set the same fields to the same values.
 *
 * @param left - First overrides.
 * @param right - Second overrides.
 * @returns Whether both are equal.
 */
export function reminderDaysEqual(
  left: TeamNotificationReminderDays | undefined,
  right: TeamNotificationReminderDays | undefined,
): boolean {
  return NOTIFICATION_REMINDER_DAY_FIELDS.every((field) => left?.[field] === right?.[field])
}

/**
 * Validates reminder overrides against an allowed field list.
 *
 * @param value - Untrusted overrides.
 * @param fields - Fields the caller may set.
 * @returns The overrides with only the set fields.
 * @throws NotificationError (400) for a non-object, an unknown field, or an invalid day count.
 */
function normalizeReminderDays<Field extends string>(
  value: unknown,
  fields: readonly Field[],
): Partial<Record<Field, number>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NotificationError(400, 'InvalidNotificationReminderDays', 'Reminder days must be an object.')
  }
  const allowed = new Set<string>(fields)
  const normalized: Partial<Record<Field, number>> = {}
  for (const [field, days] of Object.entries(value)) {
    if (!allowed.has(field)) {
      throw new NotificationError(
        400,
        'InvalidNotificationReminderDays',
        `Reminder days field "${field}" is not supported.`,
      )
    }
    if (days === null || days === undefined) continue
    if (!isNotificationReminderDayCount(days)) {
      throw new NotificationError(
        400,
        'InvalidNotificationReminderDays',
        `Reminder days must be integers between 1 and ${NOTIFICATION_REMINDER_DAYS_MAXIMUM}.`,
      )
    }
    for (const candidate of fields) {
      if (candidate === field) normalized[candidate] = days
    }
  }
  return normalized
}
