import { TeamIssuesApiError } from '../../issues/api/errors'
import type { MessageKey } from '../../shared/i18n/i18n'

/**
 * Inputs for the non-blocking Workspace Work Item load notice.
 */
export type WorkspaceTaskLoadNoticeProps = {
  /** Error that stopped the Work Item read, used to explain the cause. */
  error?: unknown
  /** Number of Projects whose Work Item projection is unavailable. */
  failedProjectCount: number
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Displays a partial Work Item load error without hiding available route content.
 *
 * A list that is too large to load gets its own explanation of how to narrow it; other failures
 * show the reason the API returned.
 *
 * @param props - Load error, failure count, and localized message resolver.
 * @returns An alert when at least one Project failed, otherwise null.
 */
export function WorkspaceTaskLoadNotice({
  error,
  failedProjectCount,
  t,
}: WorkspaceTaskLoadNoticeProps) {
  if (failedProjectCount === 0) {
    return null
  }

  const isLimitExceeded = error instanceof TeamIssuesApiError &&
    error.code === 'WorkItemListLimitExceeded'
  const reason = error instanceof Error && error.message ? error.message : undefined

  return (
    <div
      className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-fg-amber-800"
      data-testid="workspace-task-partial-error"
      role="alert"
    >
      <p>
        {isLimitExceeded
          ? t('tasks.error.limitExceeded')
          : `${t('tasks.error.loading')} (${failedProjectCount})`}
      </p>
      {reason ? (
        <p className="mt-1 text-xs font-medium" data-testid="workspace-task-error-reason">
          {t('tasks.error.reason').replace('{reason}', reason)}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Inputs for a retryable Workspace Team configuration notice.
 */
export type WorkspaceConfigurationLoadNoticeProps = {
  /** Number of Team configurations that could not be loaded. */
  failedTeamCount: number
  /** Optional retry callback for the shared configuration query. */
  onRetry?: () => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Test identifier owned by the route that displays the notice. */
  testId?: string
}

/**
 * Displays a retryable Team configuration warning above a Work Item surface.
 *
 * @param props - Failure count, retry callback, and localized message resolver.
 * @returns A retryable alert when at least one Team failed, otherwise null.
 */
export function WorkspaceConfigurationLoadNotice({
  failedTeamCount,
  onRetry,
  t,
  testId = 'my-tasks-configuration-error',
}: WorkspaceConfigurationLoadNoticeProps) {
  if (failedTeamCount === 0) {
    return null
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-fg-amber-800"
      data-testid={testId}
      role="alert"
    >
      <span>{t('workItems.configuration.loadError')}</span>
      {onRetry ? (
        <button
          className="min-h-[44px] px-2 underline underline-offset-2"
          onClick={onRetry}
          type="button"
        >
          {t('collaboration.retry')}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Inputs for the retryable Focus projection notice used by overview routes.
 */
export type WorkspaceFocusLoadNoticeProps = {
  /** Whether stale Focus data remains available after the latest request failed. */
  hasCachedData: boolean
  /** Whether the latest Focus request failed. */
  hasError: boolean
  /** Optional callback that retries the Focus query. */
  onRetry?: () => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Distinguishes unavailable Focus projections from real empty and zero states.
 *
 * @param props - Query state, retry callback, and localized message resolver.
 * @returns A non-blocking retry alert when the latest Focus request failed.
 */
export function WorkspaceFocusLoadNotice({
  hasCachedData,
  hasError,
  onRetry,
  t,
}: WorkspaceFocusLoadNoticeProps) {
  if (!hasError) return null

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-fg-amber-800"
      data-testid="workspace-focus-load-error"
      role="alert"
    >
      <span>
        {t(hasCachedData
          ? 'workspace.focus.overviewStale'
          : 'workspace.focus.overviewUnavailable')}
      </span>
      {onRetry ? (
        <button
          className="min-h-[44px] px-2 underline underline-offset-2"
          onClick={onRetry}
          type="button"
        >
          {t('workspace.focus.retry')}
        </button>
      ) : null}
    </div>
  )
}
