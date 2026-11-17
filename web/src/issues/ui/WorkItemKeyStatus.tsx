import { Link } from 'react-router'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Where a key lookup stands: still resolving, not a key, no such Work Item, or failed. */
export type WorkItemKeyLookupStatus = 'loading' | 'invalid' | 'not-found' | 'failed'

/** Props for {@link WorkItemKeyStatus}. */
export type WorkItemKeyStatusProps = {
  /** The key as shown to the person: canonical when valid, otherwise as typed in the URL. */
  workItemKey: string
  /** Where the lookup stands. */
  status: WorkItemKeyLookupStatus
  /** Whether a retry is running, which disables the retry button. */
  retrying?: boolean
  /** Runs the lookup again after a failure. */
  onRetry: () => void
  /** Translator for the visible labels. */
  t: (key: MessageKey) => string
}

/** Message shown for each lookup status. */
const statusMessages = {
  loading: 'issues.keyPage.loading',
  invalid: 'issues.keyPage.invalid',
  'not-found': 'issues.keyPage.notFound',
  failed: 'issues.keyPage.error',
} as const satisfies Record<WorkItemKeyLookupStatus, MessageKey>

/**
 * Shows the progress or the outcome of opening a Work Item by its key.
 *
 * @returns The status message, with retry and search actions once the lookup has ended.
 */
export function WorkItemKeyStatus({ workItemKey, status, retrying = false, onRetry, t }: WorkItemKeyStatusProps) {
  return (
    <section
      className="mx-auto grid w-full max-w-xl gap-3 px-5 py-10"
      data-testid="work-item-key-page"
    >
      <p className="workbench-eyebrow">{t('issues.keyPage.title')}</p>
      <p
        aria-live="polite"
        className="text-base font-semibold text-[var(--workbench-text)]"
        role={status === 'loading' ? 'status' : 'alert'}
      >
        {t(statusMessages[status]).replace('{key}', workItemKey)}
      </p>
      {status === 'loading' ? null : (
        <div className="flex flex-wrap gap-2">
          {status === 'failed' ? (
            <button
              className="workbench-button-primary min-h-9 px-3"
              disabled={retrying}
              onClick={onRetry}
              type="button"
            >
              {t('issues.keyPage.retry')}
            </button>
          ) : null}
          <Link
            className="workbench-button-secondary min-h-9 w-fit px-3"
            to={`/search?${new URLSearchParams({ q: workItemKey, type: 'work-item' }).toString()}`}
          >
            {t('issues.keyPage.openSearch')}
          </Link>
        </div>
      )}
    </section>
  )
}
