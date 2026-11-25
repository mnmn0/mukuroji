import { useMemo } from 'react'
import { createTranslator, type Locale } from '../../shared/i18n/i18n'

/** Props for the notice shown when the OrgUnit scopes could not be loaded. */
export type OrgUnitScopesUnavailableNoticeProps = {
  /** Locale used to render the notice. */
  locale: Locale
  /** Reads the OrgUnit structure again. */
  onRetry: () => void
}

/**
 * Tells an administrator that OrgUnits are missing from the scope choices because the OrgUnit
 * structure could not be read, so it is not mistaken for a Workspace without OrgUnits.
 *
 * @param props - Locale and retry action.
 * @returns The notice.
 */
export function OrgUnitScopesUnavailableNotice({ locale, onRetry }: OrgUnitScopesUnavailableNoticeProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-fg-amber-800"
      data-testid="security-org-unit-scopes-unavailable"
      role="status"
    >
      <p>{t('security.scope.orgUnitsUnavailable')}</p>
      <button className="workbench-button-secondary min-h-8 px-3 text-sm font-semibold" type="button" onClick={onRetry}>
        {t('security.action.retryLoad')}
      </button>
    </div>
  )
}
