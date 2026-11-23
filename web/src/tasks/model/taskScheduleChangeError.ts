import { TeamIssuesApiError } from '../../issues/api'
import type { MessageKey } from '../../shared/i18n/i18n'

/**
 * Preserves permission and revision details exposed by the parent callback.
 *
 * @param error - Unknown callback failure.
 * @param t - Translator used for the generic fallback.
 * @returns A safe message for the Calendar or table alert.
 */
export function resolveCalendarScheduleError(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof TeamIssuesApiError) {
    if (error.code === 'WorkItemRevisionConflict') {
      return t('tasks.action.conflict')
    }
    if (error.status === 403) {
      return t('tasks.action.permission')
    }
    if (error.status === 400) {
      return t('tasks.schedule.invalid')
    }
  }
  return t('tasks.action.updateError')
}
