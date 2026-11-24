import { describe, expect, test } from 'bun:test'
import {
  resolveSettingsSection,
  settingsPanelAnchorId,
  settingsPanelPath,
  settingsSectionPaths,
} from '../src/workspace/model/settingsSections'

describe('resolveSettingsSection', () => {
  test('opens the area named by each settings URL', () => {
    expect(resolveSettingsSection(settingsSectionPaths.personal, '')).toBe('personal')
    expect(resolveSettingsSection(settingsSectionPaths.workspace, '')).toBe('workspace')
    expect(resolveSettingsSection(settingsSectionPaths.team, '')).toBe('team')
    expect(resolveSettingsSection('/settings/team/', '')).toBe('team')
  })

  test('opens personal settings at /settings', () => {
    expect(resolveSettingsSection('/settings', '')).toBe('personal')
    expect(resolveSettingsSection('/settings/', '?foo=1')).toBe('personal')
  })

  test('keeps the Developer Platform deep link on /settings working', () => {
    expect(
      resolveSettingsSection('/settings', '?developerSection=connectors&connectorOAuth=connected'),
    ).toBe('workspace')
    expect(
      resolveSettingsSection(settingsSectionPaths.team, '?developerSection=connectors'),
    ).toBe('team')
  })
})

describe('settingsPanelPath', () => {
  test('links a panel by its area URL and fragment', () => {
    expect(settingsPanelPath('workspace', 'members')).toBe('/settings/workspace#settings-members')
    expect(settingsPanelAnchorId('profile')).toBe('settings-profile')
  })
})
