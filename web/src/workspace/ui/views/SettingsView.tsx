import {
  localeOptions,
  type Locale,
  type MessageKey,
} from '../../../shared/i18n/i18n'
import { NotificationSettingsPanel } from '../../../notifications/ui/NotificationSettingsPanel'
import type { NotificationPreferencesController } from '../../../notifications/mutations/useNotifications'
import {
  fontSizePreferenceOptions,
  type FontSizePreference,
} from '../../../shared/lib/preferences/fontSize'
import { WorkspaceAccessPanelContainer } from '../WorkspaceAccessPanel'
import {
  InfoGrid,
  SectionHeader,
} from './WorkspaceViewComponents'

const fontSizePreferenceLabelKeys: Record<FontSizePreference, MessageKey> = {
  compact: 'workspace.settings.fontSize.compact',
  standard: 'workspace.settings.fontSize.standard',
  comfortable: 'workspace.settings.fontSize.comfortable',
}

/**
 * Workspace の表示・通知・アクセス設定を描画します。
 */
export function SettingsView({
  accessToken,
  fontSizePreference,
  locale,
  notificationPreferences,
  onFontSizePreferenceChange,
  onLocaleChange,
  t,
  userLabel,
}: {
  accessToken?: string
  fontSizePreference: FontSizePreference
  locale: Locale
  notificationPreferences?: NotificationPreferencesController
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  onLocaleChange?: (locale: Locale) => void
  t: (key: MessageKey) => string
  userLabel: string
}) {
  return (
    <div className="grid gap-5">
      <section className="workbench-panel overflow-hidden">
        <SectionHeader
          title={t('workspace.settings.displayTitle')}
          meta={t('workspace.settings.displayDescription')}
        />
        <div className="divide-y divide-[var(--workbench-border)] border-t border-[var(--workbench-border)]">
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
              className="inline-flex min-h-10 overflow-hidden rounded-lg border border-[var(--workbench-border-strong)] bg-white"
              data-testid="font-size-preference-control"
              role="group"
            >
              {fontSizePreferenceOptions.map((preference) => (
                <button
                  aria-pressed={fontSizePreference === preference}
                  className={`px-4 text-sm font-semibold transition-colors duration-150 ${
                    fontSizePreference === preference
                      ? 'bg-[var(--workbench-primary)] text-white'
                      : 'text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary)]'
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
              onChange={(event) => onLocaleChange?.(event.target.value === 'en' ? 'en' : 'ja')}
            >
              {localeOptions.map((option) => (
                <option key={option.locale} value={option.locale}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      {notificationPreferences ? (
        <NotificationSettingsPanel
          controller={notificationPreferences}
          key={notificationPreferences.preferences?.version ?? 'notification-settings-loading'}
          locale={locale}
        />
      ) : null}
      <InfoGrid
        items={[
          ['workspace.settings.profileTitle', 'workspace.settings.profileDescription'],
          ['workspace.settings.permissionTitle', 'workspace.settings.permissionDescription'],
          ['workspace.settings.integrationTitle', 'workspace.settings.integrationDescription'],
        ]}
        t={t}
      />

      {accessToken ? (
        <WorkspaceAccessPanelContainer accessToken={accessToken} locale={locale} />
      ) : null}

      <section className="workbench-panel p-5">
        <p className="workbench-eyebrow">{t('workspace.user.label')}</p>
        <h2 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
          {t('workspace.settings.profileTitle')}
        </h2>
        <p className="mt-3 break-all text-sm font-medium text-[var(--workbench-muted)]">
          {userLabel}
        </p>
      </section>
    </div>
  )
}
