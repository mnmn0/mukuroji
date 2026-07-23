import { Link } from 'react-router'
import { AutomationManagementPanelContainer } from '../../automation/ui/AutomationManagementPanelContainer'
import { DeveloperPlatformSettingsPanelContainer } from '../../developer-platform/ui/DeveloperPlatformSettingsPanelContainer'
import { NotificationSettingsPanelContainer } from '../../notifications/ui/NotificationSettingsPanelContainer'
import type { ProjectDirectoryTeam } from '../../projects/api'
import {
  fontSizePreferenceOptions,
  type FontSizePreference,
} from '../../shared/lib/preferences/fontSize'
import {
  localeOptions,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import { InfoGrid, SectionHeader } from '../../shared/ui/WorkbenchPrimitives'
import { WorkItemConfigurationPanelContainer } from '../../work-items/ui/WorkItemConfigurationPanelContainer'
import { WorkspaceAccessPanelContainer } from './WorkspaceAccessPanel'

/**
 * Inputs for the Workspace settings view.
 */
export type WorkspaceSettingsViewProps = {
  /** Access token used by settings feature containers. */
  accessToken?: string
  /** Whether Workspace-level administrative settings may be changed. */
  canManageWorkspaceConfiguration: boolean
  /** Whether Team-level configuration mutations may be attempted. */
  canMutateTeamConfiguration: boolean
  /** Currently selected font-size preference. */
  fontSizePreference: FontSizePreference
  /** Currently selected Workspace locale. */
  locale: Locale
  /** Callback that persists font-size preference changes. */
  onFontSizePreferenceChange: (preference: FontSizePreference) => void
  /** Callback that persists locale changes. */
  onLocaleChange?: (locale: Locale) => void
  /** Callback that forwards feature session errors to the shared shell. */
  onSessionError?: (error?: unknown) => void
  /** Localized message resolver. */
  t: (key: MessageKey) => string
  /** Workspace Team and Project directory. */
  teams: readonly ProjectDirectoryTeam[]
  /** Current user's display label. */
  userLabel: string
}

const fontSizePreferenceLabelKeys: Record<FontSizePreference, MessageKey> = {
  compact: 'workspace.settings.fontSize.compact',
  standard: 'workspace.settings.fontSize.standard',
  comfortable: 'workspace.settings.fontSize.comfortable',
}

/**
 * Composes Workspace preferences and independently owned settings feature containers.
 *
 * @param props - Shared Workspace context and preference callbacks.
 * @returns The complete Workspace settings view.
 */
export function WorkspaceSettingsView({
  accessToken,
  canManageWorkspaceConfiguration,
  canMutateTeamConfiguration,
  fontSizePreference,
  locale,
  onFontSizePreferenceChange,
  onLocaleChange,
  onSessionError,
  t,
  teams,
  userLabel,
}: WorkspaceSettingsViewProps) {
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
        </div>
      </section>

      {accessToken ? (
        <NotificationSettingsPanelContainer
          accessToken={accessToken}
          locale={locale}
          onSessionError={onSessionError}
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

      <Link
        className="workbench-panel group flex min-w-0 items-center justify-between gap-5 border-[#99d7cf] bg-[#f3fbfa] p-5 transition hover:border-[var(--workbench-primary)] hover:shadow-sm"
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
          className="grid h-11 w-11 flex-none place-items-center rounded-full border border-[#99d7cf] bg-white text-lg font-semibold text-[var(--workbench-primary)] transition-transform group-hover:translate-x-0.5"
        >
          →
        </span>
      </Link>

      {accessToken ? (
        <WorkspaceAccessPanelContainer accessToken={accessToken} locale={locale} />
      ) : null}

      {accessToken ? (
        <DeveloperPlatformSettingsPanelContainer
          accessToken={accessToken}
          locale={locale}
          teams={teams}
        />
      ) : null}

      {accessToken ? (
        <WorkItemConfigurationPanelContainer
          accessToken={accessToken}
          canManageWorkspaceConfiguration={canManageWorkspaceConfiguration}
          canMutateTeamConfiguration={canMutateTeamConfiguration}
          locale={locale}
          teams={teams}
        />
      ) : null}

      {accessToken ? (
        <AutomationManagementPanelContainer
          accessToken={accessToken}
          canManage={canManageWorkspaceConfiguration}
          locale={locale}
          teams={[...teams]}
        />
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
