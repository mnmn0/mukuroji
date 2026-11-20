import { Link } from 'react-router'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  settingsSectionIds,
  settingsSectionPaths,
  type SettingsSectionId,
} from '../model/settingsSections'

/**
 * Inputs for the settings area navigation.
 */
export type SettingsSectionNavProps = {
  /** Settings area currently shown. */
  current: SettingsSectionId
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

/**
 * Renders links to the personal, Workspace administration, and Team settings areas.
 *
 * @param props - Current area and message resolver.
 * @returns Navigation between the settings areas, with the current one marked.
 */
export function SettingsSectionNav({ current, t }: SettingsSectionNavProps) {
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
    </nav>
  )
}
