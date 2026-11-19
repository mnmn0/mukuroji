import { Link } from 'react-router'
import type { MessageKey } from '../../shared/i18n/i18n'

/** Inputs for the connector OAuth callback view. */
export type ConnectorOAuthCallbackViewProps = {
  /** Whether the connection is still being finished or could not be finished. */
  status: 'completing' | 'failed'
  /** Application path that returns the member to connector settings. */
  settingsPath: string
  /** Resolves interface copy in the active locale. */
  t: (key: MessageKey) => string
}

/**
 * Shows progress while a connector OAuth flow finishes, or why it could not finish.
 *
 * @param props - Completion status, settings destination, and copy.
 * @returns A polite status message, or an alert with a link back to connector settings.
 */
export function ConnectorOAuthCallbackView({
  status,
  settingsPath,
  t,
}: ConnectorOAuthCallbackViewProps) {
  if (status === 'failed') {
    return (
      <div className="grid max-w-xl gap-3" role="alert">
        <p className="text-base font-semibold text-[var(--workbench-text)]">
          {t('connectors.oauthCallback.failed')}
        </p>
        <p className="text-sm text-fg-slate-600">{t('connectors.oauthCallback.failedDetail')}</p>
        <Link
          className="justify-self-start text-sm font-semibold text-[var(--workbench-primary-text)] underline"
          replace
          to={settingsPath}
        >
          {t('connectors.oauthCallback.backToSettings')}
        </Link>
      </div>
    )
  }

  return (
    <p aria-live="polite" className="text-sm text-fg-slate-600" role="status">
      {t('connectors.oauthCallback.completing')}
    </p>
  )
}
