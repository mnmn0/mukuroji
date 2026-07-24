import type { MessageKey } from '../../shared/i18n/i18n'

/**
 * Inputs for the non-blocking Workspace Work Item load notice.
 */
export type WorkspaceTaskLoadNoticeProps = {
  /** Number of Projects whose Work Item projection is unavailable. */
  failedProjectCount: number
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Displays a partial Work Item load error without hiding available route content.
 *
 * @param props - Failure count and localized message resolver.
 * @returns An alert when at least one Project failed, otherwise null.
 */
export function WorkspaceTaskLoadNotice({
  failedProjectCount,
  t,
}: WorkspaceTaskLoadNoticeProps) {
  if (failedProjectCount === 0) {
    return null
  }

  return (
    <p
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
      data-testid="workspace-task-partial-error"
      role="alert"
    >
      {t('tasks.error.loading')} ({failedProjectCount})
    </p>
  )
}

/**
 * Inputs for the retryable My Tasks configuration notice.
 */
export type WorkspaceConfigurationLoadNoticeProps = {
  /** Number of Team configurations that could not be loaded. */
  failedTeamCount: number
  /** Optional retry callback for the shared configuration query. */
  onRetry?: () => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Displays a retryable Team configuration warning above the My Tasks board.
 *
 * @param props - Failure count, retry callback, and localized message resolver.
 * @returns A retryable alert when at least one Team failed, otherwise null.
 */
export function WorkspaceConfigurationLoadNotice({
  failedTeamCount,
  onRetry,
  t,
}: WorkspaceConfigurationLoadNoticeProps) {
  if (failedTeamCount === 0) {
    return null
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
      data-testid="my-tasks-configuration-error"
      role="alert"
    >
      <span>{t('workItems.configuration.loadError')}</span>
      {onRetry ? (
        <button
          className="underline underline-offset-2"
          onClick={onRetry}
          type="button"
        >
          {t('collaboration.retry')}
        </button>
      ) : null}
    </div>
  )
}
