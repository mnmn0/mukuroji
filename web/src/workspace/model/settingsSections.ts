/**
 * Settings area shown on one settings route.
 */
export type SettingsSectionId = 'personal' | 'workspace' | 'team'

/**
 * Settings areas in tab order.
 */
export const settingsSectionIds: readonly SettingsSectionId[] = [
  'personal',
  'workspace',
  'team',
]

/**
 * URL of each settings area, so every area can be opened or shared directly.
 */
export const settingsSectionPaths: Record<SettingsSectionId, string> = {
  personal: '/settings/personal',
  workspace: '/settings/workspace',
  team: '/settings/team',
}

/**
 * Resolves the settings area for a settings URL.
 *
 * `/settings` opens the personal area, except that the Developer Platform deep link
 * (`/settings?developerSection=...`, also returned by the server after connector OAuth)
 * opens the Workspace area where that panel lives.
 *
 * @param pathname - Current URL pathname.
 * @param search - Current URL query string, with or without the leading `?`.
 * @returns The settings area to render.
 */
export function resolveSettingsSection(
  pathname: string,
  search: string,
): SettingsSectionId {
  const normalizedPathname = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  const matched = settingsSectionIds.find(
    (section) => settingsSectionPaths[section] === normalizedPathname,
  )
  if (matched) return matched
  return new URLSearchParams(search).has('developerSection') ? 'workspace' : 'personal'
}

/**
 * Settings panel that can be opened directly with a URL fragment, such as
 * `/settings/workspace#settings-members`.
 */
export type SettingsPanelId =
  | 'profile'
  | 'display'
  | 'install'
  | 'notifications'
  | 'account-security'
  | 'ai-assistance'
  | 'agent-connection'
  | 'enterprise-security'
  | 'members'
  | 'tenant'
  | 'directory'
  | 'time-periods'
  | 'developer-platform'
  | 'automation'
  | 'audit-log'
  | 'team-profile'
  | 'work-item-configuration'
  | 'work-calendar'
  | 'work-item-key-prefix'
  | 'team-automation'
  | 'agent-settings'

/**
 * Builds the element ID, and URL fragment without `#`, of a settings panel.
 *
 * @param panel - Settings panel.
 * @returns The ID, prefixed so it does not collide with other IDs on the page.
 */
export function settingsPanelAnchorId(panel: SettingsPanelId): string {
  return `settings-${panel}`
}

/**
 * Builds the URL that opens a settings panel in its area.
 *
 * @param section - Settings area that holds the panel.
 * @param panel - Settings panel.
 * @returns Path with the panel's fragment.
 */
export function settingsPanelPath(section: SettingsSectionId, panel: SettingsPanelId): string {
  return `${settingsSectionPaths[section]}#${settingsPanelAnchorId(panel)}`
}
