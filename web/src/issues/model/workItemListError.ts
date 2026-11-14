import type { MessageKey } from '../../shared/i18n/i18n'
import { TeamIssuesApiError } from '../api/errors'

/**
 * Describes why a Team or Project Work Item list could not be loaded, when the cause is one the
 * viewer can act on.
 *
 * A list over the item limit, or a cursor read that did not finish, shows its own message and
 * the API's message as the cause instead of the generic loading error.
 *
 * @param error - Error raised by the list query.
 * @param t - Translator of the current locale.
 * @returns The message to show, or `undefined` when the generic loading error applies.
 */
export function describeScopedWorkItemListError(
  error: unknown,
  t: (key: MessageKey) => string,
): string | undefined {
  if (!(error instanceof TeamIssuesApiError)) return undefined
  const key: MessageKey | undefined = error.code === 'WorkItemListLimitExceeded'
    ? 'tasks.error.scopeLimitExceeded'
    : error.code === 'WorkItemListReadStalled'
      ? 'tasks.error.readStalled'
      : undefined
  if (!key) return undefined
  return error.message
    ? `${t(key)} ${t('tasks.error.reason').replace('{reason}', error.message)}`
    : t(key)
}
