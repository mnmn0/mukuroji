import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { createTranslator } from '../src/shared/i18n/i18n'
import { WorkspaceSettingsView } from '../src/workspace/ui/WorkspaceSettingsView'

/**
 * Renders the personal settings view with or without the agent connection link.
 *
 * @param showAgentConnection - Whether the deployment serves Software factory.
 * @returns Static markup.
 */
function renderPersonalSettings(showAgentConnection: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <WorkspaceSettingsView
        fontSizePreference="standard"
        locale="en"
        onFontSizePreferenceChange={() => undefined}
        onThemePreferenceChange={() => undefined}
        showAgentConnection={showAgentConnection}
        t={createTranslator('en')}
        themePreference="light"
        userLabel="demo@example.com"
      />
    </MemoryRouter>,
  )
}

describe('Software factory entries in personal settings', () => {
  test('links the agent connection page only when the deployment serves Software factory', () => {
    expect(renderPersonalSettings(true)).toContain('data-testid="agent-connection-settings-link"')
    const hidden = renderPersonalSettings(false)
    expect(hidden).not.toContain('data-testid="agent-connection-settings-link"')
    expect(hidden).not.toContain('href="/settings/agent-connection"')
    expect(hidden).toContain('data-testid="theme-preference-control"')
  })
})
