import { describe, expect, test } from 'bun:test'
import {
  resolveSettingsSection,
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
