import { describe, expect, test } from 'bun:test'
import { createSidebarLabels } from '../src/i18n'

describe('sidebar shortcut labels', () => {
  test('shows the supported modifier keys independently of locale', () => {
    expect(createSidebarLabels('ja').searchShortcut).toBe('Ctrl/⌘ K')
    expect(createSidebarLabels('en').searchShortcut).toBe('Ctrl/⌘ K')
  })
})
