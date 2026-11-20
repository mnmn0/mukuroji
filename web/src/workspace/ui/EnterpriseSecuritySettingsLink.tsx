import { Link } from 'react-router'
import type { MessageKey } from '../../shared/i18n/i18n'

/**
 * Inputs for the identity and security settings link.
 */
export type EnterpriseSecuritySettingsLinkProps = {
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

/**
 * Renders the card that opens the Enterprise identity and security settings.
 *
 * @param props - Message resolver.
 * @returns A link card to `/settings/security`.
 */
export function EnterpriseSecuritySettingsLink({ t }: EnterpriseSecuritySettingsLinkProps) {
  return (
    <Link
      className="workbench-panel group flex min-w-0 items-center justify-between gap-5 border-tone-99d7cf bg-tone-f3fbfa p-5 transition hover:border-[var(--workbench-primary)] hover:shadow-sm"
      data-testid="enterprise-security-settings-link"
      to="/settings/security"
    >
      <span className="min-w-0">
        <span className="workbench-eyebrow">
          {t('workspace.settings.securityEyebrow')}
        </span>
        <strong className="mt-2 block text-lg font-semibold text-[var(--workbench-text)]">
          {t('workspace.settings.securityTitle')}
        </strong>
        <span className="mt-2 block max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
          {t('workspace.settings.securityDescription')}
        </span>
      </span>
      <span
        aria-hidden="true"
        className="grid h-11 w-11 flex-none place-items-center rounded-full border border-tone-99d7cf bg-surface text-lg font-semibold text-[var(--workbench-primary-text)] transition-transform group-hover:translate-x-0.5"
      >
        →
      </span>
    </Link>
  )
}
