import type { ProjectDecisionStatus } from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import { ProjectDirectoryApiError } from '../api/errors'

/**
 * Names the message key of a decision status.
 *
 * @param status - Decision status.
 * @returns The message key.
 */
export function decisionStatusMessageKey(status: ProjectDecisionStatus): MessageKey {
  if (status === 'superseded') return 'projects.decisionLog.status.superseded'
  if (status === 'withdrawn') return 'projects.decisionLog.status.withdrawn'
  return 'projects.decisionLog.status.active'
}

/**
 * Describes a failed save for the person who tried it.
 *
 * @param error - Thrown error.
 * @param t - Translator.
 * @returns The message.
 */
export function describeProjectDecisionSaveError(error: unknown, t: (key: MessageKey) => string) {
  if (error instanceof ProjectDirectoryApiError) {
    if (error.status === 409) return t('projects.decisionLog.error.conflict')
    if (error.status === 403) return t('projects.decisionLog.error.forbidden')
    if (error.status === 413) return t('projects.decisionLog.error.full')
    if (error.status === 400) return t('projects.decisionLog.error.invalid').replace('{reason}', error.message)
  }
  return t('projects.decisionLog.error.save')
}

/**
 * Creates a formatter of timestamps for the viewer's locale and time zone.
 *
 * @param locale - Display locale.
 * @returns The formatter function.
 */
export function createDecisionDateTimeFormatter(locale: Locale) {
  const formatter = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
  return (value: string) => formatter.format(new Date(value))
}
