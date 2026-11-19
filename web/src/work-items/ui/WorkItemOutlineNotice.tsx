import type { MessageKey } from '../../shared/i18n/i18n'

/** Props of {@link WorkItemOutlineNotice}. */
export type WorkItemOutlineNoticeProps = {
  /** Number of Teams whose hierarchy could not be read. */
  failedTeamCount: number
  /** Whether the first read is in flight. */
  isLoading: boolean
  /** Whether a read, such as a retry, is in flight. */
  isRetrying: boolean
  /** Reads the hierarchies again. */
  onRetry: () => void
  /** Translator for the notice. */
  t: (key: MessageKey) => string
  /** Prefix of the test IDs. */
  testId: string
}

/**
 * Tells the viewer that a cross-Team outline is loading or that some Teams are shown flat.
 *
 * @param props - Read state and retry action.
 * @returns The notice, or nothing while the outline is complete.
 */
export function WorkItemOutlineNotice({
  failedTeamCount,
  isLoading,
  isRetrying,
  onRetry,
  t,
  testId,
}: WorkItemOutlineNoticeProps) {
  if (isLoading) {
    return (
      <p
        className="mt-3 text-sm font-semibold text-[var(--workbench-muted)]"
        data-testid={`${testId}-loading`}
        role="status"
      >
        {t('tasks.outline.loading')}
      </p>
    )
  }
  if (failedTeamCount === 0) return null
  return (
    <div
      className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
      data-testid={`${testId}-unavailable`}
    >
      <p className="text-sm font-semibold text-fg-amber-800">{t('tasks.outline.unavailable')}</p>
      <button
        aria-busy={isRetrying ? true : undefined}
        aria-disabled={isRetrying ? true : undefined}
        className="workbench-button-secondary min-h-9 px-3 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        onClick={() => {
          if (!isRetrying) onRetry()
        }}
        type="button"
      >
        {isRetrying ? t('tasks.outline.loading') : t('tasks.outline.retry')}
      </button>
    </div>
  )
}
