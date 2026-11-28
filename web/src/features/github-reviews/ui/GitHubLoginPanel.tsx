import { isGitHubLogin } from '@mukuroji/contracts'
import { useState, type FormEvent } from 'react'
import type { MessageKey } from '../../../shared/i18n/i18n'
import { SectionHeader } from '../../../shared/ui/WorkbenchPrimitives'
import type { GitHubSettingsOperationError } from '../mutations/useGitHubSettings'

/** Inputs of the personal GitHub login settings. */
export type GitHubLoginPanelProps = {
  /** Registered login, or `undefined` when none is registered or it is loading. */
  githubLogin?: string
  /** Whether the login is loading for the first time. */
  isLoading: boolean
  /** Whether the login failed to load. */
  hasLoadError: boolean
  /** Key of the running operation: `save` or `remove`. */
  busyOperation?: string
  /** Failure of the last operation. */
  operationError?: GitHubSettingsOperationError
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Saves a login; resolves whether it was saved. */
  onSave: (githubLogin: string) => Promise<boolean>
  /** Removes the registered login. */
  onRemove: () => void
  /** Loads the login again. */
  onReload: () => void
}

/** Message of each operation failure. */
const OPERATION_ERROR_KEYS = {
  'login-taken': 'githubReviews.login.taken',
  conflict: 'githubReviews.conflictError',
  'not-configured': 'githubReviews.notConfiguredError',
  failed: 'githubReviews.operationError',
} as const satisfies Record<GitHubSettingsOperationError, MessageKey>

/**
 * Renders the personal GitHub settings: the member registers the GitHub login the review inbox
 * and its notifications use.
 *
 * @param props - Login, state, and actions.
 * @returns The settings section.
 */
export function GitHubLoginPanel({
  githubLogin,
  isLoading,
  hasLoadError,
  busyOperation,
  operationError,
  t,
  onSave,
  onRemove,
  onReload,
}: GitHubLoginPanelProps) {
  const [draft, setDraft] = useState<string>()
  const [showInvalid, setShowInvalid] = useState(false)
  const value = draft ?? githubLogin ?? ''
  const busy = busyOperation !== undefined

  /**
   * Saves the entered login after checking its shape.
   *
   * @param event - Form submit event.
   */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const login = value.trim()
    if (!isGitHubLogin(login)) {
      setShowInvalid(true)
      return
    }
    setShowInvalid(false)
    void onSave(login).then((saved) => {
      if (saved) setDraft(undefined)
    })
  }

  return (
    <section className="workbench-panel overflow-hidden" data-testid="github-login-panel">
      <SectionHeader title={t('githubReviews.login.title')} />
      <p className="px-5 pb-4 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {t('githubReviews.login.description')}
      </p>
      <div className="grid gap-3 border-t border-[var(--workbench-border)] px-5 py-5">
        {hasLoadError ? (
          <div className="flex flex-wrap items-center justify-between gap-3" role="alert">
            <span className="text-sm font-semibold text-[var(--workbench-danger)]">{t('githubReviews.loadError')}</span>
            <button className="workbench-button-secondary min-h-10 px-4" onClick={onReload} type="button">
              {t('githubReviews.retry')}
            </button>
          </div>
        ) : isLoading ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('githubReviews.loading')}</p>
        ) : (
          <form className="flex flex-wrap items-end gap-3" onSubmit={submit}>
            <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
              {t('githubReviews.login.label')}
              <input
                aria-describedby={showInvalid ? 'github-login-invalid' : undefined}
                aria-invalid={showInvalid}
                autoCapitalize="none"
                autoComplete="off"
                className="workbench-input min-h-10 w-64 max-w-full px-3 font-mono"
                data-testid="github-login-input"
                maxLength={39}
                onChange={(event) => setDraft(event.currentTarget.value)}
                spellCheck={false}
                value={value}
              />
            </label>
            <button
              className="workbench-button-primary min-h-10 px-4"
              disabled={busy || value.trim() === '' || value.trim() === githubLogin}
              type="submit"
            >
              {t('githubReviews.login.save')}
            </button>
            {githubLogin ? (
              <button
                className="workbench-button-secondary min-h-10 px-4"
                disabled={busy}
                onClick={() => {
                  setDraft(undefined)
                  onRemove()
                }}
                type="button"
              >
                {t('githubReviews.login.remove')}
              </button>
            ) : null}
            {githubLogin ? (
              <span className="text-sm font-medium text-[var(--workbench-muted)]">
                {t('githubReviews.login.current')}: <span className="font-mono">{githubLogin}</span>
              </span>
            ) : null}
          </form>
        )}
        {showInvalid ? (
          <p className="text-sm font-semibold text-[var(--workbench-danger)]" id="github-login-invalid" role="alert">
            {t('githubReviews.login.invalid')}
          </p>
        ) : null}
        {operationError ? (
          <p className="text-sm font-semibold text-[var(--workbench-danger)]" role="alert">
            {t(OPERATION_ERROR_KEYS[operationError])}
          </p>
        ) : null}
      </div>
    </section>
  )
}
