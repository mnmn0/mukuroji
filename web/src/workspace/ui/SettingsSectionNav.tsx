import { Link } from 'react-router'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  settingsPanelPath,
  settingsSectionIds,
  settingsSectionPaths,
  type SettingsPanelId,
  type SettingsSectionId,
} from '../model/settingsSections'

/** Link to one settings panel on the current page. */
export type SettingsPanelLink = {
  /** Panel to open. */
  panel: SettingsPanelId
  /** Settings area that holds the panel. */
  section: SettingsSectionId
}

/**
 * Inputs for the settings area navigation.
 */
export type SettingsSectionNavProps = {
  /** Settings area currently shown. */
  current: SettingsSectionId
  /** Panels on the page, linked by URL fragment so each can be opened or shared directly. */
  panels?: readonly SettingsPanelLink[]
  /** Localized message resolver. */
  t: (key: MessageKey) => string
}

const settingsSectionLabelKeys: Record<SettingsSectionId, MessageKey> = {
  personal: 'workspace.settings.section.personal',
  workspace: 'workspace.settings.section.workspace',
  team: 'workspace.settings.section.team',
}

const settingsSectionDescriptionKeys: Record<SettingsSectionId, MessageKey> = {
  personal: 'workspace.settings.section.personalDescription',
  workspace: 'workspace.settings.section.workspaceDescription',
  team: 'workspace.settings.section.teamDescription',
}

const settingsPanelLabelKeys: Record<SettingsPanelId, MessageKey> = {
  'profile': 'workspace.settings.panel.profile',
  'display': 'workspace.settings.panel.display',
  'install': 'workspace.settings.panel.install',
  'notifications': 'workspace.settings.panel.notifications',
  'account-security': 'workspace.settings.panel.account-security',
  'ai-assistance': 'workspace.settings.panel.ai-assistance',
  'agent-connection': 'workspace.settings.panel.agent-connection',
  'enterprise-security': 'workspace.settings.panel.enterprise-security',
  'members': 'workspace.settings.panel.members',
  'tenant': 'workspace.settings.panel.tenant',
  'directory': 'workspace.settings.panel.directory',
  'time-periods': 'workspace.settings.panel.time-periods',
  'developer-platform': 'workspace.settings.panel.developer-platform',
  'automation': 'workspace.settings.panel.automation',
  'audit-log': 'workspace.settings.panel.audit-log',
  'team-profile': 'workspace.settings.panel.team-profile',
  'work-item-configuration': 'workspace.settings.panel.work-item-configuration',
  'work-calendar': 'workspace.settings.panel.work-calendar',
  'work-item-key-prefix': 'workspace.settings.panel.work-item-key-prefix',
  'agent-settings': 'workspace.settings.panel.agent-settings',
}

/**
 * Renders links to the personal, Workspace administration, and Team settings areas.
 *
 * @param props - Current area and message resolver.
 * @returns Navigation between the settings areas, with the current one marked.
 */
export function SettingsSectionNav({ current, panels = [], t }: SettingsSectionNavProps) {
  return (
    <nav
      aria-label={t('workspace.settings.section.aria')}
      className="grid gap-3"
      data-testid="settings-section-nav"
    >
      <div className="flex min-w-0 flex-wrap gap-2">
        {settingsSectionIds.map((section) => {
          const selected = section === current
          return (
            <Link
              aria-current={selected ? 'page' : undefined}
              className={`inline-flex min-h-10 items-center rounded-lg border px-4 text-sm font-semibold transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 ${
                selected
                  ? 'border-[var(--workbench-primary)] bg-[var(--workbench-primary)] text-white'
                  : 'border-[var(--workbench-border-strong)] bg-surface text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)] hover:text-[var(--workbench-primary-text)]'
              }`}
              data-testid={`settings-section-${section}`}
              key={section}
              to={settingsSectionPaths[section]}
            >
              {t(settingsSectionLabelKeys[section])}
            </Link>
          )
        })}
      </div>
      <p className="text-sm font-medium leading-6 text-[var(--workbench-muted)]">
        {t(settingsSectionDescriptionKeys[current])}
      </p>
      {panels.length > 1 ? (
        <ul
          aria-label={t('workspace.settings.panel.aria')}
          className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-sm font-semibold"
          data-testid="settings-panel-links"
        >
          {panels.map((link) => (
            <li key={link.panel}>
              <Link
                className="text-[var(--workbench-primary-text)] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                data-testid={`settings-panel-link-${link.panel}`}
                to={settingsPanelPath(link.section, link.panel)}
              >
                {t(settingsPanelLabelKeys[link.panel])}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  )
}
