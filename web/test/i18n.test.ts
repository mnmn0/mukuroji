import { describe, expect, test } from 'bun:test'
import { createSidebarLabels } from '../src/shared/i18n/i18n'
import { createPlanningLabels } from '../src/planning/ui/labels'

describe('sidebar shortcut labels', () => {
  test('shows the supported modifier keys independently of locale', () => {
    expect(createSidebarLabels('ja').searchShortcut).toBe('Ctrl/⌘ K')
    expect(createSidebarLabels('en').searchShortcut).toBe('Ctrl/⌘ K')
  })

  test('localizes the Planning navigation entry', () => {
    expect(createSidebarLabels('ja').nav.planning).toBe('プランニング')
    expect(createSidebarLabels('en').nav.planning).toBe('Planning')
  })

  test('localizes Planning slack and entity type labels independently', () => {
    const ja = createPlanningLabels('ja')
    const en = createPlanningLabels('en')

    expect(ja.slackDays(3)).toBe('余裕日数: 3')
    expect(en.slackDays(3)).toBe('Slack (days): 3')
    expect(ja.entityType).toBe('計画種別')
    expect(en.entityType).toBe('Plan type')
  })
})
