import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  fontSizePreferenceOptions,
  type FontSizePreference,
} from '../../shared/lib/preferences/fontSize'
import {
  themePreferenceOptions,
  type ThemePreference,
} from '../../shared/lib/preferences/theme'
import {
  localeOptions,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import { SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import { settingsPanelAnchorId } from '../model/settingsSections'
import { SettingsPanelAnchor } from './SettingsPanelAnchor'

/**
 * Inputs for the personal settings view.
 */
export type WorkspaceSettingsViewProps = {
  /** Composed account settings (sign-in, AI access) rendered after notifications. */
  accountSections?: ReactNode
  /** Composed app installation section rendered after display preferences. */
  appInstallSection?: ReactNode
  /** Currently selected font-size preference. */
  fontSizePreference: FontSizePreference
  /** Whether display preferences failed to save to the account. */
  isPreferencesSaveFailed?: boolean
  /** Currently selected Workspace locale. */
  locale: Locale
  /** Composed notification settings rendered after display preferences. */
  notificationSettingsSection?: ReactNode
  /** Composed editable profile rendered first; without it the signed-in account is shown read-only. */
  profileSection?: ReactNode
  /** Callback that persists font-size preference changes. */
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  /** Callback that persists locale changes. */
  onLocaleChange?: (locale: Locale) => void
  /** Callback that saves display preferences again after a failed save. */
  onRetryPreferencesSave?: () => void
  /** Callback that persists color theme changes. */
  onThemePreferenceChange: (preference: ThemePreference) => void
  /** Callback that saves a time zone; undefined follows the browser. */
  onTimeZoneChange?: (timeZone: string | undefined) => void
  /** Whether to link the agent connection page; every deployment serves it. */
  showAgentConnection?: boolean
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Currently selected color theme. */
  themePreference: ThemePreference
  /** Saved IANA time zone, or undefined to follow the browser. */
  timeZone?: string
  /** Current user's display label. */
  userLabel: string
}

const fontSizePreferenceLabelKeys: Record<FontSizePreference, MessageKey> = {
  compact: 'workspace.settings.fontSize.compact',
  standard: 'workspace.settings.fontSize.standard',
  comfortable: 'workspace.settings.fontSize.comfortable',
}

/**
 * Lists the time zones the browser knows, keeping a saved one even if the list lacks it.
 *
 * @param saved - Time zone saved for the member.
 * @returns Sorted IANA time zone names.
 */
function listTimeZones(saved: string | undefined): string[] {
  const known = typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : []
  return saved && !known.includes(saved) ? [...known, saved].sort() : known
}

const themePreferenceLabelKeys: Record<ThemePreference, MessageKey> = {
  light: 'workspace.settings.theme.light',
  dark: 'workspace.settings.theme.dark',
  system: 'workspace.settings.theme.system',
}

/**
 * Renders the personal settings area: display preferences, app install, notifications,
 * account sections, the agent connection link, and the signed-in account.
 *
 * @param props - Preference data, actions, and composed section content.
 * @returns The personal settings view.
 */
export function WorkspaceSettingsView({
  accountSections,
  appInstallSection,
  fontSizePreference,
  isPreferencesSaveFailed = false,
  locale,
  notificationSettingsSection,
  profileSection,
  onFontSizePreferenceChange,
  onLocaleChange,
  onRetryPreferencesSave,
  onThemePreferenceChange,
  onTimeZoneChange,
  showAgentConnection = true,
  t,
  themePreference,
  timeZone,
  userLabel,
}: WorkspaceSettingsViewProps) {
  const timeZones = useMemo(() => listTimeZones(timeZone), [timeZone])

  return (
    <div className="grid gap-5">
      {profileSection ? (
        <SettingsPanelAnchor panel="profile">{profileSection}</SettingsPanelAnchor>
      ) : null}
      <section className="workbench-panel scroll-mt-4 overflow-hidden" id={settingsPanelAnchorId('display')}>
        <SectionHeader
          title={t('workspace.settings.displayTitle')}
          meta={t('workspace.settings.displayDescription')}
        />
        <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
          {isPreferencesSaveFailed ? (
            <div
              className="flex min-w-0 flex-wrap items-center justify-between gap-3 bg-[var(--workbench-danger-surface)] px-5 py-4 text-sm font-semibold text-[var(--workbench-danger)]"
              data-testid="preferences-save-failed"
              role="alert"
            >
              <span className="min-w-0">{t('workspace.settings.preferencesSaveFailed')}</span>
              {onRetryPreferencesSave ? (
                <button
                  className="workbench-button-secondary min-h-10 w-fit px-4"
                  onClick={onRetryPreferencesSave}
                  type="button"
                >
                  {t('workspace.settings.preferencesSaveRetry')}
                </button>
              ) : null}
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5">
            <div className="min-w-0 max-w-[640px]">
              <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.settings.fontSizeTitle')}
              </h3>
              <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('workspace.settings.fontSizeDescription')}
              </p>
            </div>
            <div
              aria-label={t('workspace.settings.fontSizeTitle')}
              className="inline-flex min-h-10 overflow-hidden rounded-lg border border-[var(--workbench-border-strong)] bg-surface"
              data-testid="font-size-preference-control"
              role="group"
            >
              {fontSizePreferenceOptions.map((preference) => (
                <button
                  aria-pressed={fontSizePreference === preference}
                  className={`px-4 text-sm font-semibold transition-colors duration-150 ${
                    fontSizePreference === preference
                      ? 'bg-[var(--workbench-primary)] text-white'
                      : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)]'
                  }`}
                  data-testid={`font-size-preference-${preference}`}
                  key={preference}
                  onClick={() => onFontSizePreferenceChange(preference)}
                  type="button"
                >
                  {t(fontSizePreferenceLabelKeys[preference])}
                </button>
              ))}
            </div>
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5">
            <div className="min-w-0 max-w-[640px]">
              <h3 className="text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.settings.themeTitle')}
              </h3>
              <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('workspace.settings.themeDescription')}
              </p>
            </div>
            <div
              aria-label={t('workspace.settings.themeTitle')}
              className="inline-flex min-h-10 overflow-hidden rounded-lg border border-[var(--workbench-border-strong)] bg-surface"
              data-testid="theme-preference-control"
              role="group"
            >
              {themePreferenceOptions.map((preference) => (
                <button
                  aria-pressed={themePreference === preference}
                  className={`px-4 text-sm font-semibold transition-colors duration-150 ${
                    themePreference === preference
                      ? 'bg-[var(--workbench-primary)] text-white'
                      : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)]'
                  }`}
                  data-testid={`theme-preference-${preference}`}
                  key={preference}
                  onClick={() => onThemePreferenceChange(preference)}
                  type="button"
                >
                  {t(themePreferenceLabelKeys[preference])}
                </button>
              ))}
            </div>
          </div>

          <label className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5">
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                {t('language.aria')}
              </strong>
              <span className="mt-1 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('workspace.settings.languageDescription')}
              </span>
            </span>
            <select
              className="workbench-input min-h-10 min-w-[168px] px-3 disabled:cursor-not-allowed disabled:bg-[var(--workbench-surface-muted)]"
              disabled={!onLocaleChange}
              value={locale}
              onChange={(event) => onLocaleChange?.(
                event.target.value === 'en' ? 'en' : 'ja',
              )}
            >
              {localeOptions.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-wrap items-center justify-between gap-4 px-5 py-5">
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-[var(--workbench-text)]">
                {t('workspace.settings.timeZoneTitle')}
              </strong>
              <span className="mt-1 block text-sm font-medium leading-6 text-[var(--workbench-muted)]">
                {t('workspace.settings.timeZoneDescription')}
              </span>
            </span>
            <select
              className="workbench-input min-h-10 min-w-[168px] max-w-full px-3 disabled:cursor-not-allowed disabled:bg-[var(--workbench-surface-muted)]"
              data-testid="time-zone-preference-control"
              disabled={!onTimeZoneChange}
              value={timeZone ?? ''}
              onChange={(event) => onTimeZoneChange?.(event.target.value || undefined)}
            >
              <option value="">{t('workspace.settings.timeZoneBrowser')}</option>
              {timeZones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {appInstallSection ? (
        <SettingsPanelAnchor panel="install">{appInstallSection}</SettingsPanelAnchor>
      ) : null}

      {notificationSettingsSection ? (
        <SettingsPanelAnchor panel="notifications">{notificationSettingsSection}</SettingsPanelAnchor>
      ) : null}

      {accountSections}

      {showAgentConnection ? (
        <Link
          className="workbench-panel group flex min-w-0 scroll-mt-4 items-center justify-between gap-5 p-5 transition hover:border-[var(--workbench-primary)] hover:shadow-sm"
          data-testid="agent-connection-settings-link"
          id={settingsPanelAnchorId('agent-connection')}
          to="/settings/agent-connection"
        >
          <span className="min-w-0">
            <span className="workbench-eyebrow">
              {t('agents.connect.eyebrow')}
            </span>
            <strong className="mt-2 block text-lg font-semibold text-[var(--workbench-text)]">
              {t('agents.connect.open')}
            </strong>
            <span className="mt-2 block max-w-[760px] text-sm font-medium leading-6 text-[var(--workbench-muted)]">
              {t('agents.connect.openDescription')}
            </span>
          </span>
          <span
            aria-hidden="true"
            className="grid h-11 w-11 flex-none place-items-center rounded-full border border-[var(--workbench-border)] bg-surface text-lg font-semibold text-[var(--workbench-primary-text)] transition-transform group-hover:translate-x-0.5"
          >
            →
          </span>
        </Link>
      ) : null}

      {profileSection ? null : (
        <section
          className="workbench-panel scroll-mt-4 p-5"
          data-testid="settings-profile"
          id={settingsPanelAnchorId('profile')}
        >
          <p className="workbench-eyebrow">{t('workspace.user.label')}</p>
          <h2 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
            {t('workspace.settings.profileTitle')}
          </h2>
          <p className="mt-1 text-sm font-medium leading-6 text-[var(--workbench-muted)]">
            {t('workspace.settings.profileDescription')}
          </p>
          <p className="mt-3 break-all text-sm font-medium text-[var(--workbench-muted)]">
            {userLabel}
          </p>
        </section>
      )}
    </div>
  )
}
